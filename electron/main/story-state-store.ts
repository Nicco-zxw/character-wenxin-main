import { DatabaseSync } from 'node:sqlite'

// ==================== Types ====================

export interface CharacterState {
  characterId: string
  chapterIndex: number
  location: string
  physicalState: string
  mentalState: string
  arcStage: string
  powerLevel: string
  knowledge: string[]
  inventory: string[]
  goals: string[]
}

export interface Foreshadowing {
  foreshadowingId: string
  type: string
  description: string
  status: 'active' | 'advanced' | 'resolved' | 'abandoned'
  plantedChapter: number
  plantedMethod: string
  payoffChapter: number | null
  resolvedChapter: number | null
  clues: Array<{ chapter: number; clue: string; method?: string }>
  connections: string[]
}

export interface Relationship {
  relationshipId: string
  participantA: string
  participantB: string
  currentStatus: string
  tensionPoints: string[]
  trajectory: string
  lastInteractionChapter: number | null
}

export interface TimelineEntry {
  chapterIndex: number
  storyDate: string
  events: string[]
  worldStateChanges: string[]
}

export interface WorldRule {
  ruleId: string
  ruleContent: string
  establishedChapter: number
  exceptions: string[]
  mustComply: boolean
}

export interface CountdownClock {
  clockId: string
  eventDescription: string
  deadlineChapter: number | null
  status: 'active' | 'expired' | 'resolved'
  urgency: string
}

export interface StateDelta {
  characters_updated: Array<{
    character_id: string
    changes: {
      location?: { from: string; to: string }
      physical_state?: string
      mental_state?: string
      arc_progression?: string
      power_level?: string
      inventory_delta?: { added: string[]; removed: string[] }
      new_knowledge?: string[]
      goals_update?: { completed: string[]; added: string[] }
    }
  }>
  relationships_delta: Array<{
    relationship_id: string
    participants?: [string, string]
    status_change?: { from: string; to: string; pivot_event: string }
    new_tension_points?: string[]
  }>
  foreshadowing_delta: {
    planted: Array<{ id: string; type: string; description: string; method: string; payoff_chapter?: number }>
    advanced: Array<{ id: string; clue: string; method: string }>
    resolved: Array<{ id: string; method: string; impact: string }>
  }
  timeline: {
    story_time_elapsed: string
    current_story_date: string
    events: string[]
    world_state_changes?: string[]
  }
}

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}

function asItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  return value != null && typeof value === 'object' ? [value] : []
}

function asString(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value).trim()
    : ''
}

function asOptionalNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(asString(value))
  return Number.isFinite(number) ? number : undefined
}

function uniqueStrings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : []
  return [...new Set(values.map(asString).filter(Boolean))]
}

function uniqueBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = keyOf(item)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 将不可信的模型输出收敛为可安全遍历、可写入 SQLite 的状态增量。 */
export function normalizeStateDelta(value: unknown): StateDelta {
  const root = asRecord(value)

  const charactersUpdated = asItems(root.characters_updated).flatMap((item) => {
    const record = asRecord(item)
    const characterId = asString(record.character_id)
    if (!characterId) return []
    const rawChanges = asRecord(record.changes)
    const changes: StateDelta['characters_updated'][number]['changes'] = {}
    const rawLocation = asRecord(rawChanges.location)
    const locationTo = asString(rawLocation.to)
    if (locationTo) {
      changes.location = { from: asString(rawLocation.from), to: locationTo }
    }

    const scalarFields = [
      ['physical_state', 'physical_state'],
      ['mental_state', 'mental_state'],
      ['arc_progression', 'arc_progression'],
      ['power_level', 'power_level']
    ] as const
    for (const [sourceKey, targetKey] of scalarFields) {
      const normalized = asString(rawChanges[sourceKey])
      if (normalized) changes[targetKey] = normalized
    }

    const rawInventory = asRecord(rawChanges.inventory_delta)
    const inventoryAdded = uniqueStrings(rawInventory.added)
    const inventoryRemoved = uniqueStrings(rawInventory.removed)
    if (inventoryAdded.length || inventoryRemoved.length) {
      changes.inventory_delta = { added: inventoryAdded, removed: inventoryRemoved }
    }

    const newKnowledge = uniqueStrings(rawChanges.new_knowledge)
    if (newKnowledge.length) changes.new_knowledge = newKnowledge

    const rawGoals = asRecord(rawChanges.goals_update)
    const goalsCompleted = uniqueStrings(rawGoals.completed)
    const goalsAdded = uniqueStrings(rawGoals.added)
    if (goalsCompleted.length || goalsAdded.length) {
      changes.goals_update = { completed: goalsCompleted, added: goalsAdded }
    }

    return Object.keys(changes).length ? [{ character_id: characterId, changes }] : []
  })

  const relationshipsDelta = asItems(root.relationships_delta).flatMap((item) => {
    const record = asRecord(item)
    const relationshipId = asString(record.relationship_id)
    if (!relationshipId) return []
    const rawParticipants = Array.isArray(record.participants) ? record.participants.map(asString).filter(Boolean) : []
    const rawStatus = asRecord(record.status_change)
    const statusTo = asString(rawStatus.to)
    const normalized = {
      relationship_id: relationshipId,
      participants: rawParticipants.length >= 2
        ? [rawParticipants[0], rawParticipants[1]] as [string, string]
        : undefined,
      status_change: statusTo
        ? { from: asString(rawStatus.from), to: statusTo, pivot_event: asString(rawStatus.pivot_event) }
        : undefined,
      new_tension_points: uniqueStrings(record.new_tension_points)
    }
    return normalized.participants || normalized.status_change || normalized.new_tension_points.length
      ? [normalized]
      : []
  })

  const rawForeshadowing = asRecord(root.foreshadowing_delta)
  const planted = asItems(rawForeshadowing.planted).flatMap((item) => {
    const record = asRecord(item)
    const id = asString(record.id)
    if (!id) return []
    const description = asString(record.description)
    if (!description) return []
    return [{
      id,
      type: asString(record.type) || '暗线',
      description,
      method: asString(record.method),
      payoff_chapter: asOptionalNumber(record.payoff_chapter)
    }]
  })
  const advanced = asItems(rawForeshadowing.advanced).flatMap((item) => {
    const record = asRecord(item)
    const id = asString(record.id)
    return id ? [{ id, clue: asString(record.clue), method: asString(record.method) }] : []
  })
  const resolved = asItems(rawForeshadowing.resolved).flatMap((item) => {
    const record = asRecord(item)
    const id = asString(record.id)
    return id ? [{ id, method: asString(record.method), impact: asString(record.impact) }] : []
  })

  const rawTimeline = asRecord(root.timeline)
  return {
    characters_updated: uniqueBy(charactersUpdated, (item) => item.character_id),
    relationships_delta: uniqueBy(relationshipsDelta, (item) => item.relationship_id),
    foreshadowing_delta: {
      planted: uniqueBy(planted, (item) => item.id),
      advanced: uniqueBy(advanced, (item) => `${item.id}\u0000${item.clue}\u0000${item.method}`),
      resolved: uniqueBy(resolved, (item) => item.id)
    },
    timeline: {
      story_time_elapsed: asString(rawTimeline.story_time_elapsed),
      current_story_date: asString(rawTimeline.current_story_date),
      events: uniqueStrings(rawTimeline.events),
      world_state_changes: uniqueStrings(rawTimeline.world_state_changes)
    }
  }
}

