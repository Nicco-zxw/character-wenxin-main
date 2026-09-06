/**
 * P4.2-3：手动改稿自动结算（Q3 节流）的「决策门」——纯函数、默认关闭。
 *
 * 用途：将来在「章节保存/切章/关闭/导出」等提交点调用；本函数决定这一次是否值得触发
 * 定稿同步结算（settlement:sync 语义），避免每次击键都触发 LLM 结算。
 * 默认 `enabled=false`，由上层在用户显式开启后传 true。
 *
 * 无副作用、无运行时相对依赖（仅 `import type` 可选），可直接被 `node --test` 以 `.ts` 导入。
 */
export type AutoSettleDecision =
  | 'disabled'      // 功能未开启
  | 'not-latest'    // 非最新章节（避免污染其后章节）
  | 'empty'         // 正文过短（< minLength）
  | 'up-to-date'    // 该正文已结算（contentHash 命中）→ 无需
  | 'throttled'     // 距上次自动结算过近（< minIntervalMs）
  | 'proceed'       // 触发一次定稿同步结算

export interface AutoSettleInput {
  /** 总开关（默认关，用户开启后为 true） */
  enabled: boolean
  /** 是否为项目最新章节 */
  isLatest: boolean
  /** 正文字符数（纯文本） */
  length: number
  /** 最小正文字符数，低于则跳过 */
  minLength: number
  /** 本次正文 contentHash */
  contentHash: string
  /** 账本中该章最近一次结算的 contentHash（无记录为 null） */
  lastSettledHash: string | null
  /** 该章最近一次自动结算的时间戳（ms），无记录为 0 */
  lastAutoAtMs: number
  /** 当前时间戳（ms） */
  nowMs: number
  /** 最小自动结算间隔（ms） */
  minIntervalMs: number
}

export function decideAutoSettle(input: AutoSettleInput): AutoSettleDecision {
  if (!input.enabled) return 'disabled'
  if (!input.isLatest) return 'not-latest'
  if (input.length < input.minLength) return 'empty'
  if (input.lastSettledHash != null && input.lastSettledHash === input.contentHash) return 'up-to-date'
  if (input.nowMs - input.lastAutoAtMs < input.minIntervalMs) return 'throttled'
  return 'proceed'
}
