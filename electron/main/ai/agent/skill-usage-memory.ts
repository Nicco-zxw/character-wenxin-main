import { ensureWorkspaceDb } from '../../workspace-store'
import type { ToolCallTrace } from '../shared-types'

export type SkillUsageHint = {
  skillId: string
  usageCount: number
}

let tableEnsured = false

async function ensureTable(): Promise<void> {
  if (tableEnsured) return
  const db = await ensureWorkspaceDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      task TEXT NOT NULL,
      used_at TEXT NOT NULL
    )
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_skill_usage_project
      ON skill_usage_log(project_id, task, used_at)
  `)
  tableEnsured = true
}

export async function recordSkillUsage(
  projectId: string,
  task: string,
  toolCalls: ToolCallTrace[]
): Promise<void> {
  if (!projectId || !toolCalls.length) return

  await ensureTable()
  const db = await ensureWorkspaceDb()
  const now = new Date().toISOString()
  const stmt = db.prepare(
    'INSERT INTO skill_usage_log (project_id, skill_id, task, used_at) VALUES (?, ?, ?, ?)'
  )

  for (const call of toolCalls) {
    if (call.tool === 'skill_load' && call.args?.skill_id) {
      stmt.run(projectId, String(call.args.skill_id), task, now)
    }
  }
}

export async function getRecentSkillUsage(projectId: string, limit = 10): Promise<SkillUsageHint[]> {
  if (!projectId) return []

  await ensureTable()
  const db = await ensureWorkspaceDb()

  const rows = db.prepare(`
    SELECT skill_id, COUNT(*) as cnt
    FROM skill_usage_log
    WHERE project_id = ? AND task = 'chapter-first-draft'
    ORDER BY cnt DESC
    LIMIT ?
  `).all(projectId, limit) as { skill_id: string; cnt: number }[]

  return rows.map((r) => ({ skillId: r.skill_id, usageCount: r.cnt }))
}

export function formatSkillUsageHint(hints: SkillUsageHint[]): string {
  if (!hints.length) return ''
  const lines = hints.slice(0, 5).map((h) => `- ${h.skillId}（最近 ${h.usageCount} 次使用）`)
  return [
    '',
    '## 历史 Skill 使用偏好',
    '',
    '以下 skill 在最近的章节生成中被频繁加载，可优先考虑：',
    ...lines
  ].join('\n')
}