export function hasStateDeltaContent(delta: StateDelta): boolean {
  return delta.characters_updated.length > 0
    || delta.relationships_delta.length > 0
    || delta.foreshadowing_delta.planted.length > 0
    || delta.foreshadowing_delta.advanced.length > 0
    || delta.foreshadowing_delta.resolved.length > 0
    || delta.timeline.events.length > 0
    || Boolean(delta.timeline.world_state_changes?.length)
    || Boolean(delta.timeline.current_story_date)
    || Boolean(delta.timeline.story_time_elapsed)
}

/** 章摘要账一条（chapter_summaries 行；机器速览：一章动了谁/发生了什么/状态怎么变/伏笔动静）。 */
export interface ChapterSummary {
  projectId: string
  chapterIndex: number
  title: string
  characters: string[]
  events: string[]
  stateChanges: string[]
  hookActivity: { planted: number; advanced: number; resolved: number }
  sourceEventId: string | null
  updatedAt: string
}

export interface ForeshadowingHealthReport {
  totalActive: number
  overdue: Array<{ id: string; plantedChapter: number; expectedPayoff: number }>
  densityWarning: boolean
  currentChapter: number
}

export interface StoryStateContext {
  characterStates: CharacterState[]
  activeForeshadowing: Foreshadowing[]
  relationships: Relationship[]
  recentTimeline: TimelineEntry[]
  worldRules: WorldRule[]
  activeClocks: CountdownClock[]
}

export interface ProjectLedgerState {
  projectId: string
  ledgerVersion: number
  settledThroughChapter: number
  projectionsDirty: boolean
  updatedAt: string
}

// ==================== Schema ====================

