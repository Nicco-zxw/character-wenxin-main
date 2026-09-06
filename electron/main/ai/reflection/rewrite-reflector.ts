/**
 * P8.3：局部改写反射 —— 用反思回路处理「重写选中 / 润色选中」类开放式改写。
 *
 * act = 直连 LLM 单轮改写（对齐 Observer / forecast 直连先例，非 TaskHandler/agent，
 *       不做选区副作用——产物只返回文本，落库/替换选区留给渲染层「作者在环」确认）；
 * evaluate = `rewrite-score` 退化门（无 LLM 成本）；
 * 未达标（空输出 / 与原文相同 / 疑似截断 / 疑似叠解释）→ 把 critique 注入下一轮重做，
 * 默认最多 2 轮（省成本）。产物含迭代审计（几轮 / 是否达标），供 UI 提示与记账。
 */
import type { AppSettings } from '../shared-types'
import { aiGenerateTextWithUsage } from '../generate'
import { runReflectiveLoop } from './reflection-loop'
import { scoreRewriteText } from './rewrite-score'

export interface ReflectiveRewriteInput {
  settings: AppSettings
  /** 待改写的原文（编辑器选段 / 段落）。 */
  sourceText: string
  /** 改写指令（渲染层模板 prompt；缺省用通用高质量改写要求）。 */
  instruction?: string
  /** 最大迭代轮数（默认 2；改写类高频，克制重做）。 */
  maxIterations?: number
  /** 通过阈值（默认 80，对齐退化门 88 达标）。 */
  passScore?: number
  signal?: AbortSignal
}

export interface ReflectiveRewriteResult {
  /** 最终改写文本（可能来自最后一轮；即使未达标也返回供作者人工判断）。 */
  text: string
  iterations: number
  passed: boolean
}

const DEFAULT_INSTRUCTION =
  '请对给定文本做一版高质量改写：保留全部剧情事实、人物语气与专有名词，强化表达、动作层次与情绪推进；只输出改写后的最终文本，不要解释、不要复述原文、不要加任何前后缀。'

const REWRITE_SYSTEM_PROMPT = '你是一名资深中文小说编辑。你负责对给定的文本片段做局部改写，只输出改写后的最终文本。'

export async function runReflectiveRewrite(
  input: ReflectiveRewriteInput
): Promise<ReflectiveRewriteResult> {
  const sourceText = (input.sourceText ?? '').trim()
  if (!sourceText) throw new Error('缺少待改写的原文。')
  const instruction = (input.instruction ?? '').trim() || DEFAULT_INSTRUCTION
  const maxIterations = Math.max(1, Math.floor(input.maxIterations ?? 2))
  const passScore = input.passScore ?? 80

  const result = await runReflectiveLoop({
    initialInput: { sourceText, instruction },
    maxIterations,
    passScore,
    act: async (ctx, feedback) => {
      const parts = [`改写要求：${ctx.instruction}`, '', '## 待改写原文', ctx.sourceText]
      if (feedback) {
        parts.push('', '## 上一轮评审意见（请据此修正后，重新输出完整的改写文本）', feedback)
      }
      const generation = await aiGenerateTextWithUsage(
        input.settings,
        { system: REWRITE_SYSTEM_PROMPT, user: parts.join('\n') },
        4000,
        input.signal,
        { disableReasoning: true }
      )
      return { text: (generation.text ?? '').trim() }
    },
    evaluate: (output) => scoreRewriteText(sourceText, output.text)
  })

  const finalOutput = result.final as { text?: string }
  return {
    text: finalOutput?.text ?? '',
    iterations: result.iterations,
    passed: result.passed
  }
}
