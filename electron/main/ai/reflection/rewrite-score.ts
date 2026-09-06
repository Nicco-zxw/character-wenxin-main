/**
 * P8.3：局部改写「退化门」打分（纯函数，无 LLM 依赖，成本为零）。
 *
 * 反思式改写（runReflectiveRewrite）用它做 evaluate：只要输出「实质改动、未截断、
 * 未过度膨胀」就判定达标（高分、首轮收敛），仅当出现退化输出（空 / 与原文相同 /
 * 疑似截断 / 疑似叠解释）才返回低分并触发下一轮带 critique 重做（默认最多 2 轮）。
 *
 * 语义定位：这是**形态/退化门**而非语义质量裁判——真正的质量由「作者在环」在
 * 预览确认时把关（重写选中/润色选中均需人工确认后替换），故刻意不引入 LLM 自评成本。
 */
export interface RewriteScore {
  /** 0-100 */
  score: number
  /** 未达标时注入下一轮的批评/改进意见（中文） */
  critique: string
}

/** 疑似截断：候选长度不足原文比例阈值。 */
const MIN_LENGTH_RATIO = 0.15
/** 疑似叠解释/复述：候选长度超过原文比例阈值。 */
const MAX_LENGTH_RATIO = 6

/**
 * 对一次改写输出打分（source=原文，candidate=改写候选）。
 * 规则：空输出 0；与原文完全相同 20；过短（<0.15×）25；过长（>6×）45；否则 88。
 */
export function scoreRewriteText(source: string, candidate: string): RewriteScore {
  const src = (source ?? '').trim()
  const cand = (candidate ?? '').trim()

  if (!cand) {
    return { score: 0, critique: '输出为空。请基于改写要求实际改写，并只输出改写后的完整文本。' }
  }
  if (cand === src) {
    return { score: 20, critique: '输出与原文完全相同，未发生任何改写。请真正修改表达/节奏/动作层次，保留剧情事实与专有名词，并只输出改写后的文本。' }
  }

  const srcLen = Math.max(src.length, 1)
  const ratio = cand.length / srcLen
  if (ratio < MIN_LENGTH_RATIO) {
    return { score: 25, critique: '输出过短（疑似截断或被缩成摘要）。请保留剧情信息量与专有名词，输出完整的改写文本。' }
  }
  if (ratio > MAX_LENGTH_RATIO) {
    return { score: 45, critique: '输出过长（疑似叠加大段解释或复述原文）。请只输出改写后的正文，不要解释、不要复述、不要加前后缀。' }
  }
  return { score: 88, critique: '已实质改写且形态合理，满足输出要求。' }
}
