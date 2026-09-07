/**
 * 结算账本与状态快照存储（settlement_runs / settlement_snapshots）。
 *
 * 职责：
 * - `settlement_runs`：逐章记录每次结算（Observer 增量 + Validator 问题 + Arbiter 裁决），
 *   支撑审计回溯、幂等去重与 Phase 0 评测指标（矛盾率/回收率/成功率）。
 * - `settlement_snapshots`：结算落账前对受影响实体做状态级快照，支持按章回滚，
 *   与既有章节级 `chapter_versions` 互补。
 *
 * 本模块仅依赖 node 内置模块，可直接被 `node --test` 以 `.ts` 后缀导入。
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { StateDelta } from '../../story-state-store'
import type { ArbiterDecisionType, SettlementActor, SettlementIssue, SettlementRunRecord, SettlementStatus } from './types'

// ==================== Schema ====================

const SETTLEMENT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS settlement_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    chapter_id TEXT,
    chapter_index INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    decision TEXT NOT NULL,
    issues_json TEXT NOT NULL DEFAULT '[]',
    delta_json TEXT,
    reason TEXT NOT NULL DEFAULT '',
    actor TEXT NOT NULL DEFAULT 'observer',
    trace_id TEXT,
    base_ledger_version INTEGER NOT NULL DEFAULT 0,
    committed_ledger_version INTEGER,
    invalidated_at TEXT,
    invalidated_by_run_id TEXT,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_settlement_runs_chapter
    ON settlement_runs (project_id, chapter_id, chapter_index, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_settlement_runs_content
    ON settlement_runs (project_id, chapter_index, content_hash, status);

  CREATE TABLE IF NOT EXISTS settlement_snapshots (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    row_json TEXT,
    source_event_id TEXT,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_settlement_snapshots_chapter
    ON settlement_snapshots (project_id, chapter_index);
`

// ==================== Helpers ====================

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function now(): string {
  return new Date().toISOString()
}

/** 章节正文的确定性指纹，用于结算幂等与触发判断。 */
export function settlementContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/** 列出某表的现有列名集合（用于幂等迁移检查）。 */
function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map((r) => String(r.name)))
}

/**
 * 兼容迁移：旧库表已存在时，`CREATE TABLE IF NOT EXISTS` 不会补新列；
 * 缺列则 `ALTER TABLE ADD COLUMN`（幂等）。
 */
