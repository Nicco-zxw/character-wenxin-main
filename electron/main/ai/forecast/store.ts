/**
 * P6.2 轨道三：隔离式多分支推演（forecast）——存储核心（行为默认不接 LLM/UI）。
 *
 * 原则：forecast 只读写自己的 `narrative_forecasts` 表；绝不写 story 或 settlement 等正史/结算表——
 * 选支只保存「分支计划」，不提前改动正文、设定或故事状态（参考 inkos forecast/store）。
 *
 * 设计约束：仅依赖 node 内置模块，可直接被 `node --test` 以 `.ts` 后缀导入。
 */
import type { DatabaseSync } from 'node:sqlite'

export type ForecastStatus = 'active' | 'selected' | 'expired'

/**
 * P8.5 采用衔接开关：adopt-memo 只写 forecast 域（narrative_forecasts 列），
 * 绝不触碰正史；置 false 可整体回退（仅不再持久化 memo，分支仍可 select）。
 */
export const FORECAST_ADOPT_ON = true

/** 单个分支的最小编一识记录（其余节拍/风险等字段由调用方自由扩展）。 */
export interface ForecastBranchMeta {
  id: string
  title: string
  [key: string]: unknown
}

export interface ForecastRecord {
  id: string
  projectId: string
  baseChapterIndex: number
  baseContentHash: string
  title: string
  status: ForecastStatus
  selectedBranchId: string | null
  branchCount: number
  branches: ForecastBranchMeta[]
  summary: Record<string, unknown>
  /** P8.5：采用后生成的「下一章建议 memo」（只写 forecast 域）。 */
  adoptionMemo?: Record<string, unknown> | null
  /** P8.5：采用时间。 */
  adoptedAt?: string | null
  createdAt: string
  updatedAt: string
}

const FORECAST_SCHEMA = `
  CREATE TABLE IF NOT EXISTS narrative_forecasts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    base_chapter_index INTEGER NOT NULL,
    base_content_hash TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    selected_branch_id TEXT,
    branch_count INTEGER NOT NULL DEFAULT 0,
    branches_json TEXT NOT NULL DEFAULT '[]',
    summary_json TEXT NOT NULL DEFAULT '{}',
    adoption_memo_json TEXT NOT NULL DEFAULT '{}',
    adopted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_narrative_forecasts_project
    ON narrative_forecasts (project_id, status, created_at DESC);
`

export function initForecastSchema(db: DatabaseSync): void {
  db.exec(FORECAST_SCHEMA)
  ensureForecastAdoptionColumns(db)
}

/** 旧库迁移：为 narrative_forecasts 补 P8.5 adoption 列（幂等）。 */
function ensureForecastAdoptionColumns(db: DatabaseSync): void {
  const cols = db.prepare('PRAGMA table_info(narrative_forecasts)').all() as Array<{ name: string }>
  const has = (name: string): boolean => cols.some((c) => c.name === name)
  if (!has('adoption_memo_json')) {
    db.exec("ALTER TABLE narrative_forecasts ADD COLUMN adoption_memo_json TEXT NOT NULL DEFAULT '{}'")
  }
  if (!has('adopted_at')) {
    db.exec('ALTER TABLE narrative_forecasts ADD COLUMN adopted_at TEXT')
  }
}

function uid(): string {
  return `fc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function now(): string {
  return new Date().toISOString()
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function rowToRecord(row: Record<string, unknown>): ForecastRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    baseChapterIndex: Number(row.base_chapter_index),
    baseContentHash: String(row.base_content_hash ?? ''),
    title: String(row.title ?? ''),
    status: String(row.status) as ForecastStatus,
    selectedBranchId: row.selected_branch_id == null ? null : String(row.selected_branch_id),
    branchCount: Number(row.branch_count),
    branches: parseJson<ForecastBranchMeta[]>(row.branches_json, []),
    summary: parseJson<Record<string, unknown>>(row.summary_json, {}),
    adoptionMemo: parseJson<Record<string, unknown> | null>(row.adoption_memo_json, null),
    adoptedAt: row.adopted_at == null ? null : String(row.adopted_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

/** 分支记录合法性：id 非空唯一 + title 非空（防 LLM/调用方喂脏数据）。 */
export function validateForecastBranches(branches: ForecastBranchMeta[]): string | null {
  if (!Array.isArray(branches) || branches.length === 0) {
    return 'forecast 至少需要 1 个分支'
  }
  const seen = new Set<string>()
  for (const branch of branches) {
    const id = typeof branch?.id === 'string' ? branch.id.trim() : ''
    const title = typeof branch?.title === 'string' ? branch.title.trim() : ''
    if (!id || !title) return '分支缺少 id 或 title'
    if (seen.has(id)) return `分支 id 重复：${id}`
    seen.add(id)
  }
  return null
}

export function createForecastRecord(
  db: DatabaseSync,
  input: {
    projectId: string
    baseChapterIndex: number
    baseContentHash?: string
    title?: string
    branches: ForecastBranchMeta[]
    summary?: Record<string, unknown>
  }
): { id: string; status: ForecastStatus } {
  const invalid = validateForecastBranches(input.branches)
  if (invalid) throw new Error(invalid)
  const id = uid()
  const ts = now()
  db.prepare(`
    INSERT INTO narrative_forecasts (
      id, project_id, base_chapter_index, base_content_hash, title, status,
      selected_branch_id, branch_count, branches_json, summary_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.projectId,
    input.baseChapterIndex,
    input.baseContentHash ?? '',
    input.title ?? '',
    input.branches.length,
    JSON.stringify(input.branches),
    JSON.stringify(input.summary ?? {}),
    ts,
    ts
  )
  return { id, status: 'active' }
}

