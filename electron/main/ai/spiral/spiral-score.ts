/**
 * P8.4：spiral「validate→redo」回喂决策打分（纯函数，无 LLM 依赖，可单测）。
 *
 * 把 spiral-validate 的三维校验结论映射为 0-100 分与中文 critique：
 *   - 主线弧光不完整（arcValidation.isComplete=false） → -30，附 gaps；
 *   - 情节因果链断裂（plotCausalChain.isSound=false）     → -30，附 breaks；
 *   - 设定不一致（settingConsistency.isConsistent=false） → -30，附 contradictions。
 * 未达标时 critique 作为 feedback 注入下一轮 spiral-expand（redo 回喂）。
 */
import type { SpiralValidateResult } from './types'

export interface SpiralScore {
  /** 0-100 */
  score: number
  /** 未达标时注入下一轮扩写的批评/改进意见（中文） */
  critique: string
}

/** 每个校验维度扣分。 */
const DIMENSION_PENALTY = 30
/** critique 中每类最多列出的问题数（防超长）。 */
const MAX_LISTED = 3

/** P8.4 回喂轮数默认值：0 = 关（沿用旧「单次 expand→validate」行为）。 */
export const SPIRAL_REDO_ROUNDS = 0
/** P8.4 回喂达标分（scoreSpiralValidate ≥ 该值即不再重做）。 */
export const SPIRAL_REDO_PASS_SCORE = 80

const clampScore = (n: number): number => Math.max(0, Math.min(100, n))

/** 解析为校验对象，容错 undefined/异常结构。 */
function asValidate(value: unknown): SpiralValidateResult | null {
  if (!value || typeof value !== 'object') return null
  return value as SpiralValidateResult
}

/** 中文 label 行。 */
function labelLines(items: unknown[] | undefined, label: string): string[] {
  if (!Array.isArray(items) || items.length === 0) return []
  return items.slice(0, MAX_LISTED).map((item) => `- ${label}：${String(item)}`)
}

export function scoreSpiralValidate(value: SpiralValidateResult | unknown): SpiralScore {
  const v = asValidate(value)
  if (!v) return { score: 0, critique: '校验结果缺失或结构异常，请重新校验后扩写。' }

  let score = 100
  const notes: string[] = []

  const arc = v.arcValidation
  if (!arc?.isComplete) {
    score -= DIMENSION_PENALTY
    notes.push('主线弧光存在缺口，需要补全：')
    notes.push(...labelLines(arc?.gaps, '缺口'))
  }
  const causal = v.plotCausalChain
  if (!causal?.isSound) {
    score -= DIMENSION_PENALTY
    notes.push('情节因果链存在断裂，需要理顺：')
    notes.push(...labelLines(causal?.breaks, '断裂'))
  }
  const setting = v.settingConsistency
  if (!setting?.isConsistent) {
    score -= DIMENSION_PENALTY
    notes.push('设定存在不一致，需要统一：')
    notes.push(...labelLines(setting?.contradictions, '矛盾'))
  }

  score = clampScore(score)
  if (notes.length === 0) {
    return { score: 100, critique: '三圈校验通过（弧光完整 / 因果成立 / 设定一致），无需重做。' }
  }
  return {
    score,
    critique: ['上一轮校验发现问题，请修正后重新扩写：', ...notes].join('\n')
  }
}
