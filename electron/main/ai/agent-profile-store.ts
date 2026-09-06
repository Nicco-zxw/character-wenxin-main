/**
 * P8.7：项目级 Agent 差异化配置存储（`project_agent_profiles` 独立小表）。
 *
 * 目的：为 P8.1 已开放的 AgentProfile（含 model 覆盖）提供「每项目一份」的配置源。
 * 渲染层六步 / 未来主进程 chapter-workflow 协调器读取本项目配置 → 按角色套用 settings。
 *
 * 设计：
 *  - 独立表（project_id PK + profiles_json + updated_at），复用 book_locks / narrative_forecasts
 *    「独立小表 + 建库 init」先例，不触碰庞大的 project 序列化链路；
 *  - 仅依赖 node 内建，可被 node --test 直接以 .ts 后缀导入；
 *  - sanitize 与 `electron/shared/agent-profiles` 的角色/字段语义一致（此处内联六角色名，
 *    避免 node 测试引入 value 依赖；如角色集合变更需同步两处）。
 */
import type { DatabaseSync } from 'node:sqlite'

export const AGENT_ROLES = ['memo', 'draft', 'audit', 'repair', 'humanize', 'session-note'] as const
export type StoredAgentRole = (typeof AGENT_ROLES)[number]

export interface StoredAgentProfile {
  model?: string
  temperature?: number
  maxTokens?: number
}
export type StoredAgentProfileMap = Partial<Record<StoredAgentRole, StoredAgentProfile>>

export interface ProjectAgentSettings {
  /** 是否启用本项目级 Agent 差异化（默认关；开=六步按 profiles 套用，缺省角色回退内置档位）。 */
  enabled: boolean
  profiles: StoredAgentProfileMap
}

const AGENT_PROFILE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS project_agent_profiles (
    project_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    profiles_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
  ) STRICT;
`

export function initAgentProfileSchema(db: DatabaseSync): void {
  db.exec(AGENT_PROFILE_SCHEMA)
  ensureAgentProfileColumns(db)
}

/** 旧表补列：为已创建的 project_agent_profiles 补 enabled（幂等）。 */
function ensureAgentProfileColumns(db: DatabaseSync): void {
  const cols = db.prepare('PRAGMA table_info(project_agent_profiles)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'enabled')) {
    db.exec('ALTER TABLE project_agent_profiles ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0')
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return {}
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

const clampTemperature = (v: number): number => Math.min(2, Math.max(0, v))

/**
 * 收敛任意输入为合法 AgentProfileMap：只保留已知六角色、每角色只保留
 * model/ temperature(0-2)/ maxTokens(≥1 整数)，丢弃其余字段与未知角色。
 */
export function sanitizeAgentProfiles(input: unknown): StoredAgentProfileMap {
  if (!input || typeof input !== 'object') return {}
  const raw = input as Record<string, unknown>
  const out: StoredAgentProfileMap = {}
  for (const role of AGENT_ROLES) {
    const p = raw[role]
    if (!p || typeof p !== 'object') continue
    const src = p as Record<string, unknown>
    const clean: StoredAgentProfile = {}
    if (typeof src.model === 'string' && src.model.trim()) clean.model = src.model.trim()
    if (typeof src.temperature === 'number' && Number.isFinite(src.temperature)) {
      clean.temperature = clampTemperature(src.temperature)
    }
    if (typeof src.maxTokens === 'number' && Number.isFinite(src.maxTokens)) {
      clean.maxTokens = Math.max(1, Math.floor(src.maxTokens))
    }
    if (Object.keys(clean).length > 0) out[role] = clean
  }
  return out
}

export function readProjectAgentProfiles(db: DatabaseSync, projectId: string): StoredAgentProfileMap {
  const row = db.prepare(
    'SELECT profiles_json FROM project_agent_profiles WHERE project_id = ?'
  ).get(projectId) as { profiles_json?: string } | undefined
  return sanitizeAgentProfiles(parseJson(row?.profiles_json))
}

export function writeProjectAgentProfiles(
  db: DatabaseSync,
  projectId: string,
  profiles: unknown
): StoredAgentProfileMap {
  const clean = sanitizeAgentProfiles(profiles)
  db.prepare(`
    INSERT INTO project_agent_profiles (project_id, profiles_json, enabled, updated_at)
    VALUES (?, ?, 0, ?)
    ON CONFLICT(project_id) DO UPDATE SET
      profiles_json = excluded.profiles_json,
      updated_at = excluded.updated_at
  `).run(projectId, JSON.stringify(clean), new Date().toISOString())
  return clean
}

/** 读取整包设置（enabled + profiles）；无行 → { enabled:false, profiles:{} }。 */
export function readProjectAgentSettings(
  db: DatabaseSync,
  projectId: string
): ProjectAgentSettings {
  const row = db.prepare(
    'SELECT enabled, profiles_json FROM project_agent_profiles WHERE project_id = ?'
  ).get(projectId) as { enabled?: number; profiles_json?: string } | undefined
  const enabled = row?.enabled === 1
  const parsed = parseJson(row?.profiles_json)
  const profiles = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
  return { enabled, profiles: sanitizeAgentProfiles(profiles) }
}

/** 写入整包设置（enabled + profiles），返回收敛后的设置。 */
export function writeProjectAgentSettings(
  db: DatabaseSync,
  projectId: string,
  settings: { enabled?: boolean; profiles?: unknown }
): ProjectAgentSettings {
  const existing = readProjectAgentSettings(db, projectId)
  const cleanProfiles =
    settings.profiles === undefined
      ? existing.profiles
      : sanitizeAgentProfiles(settings.profiles)
  const enabled = settings.enabled === true
  db.prepare(`
    INSERT INTO project_agent_profiles (project_id, enabled, profiles_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET
      enabled = excluded.enabled,
      profiles_json = excluded.profiles_json,
      updated_at = excluded.updated_at
  `).run(projectId, enabled ? 1 : 0, JSON.stringify(cleanProfiles), new Date().toISOString())
  return { enabled, profiles: cleanProfiles }
}
