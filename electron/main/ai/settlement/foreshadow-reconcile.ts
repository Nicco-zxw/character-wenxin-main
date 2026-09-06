/**
 * 伏笔对账（确定性规则，Validator 的 L0 部分）。
 *
 * 把 Observer 产出的伏笔增量（planted/advanced/resolved）与当前账本
 * （activeForeshadowing）及章节号对照，产出 warning/hint 级问题：
 * - 回收了账本中不存在的伏笔（foreshadow_unplanted_resolve）
 * - 重复回收已 resolved 的伏笔（foreshadow_duplicate_resolve）
 * - 重复埋设已存在伏笔（foreshadow_duplicate_plant）
 * - 伏笔已过 payoff 章仍未回收（foreshadow_overdue，hint）
 * - ② 伏笔身份归一：Observer 跨章 id 物名词漂移（半枚玉佩 vs 半块玉佩）→
 *   精确不中时按共享 ≥2 汉字兜底为同一伏笔（foreshadow_id_drift，hint），
 *   使 resolve/plant 不再因表述漂移而漏配/误报 unplanted。
 *
 * 本模块无副作用、无运行时相对依赖，可直接被 `node --test` 以 `.ts` 导入。
 */
import type { Foreshadowing, StateDelta } from '../../story-state-store'
import type { SettlementIssue } from './types'

export interface ForeshadowReconcileInput {
  /** 结算前的活跃伏笔账本（status active/advanced） */
  activeForeshadowing: Foreshadowing[]
  /** 当前正在结算的章节号（0 基） */
  chapterIndex: number
  delta: StateDelta
}

export function reconcileForeshadowing(input: ForeshadowReconcileInput): SettlementIssue[] {
  const issues: SettlementIssue[] = []
  const active = input.activeForeshadowing
  const byId = new Map(active.map((f) => [f.foreshadowingId, f]))
  const foreshadowingDelta = input.delta.foreshadowing_delta ?? { planted: [], advanced: [], resolved: [] }

  for (const planted of foreshadowingDelta.planted ?? []) {
    // ② 精确命中优先；不中则按共享物名词兜底同一伏笔
    const exact = byId.get(planted.id)
    const existing = exact ?? fuzzyFind(active, planted.id)
    if (existing) {
      issues.push({
        category: 'foreshadow_duplicate_plant',
        severity: 'warning',
        message: exact
          ? `伏笔「${planted.id}」已在账本中（状态：${existing.status}），重复埋设记录会被忽略`
          : `伏笔「${planted.id}」与账本「${existing.foreshadowingId}」物名相近，视为同一伏笔（id 漂移），重复埋设记录会被忽略`,
        ref: existing.foreshadowingId
      })
    }
  }

  for (const resolved of foreshadowingDelta.resolved ?? []) {
    const exact = byId.get(resolved.id)
    const existing = exact ?? fuzzyFind(active, resolved.id)
    if (!existing) {
      issues.push({
        category: 'foreshadow_unplanted_resolve',
        severity: 'warning',
        message: `本章尝试回收伏笔「${resolved.id}」，但账本中没有该伏笔的埋设记录`,
        ref: resolved.id
      })
    } else if (existing.status === 'resolved') {
      issues.push({
        category: 'foreshadow_duplicate_resolve',
        severity: 'hint',
        message: `伏笔「${existing.foreshadowingId}」已在第 ${existing.resolvedChapter ?? '?'} 章回收，本章重复回收`,
        ref: existing.foreshadowingId
      })
    } else if (!exact) {
      // ② id 漂移：表述不同但共享物名词 → 按同一伏笔回收（附提示，不误报 unplanted）
      issues.push({
        category: 'foreshadow_id_drift',
        severity: 'hint',
        message: `伏笔「${resolved.id}」与账本「${existing.foreshadowingId}」物名相近，按同一伏笔回收（id 漂移）`,
        ref: existing.foreshadowingId
      })
    }
  }

  // 过期待回收提醒：有 payoff 计划且已超过当前章仍未回收（且本章未回收）。R4：payoff<=0（LLM 常误填 0）视为无计划。
  for (const f of active) {
    if (f.payoffChapter == null || f.payoffChapter <= 0) continue
    const overdue = f.payoffChapter < input.chapterIndex
    if (!overdue) continue
    const resolvedThisChapter = (foreshadowingDelta.resolved ?? []).some((r) => r.id === f.foreshadowingId)
    if (!resolvedThisChapter) {
      issues.push({
        category: 'foreshadow_overdue',
        severity: 'hint',
        message: `伏笔「${f.foreshadowingId}」计划在第 ${f.payoffChapter} 章回收，当前已到第 ${input.chapterIndex} 章仍未回收`,
        ref: f.foreshadowingId
      })
    }
  }

  return issues
}

/** 两字符串共享的去重汉字数（用于伏笔 id 物名词漂移的保守相似判定）。 */
function sharedHanChars(a: string, b: string): number {
  if (!a || !b) return 0
  const setA = new Set([...a])
  let n = 0
  for (const ch of new Set([...b])) {
    if (setA.has(ch)) n += 1
  }
  return n
}

/** 精确不中时按共享 ≥2 汉字在活跃伏笔中找近似同一伏笔（如 半枚玉佩 vs 半块玉佩 → 共享 玉佩=2）。 */
function fuzzyFind(active: Foreshadowing[], key: string): Foreshadowing | undefined {
  if (!key) return undefined
  return active.find((f) => sharedHanChars(f.foreshadowingId, key) >= 2)
}
