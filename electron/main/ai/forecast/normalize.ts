/**
 * forecast 分支输出净化（纯函数，防 LLM 编造脏结构）。
 * 保证：分支 id 唯一（缺失/重复则重排为 b1..bN）、title 必填、关键字段受限类型、
 * 数量 clamp 到 [2,5]。无副作用、无运行时相对依赖（仅 `import type`）。
 */
import type { ForecastBranchMeta } from './store'

export const FORECAST_MIN_BRANCHES = 2
export const FORECAST_MAX_BRANCHES = 5

export function clampBranchCount(branchCount: number): number {
  if (!Number.isFinite(branchCount)) return FORECAST_MIN_BRANCHES
  return Math.max(FORECAST_MIN_BRANCHES, Math.min(FORECAST_MAX_BRANCHES, Math.round(branchCount)))
}

function asStringArray(value: unknown, limit = 8): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit)
}

function asSingleLine(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback
  const cleaned = value.replace(/\s+/g, ' ').trim()
  return cleaned || fallback
}

/**
 * 把 LLM 返回的根对象收敛为 { title, branches, summary }。
 * @throws Error 当收敛后没有任何合法分支
 */
export function sanitizeForecastRoot(
  root: unknown,
  branchCount: number
): { title: string; branches: ForecastBranchMeta[]; summary: Record<string, unknown> } {
  const rawRoot = root != null && typeof root === 'object' && !Array.isArray(root)
    ? root as Record<string, unknown>
    : {}
  const rawBranches = Array.isArray(rawRoot.branches) ? rawRoot.branches : []

  const branches: ForecastBranchMeta[] = []
  let index = 0
  for (const raw of rawBranches) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const item = raw as Record<string, unknown>
    const title = asSingleLine(item.title)
    if (!title) continue
    index += 1
    branches.push({
      id: `b${index}`,
      title,
      beats: asStringArray(item.beats),
      decision: asSingleLine(item.decision),
      changes: asStringArray(item.changes),
      risks: asStringArray(item.risks),
      fit: asSingleLine(item.fit)
    })
  }

  const want = clampBranchCount(branchCount)
  const trimmed = branches.slice(0, want)
  if (trimmed.length === 0) {
    throw new Error('forecast 分支净化后无有效分支')
  }

  const summary: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rawRoot)) {
    if (key === 'branches' || key === 'title') continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      summary[key] = value
    }
  }

  return {
    title: asSingleLine(rawRoot.title) || '剧情推演',
    branches: trimmed,
    summary
  }
}