function ensureColumn(db: DatabaseSync, table: string, column: string, addSql: string): void {
  if (!tableColumns(db, table).has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${addSql}`)
  }
}

// ==================== Init ====================

export function initSettlementSchema(db: DatabaseSync): void {
  db.exec(SETTLEMENT_SCHEMA)
  // 兼容迁移：为既有库补 P7.0 新增的审计维度列（幂等）
  ensureColumn(db, 'settlement_runs', 'actor', "actor TEXT NOT NULL DEFAULT 'observer'")
  ensureColumn(db, 'settlement_runs', 'trace_id', 'trace_id TEXT')
  ensureColumn(db, 'settlement_runs', 'base_ledger_version', 'base_ledger_version INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'settlement_runs', 'committed_ledger_version', 'committed_ledger_version INTEGER')
  ensureColumn(db, 'settlement_runs', 'invalidated_at', 'invalidated_at TEXT')
  ensureColumn(db, 'settlement_runs', 'invalidated_by_run_id', 'invalidated_by_run_id TEXT')
  ensureColumn(db, 'settlement_snapshots', 'source_event_id', 'source_event_id TEXT')
}

// ==================== Ledger (settlement_runs) ====================

/** 生成一次结算事件 id（供落账前预生成，快照/状态行/账本同源引用）。 */
export function newSettlementRunId(): string {
  return uid()
}

export function recordSettlementRun(
  db: DatabaseSync,
  input: {
    /** 指定事件 id（与快照/状态行 source_event_id 同源）；缺省自动生成 */
    id?: string
    projectId: string
    chapterId?: string
    chapterIndex: number
    contentHash: string
    attempt: number
    status: SettlementStatus
    decision: ArbiterDecisionType
    issues: SettlementIssue[]
    delta?: unknown
    reason: string
    /** 触发方，默认 observer */
    actor?: SettlementActor
    /** 关联上下文 trace id（可空） */
    traceId?: string | null
    /** 观察所基于的项目账本版本；旧调用默认 0。 */
    baseLedgerVersion?: number
    /** 成功提交后的项目账本版本；未落账时默认 null。 */
    committedLedgerVersion?: number | null
  }
): string {
  const id = input.id ?? uid()
  db.prepare(`
    INSERT INTO settlement_runs (
      id, project_id, chapter_id, chapter_index, content_hash, attempt,
      status, decision, issues_json, delta_json, reason, actor, trace_id,
      base_ledger_version, committed_ledger_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.projectId,
    input.chapterId ?? null,
    input.chapterIndex,
    input.contentHash,
    input.attempt,
    input.status,
    input.decision,
    JSON.stringify(input.issues),
    input.delta == null ? null : JSON.stringify(input.delta),
    input.reason,
    input.actor ?? 'observer',
    input.traceId ?? null,
    input.baseLedgerVersion ?? 0,
    input.committedLedgerVersion ?? null,
    now()
  )
  return id
}

/** 将某章已 settled 的结算记录标记为 rolled_back（回滚后使同正文可再次结算）。 */
export function markSettlementRolledBack(
  db: DatabaseSync,
  projectId: string,
  chapterIndex: number
): number {
  const result = db.prepare(`
    UPDATE settlement_runs
    SET status = 'rolled_back', created_at = ?
    WHERE project_id = ? AND chapter_index = ? AND status IN ('settled', 'settled_with_warning')
  `).run(now(), projectId, chapterIndex)
  return Number(result.changes)
}

/** 回填结算记录的上下文 trace id（P7.4；traceId 可传 null 以清除）。 */
export function setSettlementRunTrace(
  db: DatabaseSync,
  runId: string,
  traceId: string | null
): void {
  db.prepare('UPDATE settlement_runs SET trace_id = ? WHERE id = ?').run(traceId, runId)
}

/**
 * 求 chapterId 在项目内的 0 基章节序号（chapters 按 sort_order,rowid 排序）。
 * 渲染层任务 context 长期不下发 chapterIndex，主进程据此兜底出真实章号，
 * 保证 settlement_runs/snapshots 的 chapter_index 与正文顺序一致。
 */
export function resolveChapterOrdinal(db: DatabaseSync, projectId: string, chapterId: string): number {
  const rows = db.prepare(`
    SELECT id FROM chapters WHERE project_id = ?
    ORDER BY sort_order ASC, rowid ASC
  `).all(projectId) as Array<{ id: string }>
  const idx = rows.findIndex((row) => row.id === chapterId)
  return idx >= 0 ? idx : 0
}

/** 某章最近一次结算记录的 created_at（无记录返回空串，供 supersede 基线比对）。 */
export function latestSettlementCreatedAt(
  db: DatabaseSync,
  projectId: string,
  chapterId: string | undefined,
  chapterIndex: number
): string {
  return readSettlementRun(db, projectId, chapterId, chapterIndex)?.createdAt ?? ''
}

/** 某章在项目内是否为最后一章（用于「定稿同步」等只允许最新章节的操作）。 */
export function isLatestChapter(
  db: DatabaseSync,
  projectId: string,
  chapterIndex: number
): boolean {
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM chapters WHERE project_id = ?')
    .get(projectId) as { cnt: number }
  return chapterIndex >= 0 && chapterIndex === Number(row.cnt ?? 0) - 1
}

/** 读取某章最近一次结算记录（按 attempt/时间倒序取最新）。 */
export function readSettlementRun(
  db: DatabaseSync,
  projectId: string,
  chapterId: string | undefined,
  chapterIndex: number
): SettlementRunRecord | null {
  const row = chapterId
    ? db.prepare(`
        SELECT * FROM settlement_runs
        WHERE project_id = ? AND chapter_id = ?
        ORDER BY created_at DESC, attempt DESC LIMIT 1
      `).get(projectId, chapterId)
    : db.prepare(`
        SELECT * FROM settlement_runs
        WHERE project_id = ? AND chapter_index = ?
        ORDER BY created_at DESC, attempt DESC LIMIT 1
      `).get(projectId, chapterIndex)

  if (!row) return null
  return rowToRecord(row as Record<string, unknown>)
}

/**
 * 该章当前正文（contentHash）是否已完成结算。
 * 幂等去重：命中 settled / settled_with_warning 视为已结算。
 */
export function hasSettledContent(
  db: DatabaseSync,
  projectId: string,
  chapterIndex: number,
  contentHash: string
): boolean {
  const row = db.prepare(`
    SELECT id FROM settlement_runs
    WHERE project_id = ? AND chapter_index = ? AND content_hash = ?
      AND status IN ('settled', 'settled_with_warning')
      AND invalidated_at IS NULL
    LIMIT 1
  `).get(projectId, chapterIndex, contentHash)
  return row != null
}

/** 已成功结算的最大章节号（未结算返回 null）。 */
export function latestSettledChapterIndex(db: DatabaseSync, projectId: string): number | null {
  const row = db.prepare(`
    SELECT MAX(chapter_index) AS max_ch FROM settlement_runs
    WHERE project_id = ? AND status IN ('settled', 'settled_with_warning')
      AND invalidated_at IS NULL
  `).get(projectId) as { max_ch: number | null }
  return row.max_ch == null ? null : Number(row.max_ch)
}

function rowToRecord(row: Record<string, unknown>): SettlementRunRecord {
  const issues = parseJson<SettlementIssue[]>(row.issues_json, [])
  const delta = row.delta_json == null ? null : parseJson<StateDelta | null>(row.delta_json, null)
  return {
    projectId: String(row.project_id),
    chapterId: row.chapter_id == null ? undefined : String(row.chapter_id),
    chapterIndex: Number(row.chapter_index),
    contentHash: String(row.content_hash),
    attempt: Number(row.attempt),
    status: String(row.status) as SettlementStatus,
    decision: String(row.decision) as ArbiterDecisionType,
    issues,
    delta,
    reason: String(row.reason ?? ''),
    actor: (row.actor as SettlementActor | undefined) ?? undefined,
    traceId: row.trace_id == null ? null : String(row.trace_id),
    baseLedgerVersion: Number(row.base_ledger_version ?? 0),
    committedLedgerVersion: row.committed_ledger_version == null
      ? null
      : Number(row.committed_ledger_version),
    createdAt: String(row.created_at ?? '')
  }
}

// ==================== State Snapshot / Rollback ====================

export interface SettlementSnapshotScope {
  characterIds: string[]
  foreshadowingIds: string[]
  relationshipIds: string[]
}

/**
 * 落账前对受影响的实体做状态级快照。
 * 之后若结算被回滚，可依据快照把各实体恢复到结算前状态。
 */
function snapshotSettlementStateCore(
  db: DatabaseSync,
  projectId: string,
  chapterIndex: number,
  scope: SettlementSnapshotScope,
  sourceEventId?: string | null
): void {
    db.prepare('DELETE FROM settlement_snapshots WHERE project_id = ? AND chapter_index = ?')
      .run(projectId, chapterIndex)

    const insertStmt = db.prepare(`
      INSERT INTO settlement_snapshots (id, project_id, chapter_index, entity, entity_id, row_json, source_event_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const ts = now()

    for (const characterId of scope.characterIds) {
      const row = db.prepare(`
        SELECT * FROM story_character_state
        WHERE project_id = ? AND character_id = ?
        ORDER BY chapter_index DESC LIMIT 1
      `).get(projectId, characterId) as Record<string, unknown> | undefined
      insertStmt.run(uid(), projectId, chapterIndex, 'character_state', characterId,
        row ? JSON.stringify(row) : null, sourceEventId ?? null, ts)
    }

    for (const id of scope.foreshadowingIds) {
      const row = db.prepare(
        'SELECT * FROM story_foreshadowing WHERE project_id = ? AND foreshadowing_id = ?'
      ).get(projectId, id) as Record<string, unknown> | undefined
      insertStmt.run(uid(), projectId, chapterIndex, 'foreshadowing', id,
        row ? JSON.stringify(row) : null, sourceEventId ?? null, ts)
    }

    for (const id of scope.relationshipIds) {
      // B1 closure-aware：取当前生效行（until NULL 优先，否则最大 valid_from）——closure off 单行同语义
      const row = db.prepare(`
        SELECT * FROM story_relationships
        WHERE project_id = ? AND relationship_id = ?
        ORDER BY (valid_until_chapter IS NULL) DESC, valid_from_chapter DESC LIMIT 1
      `).get(projectId, id) as Record<string, unknown> | undefined
      insertStmt.run(uid(), projectId, chapterIndex, 'relationship', id,
        row ? JSON.stringify(row) : null, sourceEventId ?? null, ts)
    }

    // timeline 整行按章节快照
    const timelineRow = db.prepare(
      'SELECT * FROM story_timeline WHERE project_id = ? AND chapter_index = ?'
    ).get(projectId, chapterIndex) as Record<string, unknown> | undefined
    insertStmt.run(uid(), projectId, chapterIndex, 'timeline', `ch${chapterIndex}`,
      timelineRow ? JSON.stringify(timelineRow) : null, sourceEventId ?? null, ts)

}

/** 在调用方已开启的事务中写入结算前快照。 */
export function snapshotSettlementStateInTransaction(
  db: DatabaseSync,
  projectId: string,
  chapterIndex: number,
  scope: SettlementSnapshotScope,
  sourceEventId?: string | null
): void {
  snapshotSettlementStateCore(db, projectId, chapterIndex, scope, sourceEventId)
}

/** 独立写入结算前快照；保留既有 API 的事务语义。 */
export function snapshotSettlementState(
  db: DatabaseSync,
  projectId: string,
  chapterIndex: number,
  scope: SettlementSnapshotScope,
  sourceEventId?: string | null
): void {
  db.exec('BEGIN')
  try {
    snapshotSettlementStateCore(db, projectId, chapterIndex, scope, sourceEventId)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** 将某章结算造成的影响回滚到快照状态。 */
export function rollbackSettlementState(
  db: DatabaseSync,
  projectId: string,
  chapterIndex: number
): number {
  const rows = db.prepare(`
    SELECT * FROM settlement_snapshots WHERE project_id = ? AND chapter_index = ?
  `).all(projectId, chapterIndex) as Array<Record<string, unknown>>

  db.exec('BEGIN')
  try {
    let restored = 0

    for (const snap of rows) {
      const entity = String(snap.entity)
      const entityId = String(snap.entity_id)
      const row = snap.row_json == null
        ? null
        : parseJson<Record<string, unknown> | null>(snap.row_json, null)

      if (entity === 'character_state') {
        // 回滚 = 删除本章写入行（closure 语义下即 valid_from=本章 的行，其 chapter_index=本章）
        // + 用快照行整行 REPLACE（同 id）：closure 下会把被本章关门的旧行重新打开 valid_until=NULL；
        //   旧语义下原行未被改动，REPLACE 幂等无害。
        db.prepare(`
          DELETE FROM story_character_state
          WHERE project_id = ? AND character_id = ? AND chapter_index = ?
        `).run(projectId, entityId, chapterIndex)
        if (row) {
          const restoredRow = upsertStoredRow(db, 'story_character_state', row, false)
          if (restoredRow > 0) restored += 1
        }
      } else if (entity === 'foreshadowing') {
        if (row) {
          upsertStoredRow(db, 'story_foreshadowing', row, false)
        } else {
          db.prepare('DELETE FROM story_foreshadowing WHERE project_id = ? AND foreshadowing_id = ?')
            .run(projectId, entityId)
        }
        restored += 1
      } else if (entity === 'relationship') {
        // B1 closure-aware：先删本章（valid_from=本章）写入的新行；
        // 排除快照行自身（其 id 若被本章关门，将靠下方 REPLACE 同 id 重新打开 valid_until=NULL）。
        db.prepare(`
          DELETE FROM story_relationships
          WHERE project_id = ? AND relationship_id = ? AND valid_from_chapter = ? AND id <> ?
        `).run(projectId, entityId, chapterIndex, row && typeof row.id === 'string' ? row.id : '')
        if (row) {
          upsertStoredRow(db, 'story_relationships', row, false)
        } else {
          db.prepare('DELETE FROM story_relationships WHERE project_id = ? AND relationship_id = ?')
            .run(projectId, entityId)
        }
        restored += 1
      } else if (entity === 'timeline') {
        if (row) {
          upsertStoredRow(db, 'story_timeline', row, false)
        } else {
          db.prepare('DELETE FROM story_timeline WHERE project_id = ? AND chapter_index = ?')
            .run(projectId, chapterIndex)
        }
        restored += 1
      }
    }

    db.exec('COMMIT')
    return restored
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** 删除指定章的结算快照（结算落账成功后清理）。 */
export function clearSettlementSnapshots(
  db: DatabaseSync,
  projectId: string,
  chapterIndex: number
): void {
  db.prepare('DELETE FROM settlement_snapshots WHERE project_id = ? AND chapter_index = ?')
    .run(projectId, chapterIndex)
}

/**
 * 用快照行重建/覆盖实体行。
 * `ignoreConflicts=true` 时（character_state）用 INSERT OR IGNORE，避免覆盖结算章之外的原行。
 */
function upsertStoredRow(
  db: DatabaseSync,
  table: string,
  row: Record<string, unknown>,
  ignoreConflicts: boolean
): number {
  const columns = Object.keys(row).filter((key) => row[key] !== undefined)
  if (columns.length === 0) return 0
  const verb = ignoreConflicts ? 'INSERT OR IGNORE' : 'INSERT OR REPLACE'
  const placeholders = columns.map(() => '?').join(', ')
  const values = columns.map((c): string | number | null => {
    const v = row[c]
    if (v == null) return null
    if (typeof v === 'string' || typeof v === 'number') return v
    return String(v)
  })
  const result = db.prepare(
    `${verb} INTO ${table} (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})`
  ).run(...values)
  return Number(result.changes)
}
