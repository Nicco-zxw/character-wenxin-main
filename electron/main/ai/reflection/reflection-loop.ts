/**
 * P6.3 反思回路（Reflective Loop）——通用核心（行为默认不接入具体任务）。
 *
 * 语义：act(行动) → evaluate(自评 0-100 + critique) → 未达阈值则把 critique 作为
 * feedback 注入下一轮 act，最多 `maxIterations` 轮（对齐轨道二「行动→自评→反馈注入重做」）。
 * 全量 transcript 随结果返回，供审计/评测（为什么收敛、改了几轮）。
 *
 * 无副作用、无运行时相对依赖；act/evaluate 由调用方提供（可为 LLM 调用），因此可单测。
 */
export interface ReflectEvaluation {
  /** 0-100 自评得分 */
  score: number
  /** 未达标时注入下一轮的批评/改进意见 */
  critique: string
}

export interface ReflectiveStep<TIn, TOut> {
  attempt: number
  input: TIn
  /** 上一轮 critique（首轮为 undefined） */
  feedback: string | undefined
  output: TOut
  score: number
  critique: string
}

export interface ReflectiveRunOptions<TIn, TOut> {
  initialInput: TIn
  /** 最大迭代轮数（默认 4） */
  maxIterations?: number
  /** 通过阈值（默认 80） */
  passScore?: number
  /** 执行一轮行动 */
  act: (input: TIn, feedback?: string) => Promise<TOut>
  /** 对一轮产物自评 */
  evaluate: (output: TOut, attempt: number) => Promise<ReflectEvaluation> | ReflectEvaluation
}

export interface ReflectiveRunResult<TOut> {
  final: TOut
  passed: boolean
  iterations: number
  transcript: Array<ReflectiveStep<unknown, TOut>>
}

function clampScore(score: unknown): number {
  const n = typeof score === 'number' && Number.isFinite(score) ? score : 0
  return Math.max(0, Math.min(100, n))
}

export async function runReflectiveLoop<TIn, TOut>(
  options: ReflectiveRunOptions<TIn, TOut>
): Promise<ReflectiveRunResult<TOut>> {
  const maxIterations = Math.max(1, Math.floor(options.maxIterations ?? 4))
  const passScore = clampScore(options.passScore ?? 80)

  let input: TIn = options.initialInput
  let feedback: string | undefined

  const transcript: Array<ReflectiveStep<unknown, TOut>> = []
  for (let attempt = 1; attempt <= maxIterations; attempt += 1) {
    const output = await options.act(input, feedback)
    const evaluation = await options.evaluate(output, attempt)
    const score = clampScore(evaluation.score)
    const critique = typeof evaluation.critique === 'string' ? evaluation.critique : ''

    transcript.push({ attempt, input, feedback, output, score, critique })

    if (score >= passScore || attempt === maxIterations) {
      return {
        final: output,
        passed: score >= passScore,
        iterations: attempt,
        transcript
      }
    }

    // 未达标 → critique 作为下一轮 feedback
    feedback = critique
  }

  // 不可达（循环必 return），仅为 TS 收口
  throw new Error('reflective loop 异常终止')
}
