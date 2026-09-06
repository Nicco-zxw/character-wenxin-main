/**
 * P8.4：humanize（去 AI 味润色）「采用门」纯决策（门就绪 · 默认关）。
 *
 * 目的：为 chapter-humanize 步骤提供「是否采用润色结果」的质量门决策——
 * 现状只有长度门（humanized > source*0.5 即采用），无质量判定；
 * 本模块补一层可选「LLM 单次复审」（llmJudgeOnce：是否较原文有改进且未改剧情/信息量），
 * 由 HUMANIZE_REFLECT 开关控制（默认 false = 与现状一致，只走长度门）。
 *
 * 设计定位：纯函数 + 常量，渲染层/主进程可共用、node --test 可单测；
 * 接线点（useChapterFirstDraft 的 humanize 步骤内，润色文本过长度门后再判）留到
 * 启用 HUMANIZE_REFLECT 时接入（真机验证质量后再开，可回退）。
 */

/** 开关：是否启用 LLM 单次复审作为 humanize 采用门（默认关=现状行为）。 */
export const HUMANIZE_REFLECT = false

/** LLM 复审达标分（低于则判定为过度改写/改剧情，不采用）。 */
export const HUMANIZE_JUDGE_PASS_SCORE = 70

/** 对齐渲染层现状的长度门：humanized.length > source.length * ratio 才可能采用。 */
export const HUMANIZE_MIN_RATIO = 0.5

export type HumanizeRejectReason =
  | 'kept'
  | 'empty'
  | 'unchanged'
  | 'length-gate-failed'
  | 'judge-below-threshold'

export interface HumanizeDecisionInput {
  /** 润色前的正文（源）。 */
  source: string
  /** 润色结果（候选）。 */
  humanized: string
  /** LLM 单次复审分 0-100（llmJudgeOnce）；HUMANIZE_REFLECT=false 时忽略。 */
  judgeScore?: number
}

export interface HumanizeDecision {
  adopt: boolean
  reason: HumanizeRejectReason
}

/**
 * 判定是否采用润色结果。
 * 顺序：空/未变 → 长度门 →（开关开时）LLM 复审分 → 采用。
 * HUMANIZE_REFLECT=false（默认）→ 行为与现状一致（仅长度门）。
 */
export function decideHumanizeAdopt(input: HumanizeDecisionInput): HumanizeDecision {
  const source = (input.source ?? '').trim()
  const humanized = (input.humanized ?? '').trim()

  if (!source || !humanized) return { adopt: false, reason: 'empty' }
  if (humanized === source) return { adopt: false, reason: 'unchanged' }
  if (humanized.length <= source.length * HUMANIZE_MIN_RATIO) {
    return { adopt: false, reason: 'length-gate-failed' }
  }
  if (HUMANIZE_REFLECT && input.judgeScore != null && input.judgeScore < HUMANIZE_JUDGE_PASS_SCORE) {
    return { adopt: false, reason: 'judge-below-threshold' }
  }
  return { adopt: true, reason: 'kept' }
}
