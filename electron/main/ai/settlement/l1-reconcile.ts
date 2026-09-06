/**
 * L1(LLM 对账) 输出的收敛/防编造（纯函数）。
 *
 * LLM 只允许产出受限的 category/severity 集合；未知字段、空消息一律丢弃，
 * 未知 category 收敛为 state_conflict，未知 severity 收敛为 hint——
 * 防止模型编造结构破坏下游 Arbiter 的决策表。
 *
 * 无副作用、无运行时相对依赖（仅 `import type`），可直接被 `node --test` 以 `.ts` 导入。
 */
import type { SettlementIssue } from './types'

const ALLOWED_CATEGORIES = new Set<string>([
  'location_mismatch', 'item_not_owned', 'timeline_break', 'rule_violation', 'state_conflict'
])
const ALLOWED_SEVERITIES = new Set<string>(['error', 'warning', 'hint'])

export function normalizeReconcileIssues(parsed: unknown): SettlementIssue[] {
  const root = parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
  const list = Array.isArray(root.issues) ? root.issues : []
  const issues: SettlementIssue[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const it = item as Record<string, unknown>
    const message = typeof it.message === 'string' && it.message.trim() ? it.message.trim() : ''
    if (!message) continue
    const category = typeof it.category === 'string' && ALLOWED_CATEGORIES.has(it.category)
      ? it.category as SettlementIssue['category']
      : 'state_conflict'
    const severity = typeof it.severity === 'string' && ALLOWED_SEVERITIES.has(it.severity)
      ? it.severity as SettlementIssue['severity']
      : 'hint'
    issues.push({
      category,
      severity,
      message,
      ref: typeof it.ref === 'string' && it.ref.trim() ? it.ref.trim() : undefined
    })
  }
  return issues
}