const STORY_STATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS story_character_state (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    character_id TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    physical_state TEXT NOT NULL DEFAULT '正常',
    mental_state TEXT NOT NULL DEFAULT '',
    arc_stage TEXT NOT NULL DEFAULT '',
    power_level TEXT NOT NULL DEFAULT '',
    knowledge_json TEXT NOT NULL DEFAULT '[]',
    inventory_json TEXT NOT NULL DEFAULT '[]',
    goals_json TEXT NOT NULL DEFAULT '[]',
    valid_from_chapter INTEGER NOT NULL DEFAULT 0,
    valid_until_chapter INTEGER,
    source_event_id TEXT,
    actor TEXT NOT NULL DEFAULT 'observer',
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS story_foreshadowing (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    foreshadowing_id TEXT NOT NULL,
    type TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    planted_chapter INTEGER NOT NULL,
    planted_method TEXT NOT NULL DEFAULT '',
    payoff_chapter INTEGER,
    resolved_chapter INTEGER,
    clues_json TEXT NOT NULL DEFAULT '[]',
    connections_json TEXT NOT NULL DEFAULT '[]',
    source_event_id TEXT,
    actor TEXT NOT NULL DEFAULT 'observer',
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_foreshadowing_project_fid
    ON story_foreshadowing(project_id, foreshadowing_id);

  CREATE TABLE IF NOT EXISTS story_relationships (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    relationship_id TEXT NOT NULL,
    participant_a TEXT NOT NULL,
    participant_b TEXT NOT NULL,
    current_status TEXT NOT NULL,
    tension_points_json TEXT NOT NULL DEFAULT '[]',
    trajectory TEXT NOT NULL DEFAULT '',
    last_interaction_chapter INTEGER,
    valid_from_chapter INTEGER NOT NULL DEFAULT 0,
    valid_until_chapter INTEGER,
    source_event_id TEXT,
    actor TEXT NOT NULL DEFAULT 'observer',
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS story_timeline (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    story_date TEXT NOT NULL DEFAULT '',
    events_json TEXT NOT NULL DEFAULT '[]',
    world_state_changes_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_unique
    ON story_timeline(project_id, chapter_index);

  CREATE TABLE IF NOT EXISTS story_world_rules (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    rule_content TEXT NOT NULL,
    established_chapter INTEGER NOT NULL,
    exceptions_json TEXT NOT NULL DEFAULT '[]',
    must_comply INTEGER NOT NULL DEFAULT 1,
    source_event_id TEXT,
    actor TEXT NOT NULL DEFAULT 'observer',
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_world_rules_project_rid
    ON story_world_rules(project_id, rule_id);

  CREATE TABLE IF NOT EXISTS story_countdown_clocks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    clock_id TEXT NOT NULL,
    event_description TEXT NOT NULL,
    deadline_chapter INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    urgency TEXT NOT NULL DEFAULT 'medium',
    source_event_id TEXT,
    actor TEXT NOT NULL DEFAULT 'observer',
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS story_embeddings (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    chapter_index INTEGER,
    text_content TEXT NOT NULL,
    embedding BLOB NOT NULL,
    content_hash TEXT,
    valid_until_chapter INTEGER,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_embeddings_project
    ON story_embeddings(project_id, source_type);

  CREATE TABLE IF NOT EXISTS embedding_metadata (
    key TEXT PRIMARY KEY,
    dimension INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS ledger_manifest (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS story_project_ledgers (
    project_id TEXT PRIMARY KEY,
    ledger_version INTEGER NOT NULL DEFAULT 0,
    settled_through_chapter INTEGER NOT NULL DEFAULT -1,
    projections_dirty INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS chapter_summaries (
    project_id TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    characters_json TEXT NOT NULL DEFAULT '[]',
    events_json TEXT NOT NULL DEFAULT '[]',
    state_changes_json TEXT NOT NULL DEFAULT '[]',
    hook_activity_json TEXT NOT NULL DEFAULT '{}',
    source_event_id TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, chapter_index)
  ) STRICT;
`

// ==================== Ledger Manifest ====================

/** 真相账本结构版本（ledger_manifest.schema_version）。升版需随迁移 writeLedgerValue 留痕。 */
export const TRUTH_LEDGER_SCHEMA_VERSION = '3'

/**
 * P7.1/B1 状态行 closure 语义总开关（默认开）。
 * true  = 角色/关系状态行「关门 + 插新行」（valid_from/valid_until），可回答任意章点状态；
 * false = 旧语义：角色每章 REPLACE、关系单行 UPDATE，latest = MAX(chapter_index/last_interaction)。
 * initStoryStateSchema 会按此开关重建对应唯一索引；置 false 并重启即整体回退。
 */
export let STORY_STATE_CLOSURE_ENABLED = true

/** 切换 closure 语义（ESM 命名导入只读，故提供 setter 供测试/运维调用；配 initStoryStateSchema 重建索引后生效）。 */
export function setStoryStateClosureEnabled(enabled: boolean): void {
  STORY_STATE_CLOSURE_ENABLED = enabled
}

// ==================== Helpers ====================

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function now(): string {
  return new Date().toISOString()
}

/** 列出某表现有列名集合（用于幂等迁移检查）。 */
function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map((r) => String(r.name)))
}

/** 兼容迁移：旧库缺列则 ALTER TABLE ADD COLUMN（幂等）。 */
function ensureColumn(db: DatabaseSync, table: string, column: string, addSql: string): void {
  if (!tableColumns(db, table).has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${addSql}`)
  }
}

// ==================== Store ====================

export function initStoryStateSchema(db: DatabaseSync): void {
  db.exec(STORY_STATE_SCHEMA)

  // ── 兼容迁移：为旧库幂等补 P7.0/P7.1 新列 ──
  ensureColumn(db, 'story_character_state', 'valid_from_chapter', 'valid_from_chapter INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'story_character_state', 'valid_until_chapter', 'valid_until_chapter INTEGER')
  ensureColumn(db, 'story_character_state', 'source_event_id', 'source_event_id TEXT')
  ensureColumn(db, 'story_character_state', 'actor', "actor TEXT NOT NULL DEFAULT 'observer'")
  // B1：关系生效区间列
  ensureColumn(db, 'story_relationships', 'valid_from_chapter', 'valid_from_chapter INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'story_relationships', 'valid_until_chapter', 'valid_until_chapter INTEGER')
  for (const table of ['story_foreshadowing', 'story_relationships', 'story_world_rules', 'story_countdown_clocks']) {
    ensureColumn(db, table, 'source_event_id', 'source_event_id TEXT')
    ensureColumn(db, table, 'actor', "actor TEXT NOT NULL DEFAULT 'observer'")
  }
  // P7.5：向量索引版本/生效列（content_hash=所索引文本版本；valid_until 预留 closure 生效区间，NULL=当前）
  ensureColumn(db, 'story_embeddings', 'content_hash', 'content_hash TEXT')
  ensureColumn(db, 'story_embeddings', 'valid_until_chapter', 'valid_until_chapter INTEGER')

  if (STORY_STATE_CLOSURE_ENABLED) {
    // ── 存量规范化（幂等；必须在建「当前行部分唯一」索引之前）──
    // 1) valid_from 回填 = 真实来源章
    db.exec('UPDATE story_character_state SET valid_from_chapter = chapter_index WHERE valid_from_chapter = 0')
    // 2) 旧 REPLACE 语义下同一角色跨章保留多行、加列后全为 until=NULL；
    //    把「非最大章」行关门到下一章-1 → 每角色仅最大章一行保持 NULL（当前态），
    //    历史任意章点可查；若曾出现双 NULL（异常/半迁移）此步亦自愈。
    db.exec(`
      UPDATE story_character_state
      SET valid_until_chapter = (
        SELECT MIN(s2.chapter_index) - 1 FROM story_character_state s2
        WHERE s2.project_id = story_character_state.project_id
          AND s2.character_id = story_character_state.character_id
          AND s2.chapter_index > story_character_state.chapter_index
      )
      WHERE valid_until_chapter IS NULL
        AND EXISTS (
          SELECT 1 FROM story_character_state s3
          WHERE s3.project_id = story_character_state.project_id
            AND s3.character_id = story_character_state.character_id
            AND s3.chapter_index > story_character_state.chapter_index
        )
    `)
    // B1：关系存量规范化——旧语义单行 → valid_from=最近互动章；异常多行按 last_interaction 关门到下一-1
    db.exec('UPDATE story_relationships SET valid_from_chapter = COALESCE(last_interaction_chapter, 0) WHERE valid_from_chapter = 0')
    db.exec(`
      UPDATE story_relationships
      SET valid_until_chapter = (
        SELECT MIN(s2.last_interaction_chapter) - 1 FROM story_relationships s2
        WHERE s2.project_id = story_relationships.project_id
          AND s2.relationship_id = story_relationships.relationship_id
          AND s2.last_interaction_chapter > story_relationships.last_interaction_chapter
      )
      WHERE valid_until_chapter IS NULL
        AND last_interaction_chapter IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM story_relationships s3
          WHERE s3.project_id = story_relationships.project_id
            AND s3.relationship_id = story_relationships.relationship_id
            AND s3.last_interaction_chapter > story_relationships.last_interaction_chapter
        )
    `)
  } else {
    // 非 closure：仍回填 valid_from（供查询展示），无部分唯一约束
    db.exec('UPDATE story_character_state SET valid_from_chapter = chapter_index WHERE valid_from_chapter = 0')
  }

  // ── 唯一索引按 closure 开关重建（可回退）──
  db.exec('DROP INDEX IF EXISTS idx_char_state_unique')
  db.exec('DROP INDEX IF EXISTS idx_char_state_current')
  if (STORY_STATE_CLOSURE_ENABLED) {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_char_state_current
      ON story_character_state(project_id, character_id) WHERE valid_until_chapter IS NULL`)
  } else {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_char_state_unique
      ON story_character_state(project_id, character_id, chapter_index)`)
  }

  // ── B1：关系唯一索引按 closure 开关重建（可回退）──
  db.exec('DROP INDEX IF EXISTS idx_relationships_project_rid')
  db.exec('DROP INDEX IF EXISTS idx_relationships_current')
  if (STORY_STATE_CLOSURE_ENABLED) {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_relationships_current
      ON story_relationships(project_id, relationship_id) WHERE valid_until_chapter IS NULL`)
  } else {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_relationships_project_rid
      ON story_relationships(project_id, relationship_id)`)
  }

  // ── 账本自身账：写/升结构版本（只升不降，留痕）──
  const existing = readLedgerValue(db, 'schema_version')
  const current = existing == null ? 0 : Number(existing) || 0
  if (current < Number(TRUTH_LEDGER_SCHEMA_VERSION)) {
    writeLedgerValue(db, 'schema_version', TRUTH_LEDGER_SCHEMA_VERSION)
    writeLedgerValue(db, 'migration', `schema ${existing ?? 'none'} -> ${TRUTH_LEDGER_SCHEMA_VERSION} (P7.1 character + B1 relationship closure)`)
  }
}

/** 读取账本自身账条目（不存在返回 null）。 */
export function readLedgerValue(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM ledger_manifest WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row ? String(row.value) : null
}

/** 写入/更新账本自身账条目（upsert，记录 updated_at；迁移升版时用于留痕）。 */
export function writeLedgerValue(db: DatabaseSync, key: string, value: string): void {
  db.prepare(`
    INSERT INTO ledger_manifest (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, now())
}

/** 读取单个项目的内容账本版本；尚未结算的项目返回稳定的初始态。 */
export function readProjectLedger(db: DatabaseSync, projectId: string): ProjectLedgerState {
  const row = db.prepare(`
    SELECT project_id, ledger_version, settled_through_chapter, projections_dirty, updated_at
    FROM story_project_ledgers
    WHERE project_id = ?
  `).get(projectId) as Record<string, unknown> | undefined

  if (!row) {
    return {
      projectId,
      ledgerVersion: 0,
      settledThroughChapter: -1,
      projectionsDirty: true,
      updatedAt: ''
    }
  }

  return {
    projectId: String(row.project_id),
    ledgerVersion: Number(row.ledger_version),
    settledThroughChapter: Number(row.settled_through_chapter),
    projectionsDirty: Number(row.projections_dirty) === 1,
    updatedAt: String(row.updated_at)
  }
}

/** 在调用方事务内推进项目账本版本，并标记所有可再生投影为脏。 */
export function bumpProjectLedger(
  db: DatabaseSync,
  projectId: string,
  input: { settledThroughChapter: number }
): number {
  const timestamp = now()
  db.prepare(`
    INSERT INTO story_project_ledgers
      (project_id, ledger_version, settled_through_chapter, projections_dirty, updated_at)
    VALUES (?, 1, ?, 1, ?)
    ON CONFLICT(project_id) DO UPDATE SET
      ledger_version = ledger_version + 1,
      settled_through_chapter = excluded.settled_through_chapter,
      projections_dirty = 1,
      updated_at = excluded.updated_at
  `).run(projectId, input.settledThroughChapter, timestamp)
  return readProjectLedger(db, projectId).ledgerVersion
}

/** 行 → CharacterState（读路径统一映射）。 */
function toCharacterState(row: Record<string, unknown>): CharacterState {
  return {
    characterId: String(row.character_id),
    chapterIndex: Number(row.chapter_index),
    location: String(row.location ?? ''),
    physicalState: String(row.physical_state ?? '正常'),
    mentalState: String(row.mental_state ?? ''),
    arcStage: String(row.arc_stage ?? ''),
    powerLevel: String(row.power_level ?? ''),
    knowledge: parseJson<string[]>(row.knowledge_json, []),
    inventory: parseJson<string[]>(row.inventory_json, []),
    goals: parseJson<string[]>(row.goals_json, [])
  }
}

/**
 * 读「当前生效」角色状态行（closure：valid_until IS NULL；回退：MAX(chapter_index)）。
 * 缺失（无当前行，理论仅迁移遗漏）时以最大 valid_from 兜底。
 */
function readLatestCharacterRows(
  db: DatabaseSync,
  projectId: string,
  characterIds: string[]
): Array<Record<string, unknown>> {
  const placeholders = characterIds.map(() => '?').join(',')

  if (!STORY_STATE_CLOSURE_ENABLED) {
    return db.prepare(`
      SELECT cs.* FROM story_character_state cs
      INNER JOIN (
        SELECT character_id, MAX(chapter_index) as max_ch
        FROM story_character_state
        WHERE project_id = ? AND character_id IN (${placeholders})
        GROUP BY character_id
      ) latest ON cs.character_id = latest.character_id AND cs.chapter_index = latest.max_ch
      WHERE cs.project_id = ?
    `).all(projectId, ...characterIds, projectId) as Array<Record<string, unknown>>
  }

  const rows = db.prepare(`
    SELECT * FROM story_character_state
    WHERE project_id = ? AND character_id IN (${placeholders}) AND valid_until_chapter IS NULL
  `).all(projectId, ...characterIds) as Array<Record<string, unknown>>

  // 兜底：缺失字符（无当前生效行）按最大 valid_from 取最近一行
  const found = new Set(rows.map((r) => String(r.character_id)))
  const missing = characterIds.filter((id) => !found.has(id))
  if (missing.length) {
    const mp = missing.map(() => '?').join(',')
    const fallback = db.prepare(`
      SELECT cs.* FROM story_character_state cs
      INNER JOIN (
        SELECT character_id, MAX(valid_from_chapter) as vf
        FROM story_character_state
        WHERE project_id = ? AND character_id IN (${mp})
        GROUP BY character_id
      ) latest ON cs.character_id = latest.character_id AND cs.valid_from_chapter = latest.vf
      WHERE cs.project_id = ?
    `).all(projectId, ...missing, projectId) as Array<Record<string, unknown>>
    rows.push(...fallback)
  }
  return rows
}

export function getLatestCharacterStates(
  db: DatabaseSync,
  projectId: string,
  characterIds: string[]
): CharacterState[] {
  if (!characterIds.length) return []
  const rows = readLatestCharacterRows(db, projectId, characterIds)
  return rows.map((row) => toCharacterState(row))
}

export function getAllCharacterIds(db: DatabaseSync, projectId: string): string[] {
  const stmt = db.prepare(
    `SELECT DISTINCT character_id FROM story_character_state WHERE project_id = ?`
  )
  const rows = stmt.all(projectId) as Array<Record<string, unknown>>
  return rows.map((row) => String(row.character_id))
}

export function getActiveForeshadowing(
  db: DatabaseSync,
  projectId: string,
  limit = 30
): Foreshadowing[] {
  const stmt = db.prepare(`
    SELECT * FROM story_foreshadowing
    WHERE project_id = ? AND status IN ('active', 'advanced')
    ORDER BY planted_chapter ASC
    LIMIT ?
  `)
  const rows = stmt.all(projectId, limit) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    foreshadowingId: String(row.foreshadowing_id),
    type: String(row.type),
    description: String(row.description),
    status: String(row.status) as Foreshadowing['status'],
    plantedChapter: Number(row.planted_chapter),
    plantedMethod: String(row.planted_method ?? ''),
    payoffChapter: row.payoff_chapter != null ? Number(row.payoff_chapter) : null,
    resolvedChapter: row.resolved_chapter != null ? Number(row.resolved_chapter) : null,
    clues: parseJson<Foreshadowing['clues']>(row.clues_json, []),
    connections: parseJson<string[]>(row.connections_json, [])
  }))
}

function toRelationship(row: Record<string, unknown>): Relationship {
  return {
    relationshipId: String(row.relationship_id),
    participantA: String(row.participant_a),
    participantB: String(row.participant_b),
    currentStatus: String(row.current_status),
    tensionPoints: parseJson<string[]>(row.tension_points_json, []),
    trajectory: String(row.trajectory ?? ''),
    lastInteractionChapter: row.last_interaction_chapter != null ? Number(row.last_interaction_chapter) : null
  }
}

function relationshipParticipantSql(characterIds: string[]): { clause: string; params: string[] } {
  const placeholders = characterIds.map(() => '?').join(',')
  return {
    clause: ` AND (participant_a IN (${placeholders}) OR participant_b IN (${placeholders}))`,
    params: [...characterIds, ...characterIds]
  }
}

/** 当前生效关系（B1 closure：valid_until IS NULL；回退：单行全部）。 */
export function getRelationships(
  db: DatabaseSync,
  projectId: string,
  characterIds?: string[]
): Relationship[] {
  const filter = characterIds?.length ? relationshipParticipantSql(characterIds) : null
  const rows = (STORY_STATE_CLOSURE_ENABLED
    ? db.prepare(`
        SELECT * FROM story_relationships
        WHERE project_id = ?${filter ? filter.clause : ''} AND valid_until_chapter IS NULL
      `).all(projectId, ...(filter ? filter.params : []))
    : db.prepare(`SELECT * FROM story_relationships WHERE project_id = ?${filter ? filter.clause : ''}`)
        .all(projectId, ...(filter ? filter.params : []))) as Array<Record<string, unknown>>
  return rows.map(toRelationship)
}

/** 任意章点的生效关系（B1：valid_from<=ch AND (until NULL OR until>=ch)）；回退时返回当前全部。 */
export function getRelationshipsAtChapter(
  db: DatabaseSync,
  projectId: string,
  chapterIndex: number,
  characterIds?: string[]
): Relationship[] {
  if (!STORY_STATE_CLOSURE_ENABLED) return getRelationships(db, projectId, characterIds)
  const filter = characterIds?.length ? relationshipParticipantSql(characterIds) : null
  const rows = db.prepare(`
    SELECT * FROM story_relationships
    WHERE project_id = ?
      AND valid_from_chapter <= ?
      AND (valid_until_chapter IS NULL OR valid_until_chapter >= ?)
      ${filter ? filter.clause : ''}
  `).all(projectId, chapterIndex, chapterIndex, ...(filter ? filter.params : [])) as Array<Record<string, unknown>>
  return rows.map(toRelationship)
}

export function getRecentTimeline(
  db: DatabaseSync,
  projectId: string,
  lastN = 5
): TimelineEntry[] {
  const stmt = db.prepare(`
    SELECT * FROM story_timeline
    WHERE project_id = ?
    ORDER BY chapter_index DESC
    LIMIT ?
  `)
  const rows = stmt.all(projectId, lastN) as Array<Record<string, unknown>>
  return rows.reverse().map((row) => ({
    chapterIndex: Number(row.chapter_index),
    storyDate: String(row.story_date ?? ''),
    events: parseJson<string[]>(row.events_json, []),
    worldStateChanges: parseJson<string[]>(row.world_state_changes_json, [])
  }))
}

export function getWorldRules(db: DatabaseSync, projectId: string): WorldRule[] {
  const stmt = db.prepare(`SELECT * FROM story_world_rules WHERE project_id = ? ORDER BY established_chapter ASC`)
  const rows = stmt.all(projectId) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    ruleId: String(row.rule_id),
    ruleContent: String(row.rule_content),
    establishedChapter: Number(row.established_chapter),
    exceptions: parseJson<string[]>(row.exceptions_json, []),
    mustComply: Boolean(row.must_comply)
  }))
}

export function getActiveClocks(db: DatabaseSync, projectId: string): CountdownClock[] {
  const stmt = db.prepare(`SELECT * FROM story_countdown_clocks WHERE project_id = ? AND status = 'active'`)
  const rows = stmt.all(projectId) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    clockId: String(row.clock_id),
    eventDescription: String(row.event_description),
    deadlineChapter: row.deadline_chapter != null ? Number(row.deadline_chapter) : null,
    status: String(row.status) as CountdownClock['status'],
    urgency: String(row.urgency ?? 'medium')
  }))
}

export function getForeshadowingHealth(
  db: DatabaseSync,
  projectId: string,
  currentChapter: number
): ForeshadowingHealthReport {
  const active = getActiveForeshadowing(db, projectId, 999)
  const overdue = active
    .filter((f) => f.payoffChapter != null && f.payoffChapter < currentChapter)
    .map((f) => ({
      id: f.foreshadowingId,
      plantedChapter: f.plantedChapter,
      expectedPayoff: f.payoffChapter!
    }))

  return {
    totalActive: active.length,
    overdue,
    densityWarning: active.length > currentChapter / 5,
    currentChapter
  }
}

// ==================== Write Operations ====================

export function applyStateDelta(
  db: DatabaseSync,
  projectId: string,
  chapterIndex: number,
  delta: StateDelta,
  opts?: { sourceEventId?: string | null; actor?: string }
): void {
  const normalizedDelta = normalizeStateDelta(delta)
  const srcId = opts?.sourceEventId ?? null
  const srcActor = opts?.actor ?? 'observer'
  db.exec('BEGIN')
  try {
  const timestamp = now()

  // Character state updates
  for (const charUpdate of normalizedDelta.characters_updated) {
    const existing = getLatestCharacterStates(db, projectId, [charUpdate.character_id])
    const prev = existing[0]

    const id = uid()
    const location = charUpdate.changes.location?.to ?? prev?.location ?? ''
    const physicalState = charUpdate.changes.physical_state ?? prev?.physicalState ?? '正常'
    const mentalState = charUpdate.changes.mental_state ?? prev?.mentalState ?? ''
    const arcStage = charUpdate.changes.arc_progression ?? prev?.arcStage ?? ''
    const powerLevel = charUpdate.changes.power_level ?? prev?.powerLevel ?? ''

    let inventory = prev?.inventory ?? []
    if (charUpdate.changes.inventory_delta) {
      const { added = [], removed = [] } = charUpdate.changes.inventory_delta
      inventory = inventory.filter((item) => !removed.includes(item))
      inventory = [...new Set([...inventory, ...added])]
    }
    const inventoryJson = JSON.stringify(inventory)

    let knowledge = prev?.knowledge ?? []
    if (charUpdate.changes.new_knowledge?.length) {
      knowledge = [...new Set([...knowledge, ...charUpdate.changes.new_knowledge])]
    }
    const knowledgeJson = JSON.stringify(knowledge)

    let goals = prev?.goals ?? []
    if (charUpdate.changes.goals_update) {
      const { completed = [], added = [] } = charUpdate.changes.goals_update
      goals = goals.filter((g) => !completed.includes(g))
      goals = [...new Set([...goals, ...added])]
    }
    const goalsJson = JSON.stringify(goals)

    const bodyColumns = [location, physicalState, mentalState, arcStage, powerLevel, knowledgeJson, inventoryJson, goalsJson] as const

    if (STORY_STATE_CLOSURE_ENABLED) {
      // 当前生效行（valid_until IS NULL；无则取最大 valid_from 兼容迁移遗漏）
      const cur = db.prepare(`
        SELECT id, valid_from_chapter FROM story_character_state
        WHERE project_id = ? AND character_id = ?
        ORDER BY (valid_until_chapter IS NULL) DESC, valid_from_chapter DESC LIMIT 1
      `).get(projectId, charUpdate.character_id) as { id: string; valid_from_chapter: number } | undefined

      if (cur && Number(cur.valid_from_chapter) === chapterIndex) {
        // 同章重结算：覆盖该行（valid_from/until 不变，仍为本章生效行；记录本次来源）
        db.prepare(`
          UPDATE story_character_state SET
            location = ?, physical_state = ?, mental_state = ?, arc_stage = ?, power_level = ?,
            knowledge_json = ?, inventory_json = ?, goals_json = ?,
            source_event_id = ?, actor = ?, updated_at = ?
          WHERE id = ?
        `).run(...bodyColumns, srcId, srcActor, timestamp, cur.id)
      } else {
        if (cur) {
          // 跨章：先关门旧当前行（valid_until = 本章 - 1）
          db.prepare('UPDATE story_character_state SET valid_until_chapter = ? WHERE id = ?')
            .run(chapterIndex - 1, cur.id)
        }
        // 插本章新当前行（valid_from = 本章，until = NULL）
        db.prepare(`
          INSERT INTO story_character_state
            (id, project_id, character_id, chapter_index, location, physical_state, mental_state,
             arc_stage, power_level, knowledge_json, inventory_json, goals_json,
             valid_from_chapter, valid_until_chapter, source_event_id, actor, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, projectId, charUpdate.character_id, chapterIndex,
          ...bodyColumns,
          chapterIndex, null, srcId, srcActor, timestamp
        )
      }
    } else {
      // 旧语义：按章 REPLACE（回退路径；init 已按此重建 idx_char_state_unique；记录来源）
      db.prepare(`
        INSERT OR REPLACE INTO story_character_state
          (id, project_id, character_id, chapter_index, location, physical_state, mental_state,
           arc_stage, power_level, knowledge_json, inventory_json, goals_json,
           valid_from_chapter, valid_until_chapter, source_event_id, actor, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, projectId, charUpdate.character_id, chapterIndex,
        ...bodyColumns,
        chapterIndex, null, srcId, srcActor, timestamp
      )
    }
  }

  // Relationship updates（B1：closure = 生效区间行，可回答任意章点关系状态；回退 = 单行 UPDATE/INSERT）
  for (const relUpdate of normalizedDelta.relationships_delta) {
    const relId = relUpdate.relationship_id
    if (!relId) continue
    const participants = relUpdate.participants as [string, string] | undefined

    if (!STORY_STATE_CLOSURE_ENABLED) {
      // 旧语义：单行累积（保持既有行为）
      const existingRow = db.prepare(
        'SELECT * FROM story_relationships WHERE project_id = ? AND relationship_id = ?'
      ).get(projectId, relId) as Record<string, unknown> | undefined
      if (existingRow) {
        const updates: string[] = []
        const params: (string | number | null)[] = []
        if (relUpdate.status_change) {
          updates.push('current_status = ?')
          params.push(relUpdate.status_change.to)
        }
        if (participants && participants.length >= 2) {
          updates.push('participant_a = ?', 'participant_b = ?')
          params.push(participants[0], participants[1])
        }
        if (relUpdate.new_tension_points?.length) {
          const existing = parseJson<string[]>(existingRow.tension_points_json, [])
          updates.push('tension_points_json = ?')
          params.push(JSON.stringify([...new Set([...existing, ...relUpdate.new_tension_points])]))
        }
        updates.push('last_interaction_chapter = ?', 'source_event_id = ?', 'actor = ?', 'updated_at = ?')
        params.push(chapterIndex, srcId, srcActor, timestamp)
        params.push(projectId, relId)
        db.prepare(
          `UPDATE story_relationships SET ${updates.join(', ')} WHERE project_id = ? AND relationship_id = ?`
        ).run(...params)
      } else if (participants && participants.length >= 2) {
        db.prepare(`
          INSERT OR IGNORE INTO story_relationships
            (id, project_id, relationship_id, participant_a, participant_b, current_status,
             tension_points_json, trajectory, last_interaction_chapter,
             valid_from_chapter, valid_until_chapter, source_event_id, actor, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          uid(), projectId, relId,
          participants[0], participants[1],
          relUpdate.status_change?.to ?? '初识',
          JSON.stringify(relUpdate.new_tension_points ?? []),
          '', chapterIndex, 0, null, srcId, srcActor, timestamp
        )
      }
      continue
    }

    // closure 语义
    const cur = db.prepare(`
      SELECT * FROM story_relationships
      WHERE project_id = ? AND relationship_id = ?
      ORDER BY (valid_until_chapter IS NULL) DESC, valid_from_chapter DESC LIMIT 1
    `).get(projectId, relId) as Record<string, unknown> | undefined
    const base = cur as Record<string, unknown> | undefined

    // 新关系必须有参与方才能建立；老关系可只改 status/张力（参与方沿用）
    if (!base && (!participants || participants.length < 2)) continue

    const pa = participants?.[0] ?? String(base?.participant_a ?? '')
    const pb = participants?.[1] ?? String(base?.participant_b ?? '')
    const status = relUpdate.status_change?.to ?? String(base?.current_status ?? '初识')
    let tension = parseJson<string[]>(base?.tension_points_json, [])
    if (relUpdate.new_tension_points?.length) {
      tension = [...new Set([...tension, ...relUpdate.new_tension_points])]
    }
    const trajectory = String(base?.trajectory ?? '')

    if (base && Number(base.valid_from_chapter) === chapterIndex) {
      // 同章重结算：覆盖该行（valid_from/until 不变，仍为本章生效行；记录本次来源）
      db.prepare(`
        UPDATE story_relationships SET
          participant_a = ?, participant_b = ?, current_status = ?,
          tension_points_json = ?, trajectory = ?, last_interaction_chapter = ?,
          source_event_id = ?, actor = ?, updated_at = ?
        WHERE id = ?
      `).run(pa, pb, status, JSON.stringify(tension), trajectory, chapterIndex, srcId, srcActor, timestamp, String(base.id))
    } else {
      if (base && base.valid_until_chapter == null) {
        // 跨章：先关门旧当前行（valid_until = 本章 - 1）
        db.prepare('UPDATE story_relationships SET valid_until_chapter = ? WHERE id = ?')
          .run(chapterIndex - 1, String(base.id))
      }
      // 插本章新当前行（valid_from = 本章，until = NULL）
      db.prepare(`
        INSERT INTO story_relationships
          (id, project_id, relationship_id, participant_a, participant_b, current_status,
           tension_points_json, trajectory, last_interaction_chapter,
           valid_from_chapter, valid_until_chapter, source_event_id, actor, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uid(), projectId, relId, pa, pb, status,
        JSON.stringify(tension), trajectory, chapterIndex,
        chapterIndex, null, srcId, srcActor, timestamp
      )
    }
  }

  // Foreshadowing updates
  if (normalizedDelta.foreshadowing_delta) {
    for (const planted of normalizedDelta.foreshadowing_delta.planted) {
      db.prepare(`
        INSERT OR IGNORE INTO story_foreshadowing
          (id, project_id, foreshadowing_id, type, description, status, planted_chapter,
           planted_method, payoff_chapter, clues_json, connections_json,
           source_event_id, actor, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, '[]', '[]', ?, ?, ?)
      `).run(
        uid(), projectId, planted.id, planted.type, planted.description,
        chapterIndex, planted.method, planted.payoff_chapter ?? null,
        srcId, srcActor, timestamp
      )
    }

    for (const advanced of normalizedDelta.foreshadowing_delta.advanced) {
      const row = db.prepare(
        `SELECT clues_json FROM story_foreshadowing WHERE project_id = ? AND foreshadowing_id = ?`
      ).get(projectId, advanced.id) as Record<string, unknown> | undefined

      if (row) {
        const clues = parseJson<Foreshadowing['clues']>(row.clues_json, [])
        const nextClue = { chapter: chapterIndex, clue: advanced.clue, method: advanced.method }
        if (!clues.some((item) => item.chapter === nextClue.chapter && item.clue === nextClue.clue && item.method === nextClue.method)) {
          clues.push(nextClue)
        }
        db.prepare(`
          UPDATE story_foreshadowing
          SET clues_json = ?, status = 'advanced',
              source_event_id = ?, actor = ?, updated_at = ?
          WHERE project_id = ? AND foreshadowing_id = ?
        `).run(JSON.stringify(clues), srcId, srcActor, timestamp, projectId, advanced.id)
      }
    }

    for (const resolved of normalizedDelta.foreshadowing_delta.resolved) {
      db.prepare(`
        UPDATE story_foreshadowing
        SET status = 'resolved', resolved_chapter = ?,
            source_event_id = ?, actor = ?, updated_at = ?
        WHERE project_id = ? AND foreshadowing_id = ?
      `).run(chapterIndex, srcId, srcActor, timestamp, projectId, resolved.id)
    }
  }

  // Timeline
  if (normalizedDelta.timeline) {
    db.prepare(`
      INSERT OR REPLACE INTO story_timeline
        (id, project_id, chapter_index, story_date, events_json, world_state_changes_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      uid(), projectId, chapterIndex,
      normalizedDelta.timeline.current_story_date ?? '',
      JSON.stringify(normalizedDelta.timeline.events ?? []),
      JSON.stringify(normalizedDelta.timeline.world_state_changes ?? []),
      timestamp
    )
  }

  db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

// ==================== Context Builder ====================

/** 某角色在任意章点的生效状态（P7.1；该角色该章前未出现 → null）。 */
export function getCharacterStateAtChapter(
  db: DatabaseSync,
  projectId: string,
  characterId: string,
  chapterIndex: number
): CharacterState | null {
  const row = (STORY_STATE_CLOSURE_ENABLED
    ? db.prepare(`
        SELECT * FROM story_character_state
        WHERE project_id = ? AND character_id = ?
          AND valid_from_chapter <= ?
          AND (valid_until_chapter IS NULL OR valid_until_chapter >= ?)
        ORDER BY valid_from_chapter DESC LIMIT 1
      `).get(projectId, characterId, chapterIndex, chapterIndex)
    : db.prepare(`
        SELECT * FROM story_character_state
        WHERE project_id = ? AND character_id = ? AND chapter_index <= ?
        ORDER BY chapter_index DESC LIMIT 1
      `).get(projectId, characterId, chapterIndex)) as Record<string, unknown> | undefined
  return row ? toCharacterState(row) : null
}

/** 任意章点的世界状态整包（角色精确走生效区间；其余表取 ≤ 该章的最近事实）。 */
export function queryStateAtChapter(
  db: DatabaseSync,
  projectId: string,
  chapterIndex: number
): StoryStateContext {
  const allIds = getAllCharacterIds(db, projectId)
  const characterStates = allIds
    .map((id) => getCharacterStateAtChapter(db, projectId, id, chapterIndex))
    .filter((c): c is CharacterState => c != null)

  // 伏笔无 closure（单行累积）：按章推导活跃性——已埋且该章时点尚未回收者视为活跃
  const fsRows = db.prepare(`
    SELECT * FROM story_foreshadowing
    WHERE project_id = ?
      AND planted_chapter <= ?
      AND status != 'abandoned'
      AND (resolved_chapter IS NULL OR resolved_chapter > ?)
    ORDER BY planted_chapter ASC LIMIT 30
  `).all(projectId, chapterIndex, chapterIndex) as Array<Record<string, unknown>>

  const tlRows = db.prepare(`
    SELECT * FROM story_timeline
    WHERE project_id = ? AND chapter_index <= ?
    ORDER BY chapter_index DESC LIMIT 5
  `).all(projectId, chapterIndex) as Array<Record<string, unknown>>

  return {
    characterStates,
    activeForeshadowing: fsRows.map((row) => ({
      foreshadowingId: String(row.foreshadowing_id),
      type: String(row.type),
      description: String(row.description),
      // 当前行 status 可能已是 resolved（更晚章回收）；按该章时点推导为活跃/推进
      status: (String(row.status) === 'advanced' ? 'advanced' : 'active') as Foreshadowing['status'],
      plantedChapter: Number(row.planted_chapter),
      plantedMethod: String(row.planted_method ?? ''),
      payoffChapter: row.payoff_chapter != null ? Number(row.payoff_chapter) : null,
      resolvedChapter: row.resolved_chapter != null ? Number(row.resolved_chapter) : null,
      clues: parseJson<Foreshadowing['clues']>(row.clues_json, []),
      connections: parseJson<string[]>(row.connections_json, [])
    })),
    relationships: getRelationshipsAtChapter(db, projectId, chapterIndex, allIds),
    recentTimeline: tlRows.reverse().map((row) => ({
      chapterIndex: Number(row.chapter_index),
      storyDate: String(row.story_date ?? ''),
      events: parseJson<string[]>(row.events_json, []),
      worldStateChanges: parseJson<string[]>(row.world_state_changes_json, [])
    })),
    worldRules: getWorldRules(db, projectId).filter((r) => r.establishedChapter <= chapterIndex),
    activeClocks: getActiveClocks(db, projectId)
  }
}

// ==================== Chapter Summaries（章摘要账，P7.3）====================

/** 由当次结算 delta 确定性聚合章摘要（title 取 chapters 排序行；无 chapters 表时容错为 ''）。 */
export function buildChapterSummaryFromDelta(
  db: DatabaseSync,
  projectId: string,
  chapterIndex: number,
  delta: StateDelta | null
): Omit<ChapterSummary, 'projectId' | 'chapterIndex' | 'sourceEventId' | 'updatedAt'> {
  const d = delta ? normalizeStateDelta(delta) : null
  const characters = [...new Set([
    ...(d?.characters_updated ?? []).map((c) => c.character_id),
    ...(d?.relationships_delta ?? []).flatMap((r) => r.participants ?? [])
  ])]
  const events = [...(d?.timeline?.events ?? [])]
  const stateChanges: string[] = []
  if (d?.characters_updated?.length) stateChanges.push('characters')
  if (d?.relationships_delta?.length) stateChanges.push('relationships')
  const fw = d?.foreshadowing_delta
  if (fw && (fw.planted.length || fw.advanced.length || fw.resolved.length)) stateChanges.push('foreshadowing')
  if (events.length) stateChanges.push('timeline')
  const hookActivity = {
    planted: fw?.planted.length ?? 0,
    advanced: fw?.advanced.length ?? 0,
    resolved: fw?.resolved.length ?? 0
  }
  // title：按 chapters 排序取第 chapterIndex 行（同 resolveChapterOrdinal 语义；无表容错 ''）
  let title = ''
  try {
    const row = db.prepare(`
      SELECT title FROM chapters WHERE project_id = ?
      ORDER BY sort_order ASC, rowid ASC LIMIT 1 OFFSET ?
    `).get(projectId, chapterIndex) as { title?: string } | undefined
    if (row) title = String(row.title ?? '')
  } catch {
    title = ''
  }
  return { title, characters, events, stateChanges, hookActivity }
}

/** upsert 一章的摘要（同章重结算覆盖重算）。 */
export function upsertChapterSummary(
  db: DatabaseSync,
  projectId: string,
  chapterIndex: number,
  input: {
    title: string
    characters: string[]
    events: string[]
    stateChanges: string[]
    hookActivity: { planted: number; advanced: number; resolved: number }
    sourceEventId?: string | null
  }
): void {
  db.prepare(`
    INSERT INTO chapter_summaries (
      project_id, chapter_index, title, characters_json, events_json,
      state_changes_json, hook_activity_json, source_event_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, chapter_index) DO UPDATE SET
      title = excluded.title,
      characters_json = excluded.characters_json,
      events_json = excluded.events_json,
      state_changes_json = excluded.state_changes_json,
      hook_activity_json = excluded.hook_activity_json,
      source_event_id = excluded.source_event_id,
      updated_at = excluded.updated_at
  `).run(
    projectId, chapterIndex, input.title,
    JSON.stringify(input.characters), JSON.stringify(input.events),
    JSON.stringify(input.stateChanges), JSON.stringify(input.hookActivity),
    input.sourceEventId ?? null, now()
  )
}

/** 结算落账后的便捷入口：由 delta 聚合并 upsert 章摘要（无 LLM）。 */
export function summarizeChapterAfterSettlement(
  db: DatabaseSync,
  projectId: string,
  chapterIndex: number,
  delta: StateDelta | null,
  sourceEventId?: string | null
): void {
  const summary = buildChapterSummaryFromDelta(db, projectId, chapterIndex, delta)
  upsertChapterSummary(db, projectId, chapterIndex, { ...summary, sourceEventId })
}

function rowToChapterSummary(row: Record<string, unknown>): ChapterSummary {
  return {
    projectId: String(row.project_id),
    chapterIndex: Number(row.chapter_index),
    title: String(row.title ?? ''),
    characters: parseJson<string[]>(row.characters_json, []),
    events: parseJson<string[]>(row.events_json, []),
    stateChanges: parseJson<string[]>(row.state_changes_json, []),
    hookActivity: parseJson<ChapterSummary['hookActivity']>(row.hook_activity_json, { planted: 0, advanced: 0, resolved: 0 }),
    sourceEventId: row.source_event_id == null ? null : String(row.source_event_id),
    updatedAt: String(row.updated_at ?? '')
  }
}

/** 读一章摘要（无则 null）。 */
export function readChapterSummary(
  db: DatabaseSync,
  projectId: string,
  chapterIndex: number
): ChapterSummary | null {
  const row = db.prepare('SELECT * FROM chapter_summaries WHERE project_id = ? AND chapter_index = ?')
    .get(projectId, chapterIndex) as Record<string, unknown> | undefined
  return row ? rowToChapterSummary(row) : null
}

/** 项目章摘要列表（章号倒序，limit）。 */
export function listChapterSummaries(
  db: DatabaseSync,
  projectId: string,
  limit = 50
): ChapterSummary[] {
  const rows = db.prepare(`
    SELECT * FROM chapter_summaries WHERE project_id = ?
    ORDER BY chapter_index DESC LIMIT ?
  `).all(projectId, limit) as Array<Record<string, unknown>>
  return rows.map((row) => rowToChapterSummary(row))
}

/**
 * 删除该 project 下「来源已不存在」的向量残留（chapter_segment 章段 / reference_novel 参考书段）。
 * 现状召回池当前性由「每章 DELETE+重建」+ workspace 启动期孤儿清理保证；此函数是其按项目即时版，
 * 可在索引/回滚/清理时调用；若依赖表不存在（纯 story 内存库）则跳过，返回 0。
 */
export function pruneOrphanedStoryEmbeddings(db: DatabaseSync, projectId: string): number {
  try {
    db.exec('BEGIN')
    try {
      const r1 = db.prepare(`
        DELETE FROM story_embeddings
        WHERE project_id = ? AND source_type = 'chapter_segment'
          AND source_id NOT IN (SELECT id FROM chapters WHERE project_id = ?)
      `).run(projectId, projectId)
      const r2 = db.prepare(`
        DELETE FROM story_embeddings
        WHERE project_id = ? AND source_type = 'reference_novel'
          AND source_id NOT IN (SELECT id FROM reference_works WHERE project_id = ?)
      `).run(projectId, projectId)
      db.exec('COMMIT')
      return Number(r1.changes) + Number(r2.changes)
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } catch {
    // chapters / reference_works 不存在（纯 story 库）→ 无引用可判，跳过
    return 0
  }
}

export function buildStoryStateContext(
  db: DatabaseSync,
  projectId: string,
  involvedCharacterIds: string[]
): StoryStateContext {
  const allCharIds = involvedCharacterIds.length
    ? involvedCharacterIds
    : getAllCharacterIds(db, projectId)

  return {
    characterStates: getLatestCharacterStates(db, projectId, allCharIds),
    activeForeshadowing: getActiveForeshadowing(db, projectId),
    relationships: getRelationships(db, projectId, allCharIds),
    recentTimeline: getRecentTimeline(db, projectId, 5),
    worldRules: getWorldRules(db, projectId),
    activeClocks: getActiveClocks(db, projectId)
  }
}

export function formatStoryStateForPrompt(ctx: StoryStateContext): string {
  const sections: string[] = []

  if (ctx.characterStates.length) {
    const lines = ctx.characterStates.map((c) => {
      const parts = [`${c.characterId}: 位置[${c.location || '未知'}]`]
      if (c.physicalState && c.physicalState !== '正常') parts.push(`身体[${c.physicalState}]`)
      if (c.mentalState) parts.push(`心理[${c.mentalState}]`)
      if (c.arcStage) parts.push(`阶段[${c.arcStage}]`)
      if (c.powerLevel) parts.push(`能力[${c.powerLevel}]`)
      if (c.inventory.length) parts.push(`持有[${c.inventory.join('、')}]`)
      if (c.goals.length) parts.push(`目标[${c.goals.join('、')}]`)
      return `- ${parts.join(', ')}`
    })
    sections.push(`### 角色当前状态\n${lines.join('\n')}`)
  }

  if (ctx.activeForeshadowing.length) {
    const lines = ctx.activeForeshadowing.slice(0, 15).map((f) => {
      const clueCount = f.clues.length
      const payoff = f.payoffChapter ? `预定第${f.payoffChapter}章揭示` : '揭示时间待定'
      return `- ${f.foreshadowingId}[${f.status}]: ${f.description} (第${f.plantedChapter}章埋设, 已释放${clueCount}条线索, ${payoff})`
    })
    sections.push(`### 活跃伏笔 (${ctx.activeForeshadowing.length}条)\n${lines.join('\n')}`)
  }

  if (ctx.relationships.length) {
    const lines = ctx.relationships.map((r) => {
      const tension = r.tensionPoints.length ? `, 矛盾[${r.tensionPoints.join('/')}]` : ''
      return `- ${r.participantA} ↔ ${r.participantB}: ${r.currentStatus}${tension}`
    })
    sections.push(`### 关系网络\n${lines.join('\n')}`)
  }

  if (ctx.recentTimeline.length) {
    const lines = ctx.recentTimeline.map((t) => {
      const date = t.storyDate ? `[${t.storyDate}]` : ''
      return `- 第${t.chapterIndex}章${date}: ${t.events.join('; ')}`
    })
    sections.push(`### 近期时间线\n${lines.join('\n')}`)
  }

  if (ctx.worldRules.length) {
    const lines = ctx.worldRules.map((r) => `- ${r.ruleContent} (第${r.establishedChapter}章确立)`)
    sections.push(`### 世界规则\n${lines.join('\n')}`)
  }

  if (ctx.activeClocks.length) {
    const lines = ctx.activeClocks.map((c) => {
      const deadline = c.deadlineChapter ? `截止第${c.deadlineChapter}章` : '无明确截止'
      return `- [${c.urgency}] ${c.eventDescription} (${deadline})`
    })
    sections.push(`### 倒计时事件\n${lines.join('\n')}`)
  }

  return sections.join('\n\n')
}

/** 当前章摘要账 → Markdown 速览（P7.6 投影用）。 */
function renderChapterSummariesMarkdown(db: DatabaseSync, projectId: string): string {
  const rows = listChapterSummaries(db, projectId, 500)
  if (!rows.length) return '（暂无章节摘要账：尚未有章节完成结算）'
  const lines: string[] = []
  for (const r of [...rows].reverse()) {
    const hooks = r.hookActivity
    lines.push(
      `- 第${r.chapterIndex}章${r.title ? `《${r.title}》` : ''}：角色[${r.characters.join('、') || '—'}] ` +
      `事件[${r.events.join('；') || '—'}] 变更[${r.stateChanges.join('/') || '—'}] ` +
      `伏笔(埋${hooks.planted}/推${hooks.advanced}/收${hooks.resolved})${r.sourceEventId ? ` [${r.sourceEventId}]` : ''}`
    )
  }
  return lines.join('\n')
}

/**
 * 可再生只读投影：当前世界状态 + 逐章摘要账 → Markdown（P7.6）。
 * 仅供人类审阅/外部工具/Git 演进；**只读、不回读、不构成真相源**（真相仍在 SQLite）。
 */
export function buildTruthProjectionMarkdown(db: DatabaseSync, projectId: string): string {
  const ctx = buildStoryStateContext(db, projectId, [])
  const stateMd = formatStoryStateForPrompt(ctx)
  const summariesMd = renderChapterSummariesMarkdown(db, projectId)
  const header = [
    '# 世界真相投影（可再生 · 只读）',
    '',
    `> 生成时间：${now()} · 数据源：本机真相账本（SQLite）。`,
    '> 本文件是可再生投影，可安全删除/忽略；修改它不会影响故事状态（真相不回读）。',
    ''
  ].join('\n')
  return [
    header,
    '## 当前世界状态',
    '',
    stateMd || '（空）',
    '',
    '## 逐章摘要账',
    '',
    summariesMd,
    ''
  ].join('\n')
}
