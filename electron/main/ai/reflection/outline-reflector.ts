/**
 * P6.3.2：把反思回路接到「章纲批量生成 outline-batch」。
 *
 * 每轮 act = 以同一 context 重跑 outline-batch，并把上一轮 critique 拼进 context.userPrompt
 * （outline-batch 的 buildPrompt 会把 userPrompt 注入为「补充要求」）；evaluate = 轻量打分
 * `scoreOutlineEntries`；未达 passScore 则带 critique 重做，最多 maxIterations 轮。
 * 副作用留在渲染层落库（本函数只产出收敛那轮的 entries + 迭代审计）。
 */
import type { AppSettings, AiTaskPayload } from '../shared-types'
import { runAiTask } from '../runtime/orchestrator'
import { runReflectiveLoop } from './reflection-loop'
import { scoreOutlineEntries } from './outline-score'
import type { OutlineBatchEntryLike } from './outline-score'

export interface ReflectiveOutlineInput {
  settings: AppSettings
  /** 渲染层为 outline-batch 构造的完整 context（含 volumes/outlineItems/currentVolumeOutlineItems 等） */
  context: Record<string, unknown>
  maxIterations?: number
  passScore?: number
  signal?: AbortSignal
}

export interface ReflectiveOutlineResult {
  entries: OutlineBatchEntryLike[]
  iterations: number
  passed: boolean
}

export async function runReflectiveOutlineBatch(
  input: ReflectiveOutlineInput
): Promise<ReflectiveOutlineResult> {
  const baseUserPrompt = String(input.context.userPrompt ?? '')
  const result = await runReflectiveLoop({
    initialInput: input.context,
    maxIterations: input.maxIterations ?? 3,
    passScore: input.passScore ?? 75,
    act: async (ctx, feedback) => {
      const payload: AiTaskPayload = {
        task: 'outline-batch',
        settings: input.settings,
        context: {
          ...ctx,
          userPrompt: feedback
            ? `${baseUserPrompt}\n上一轮评审意见（请据此修正/增强本轮章纲）：${feedback}`
            : baseUserPrompt
        }
      }
      const response = await runAiTask(payload, undefined, input.signal)
      const resultObj = response.result as { entries?: unknown }
      return { entries: Array.isArray(resultObj?.entries) ? resultObj.entries : [] }
    },
    evaluate: (output) => scoreOutlineEntries(output.entries)
  })

  const finalOutput = result.final as { entries?: OutlineBatchEntryLike[] }
  return {
    entries: Array.isArray(finalOutput?.entries) ? finalOutput.entries : [],
    iterations: result.iterations,
    passed: result.passed
  }
}