export function getForecast(db: DatabaseSync, projectId: string, id: string): ForecastRecord | null {
  const row = db.prepare(
    'SELECT * FROM narrative_forecasts WHERE project_id = ? AND id = ?'
  ).get(projectId, id) as Record<string, unknown> | undefined
  return row ? rowToRecord(row) : null
}

export function listForecasts(db: DatabaseSync, projectId: string): ForecastRecord[] {
  const rows = db.prepare(`
    SELECT * FROM narrative_forecasts
    WHERE project_id = ?
    ORDER BY created_at DESC
  `).all(projectId) as Array<Record<string, unknown>>
  return rows.map(rowToRecord)
}

/** 采用某个分支：只更新 forecast 记录（selected_branch_id/status），
 * 不写正文/设定/状态（隔离承诺）。 */
export function selectForecastBranch(
  db: DatabaseSync,
  projectId: string,
  id: string,
  branchId: string
): { ok: boolean; error?: string } {
  const record = getForecast(db, projectId, id)
  if (!record) return { ok: false, error: 'forecast 不存在' }
  if (!record.branches.some((b) => b.id === branchId)) return { ok: false, error: '分支不存在' }
  if (record.status === 'expired') return { ok: false, error: '该 forecast 已过期，请基于最新正史重新推演' }
  db.prepare(`
    UPDATE narrative_forecasts
    SET status = 'selected', selected_branch_id = ?, updated_at = ?
    WHERE project_id = ? AND id = ?
  `).run(branchId, now(), projectId, id)
  return { ok: true }
}

/**
 * P8.5：采用分支并持久化「下一章建议 memo」（只写 forecast 域；隔离承诺不变）。
 * memo 由调用方生成（forecast/adoption.ts 纯函数 / 后续可 LLM），这里仅落库 + 记录采用时间。
 */
export function adoptForecastBranchWithMemo(
  db: DatabaseSync,
  projectId: string,
  id: string,
  branchId: string,
  memo: object
): { ok: boolean; error?: string; record?: ForecastRecord } {
  const record = getForecast(db, projectId, id)
  if (!record) return { ok: false, error: 'forecast 不存在' }
  if (!record.branches.some((b) => b.id === branchId)) return { ok: false, error: '分支不存在' }
  if (record.status === 'expired') return { ok: false, error: '该 forecast 已过期，请基于最新正史重新推演' }
  db.prepare(`
    UPDATE narrative_forecasts
    SET status = 'selected', selected_branch_id = ?, adoption_memo_json = ?, adopted_at = ?, updated_at = ?
    WHERE project_id = ? AND id = ?
  `).run(branchId, JSON.stringify(memo ?? {}), now(), now(), projectId, id)
  return { ok: true, record: getForecast(db, projectId, id) ?? undefined }
}

/** 正史推进后，把 base 早于给定章的 forecast 标记过期（不删除，供审计）。 */
export function expireForecastsOlderThan(
  db: DatabaseSync,
  projectId: string,
  baseChapterIndex: number
): number {
  const result = db.prepare(`
    UPDATE narrative_forecasts
    SET status = 'expired', updated_at = ?
    WHERE project_id = ? AND base_chapter_index < ? AND status IN ('active', 'selected')
  `).run(now(), projectId, baseChapterIndex)
  return Number(result.changes)
}

/** 隔离自检：返回该项目正史表行数（供测试/断言 forecast 不触碰正史）。 */
export function countStoryStateRows(db: DatabaseSync, projectId: string): number {
  const tables = ['story_character_state', 'story_foreshadowing', 'story_relationships', 'story_timeline'] as const
  let total = 0
  for (const table of tables) {
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table} WHERE project_id = ?`).get(projectId) as { cnt: number }
    total += Number(row.cnt ?? 0)
  }
  return total
}
