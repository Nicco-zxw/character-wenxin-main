/**
 * P8.9：主进程「章节闭环可执行器」（库 · 未接线，供脚本/评测/未来 agent 复用）。
 *
 * 把 P8.8 收敛到 `electron/shared/chapter-workflow.ts` 的纯编排核心接到**真实 TaskHandler 执行器**，
 * 使单章「规划-写-审-改-结算」闭环可在主进程独立执行一次：
 *   - 执行器每步按 role 调 `runAiTask`（可注入桩便于脚本/测试换真）；
 *   - 步骤 context 由 `electron/shared/chapter-workflow-context` 统一映射（seed 素材 + 工作态）；
 *   - 顺序/裁决（审计分支/长度门/复审）全权交给共享 `runChapterWorkflow`；
 *   - 产物不自动落库/结算（由调用方决定，与隔离原则一致）。
 *
 * 默认门控 `CHAPTER_WORKFLOW_MAIN_ON=false`：不注册 IPC、不接 UI、不改渲染层交互式流式路径。
 * 本文件依赖主进程运行时（orchestrator），故不做 node 单测（纯映射/决策已在 shared 层测试）。
 */
import {
  runChapterWorkflow,
  type ChapterWorkflowRunInput,
  type ChapterWorkflowStepId,
  type ChapterWorkflowSummary,
  type WorkflowStepExecutor,
  type WorkflowStepOutput
} from '../../shared/chapter-workflow'
import { resolveStepSettings, type AgentProfileMap } from '../../shared/agent-profiles'
import { buildChapterStepContext, CHAPTER_STEP_TASKS } from '../../shared/chapter-workflow-context'
import { runAiTask } from './runtime/orchestrator'
import type { AppSettings, AiTaskPayload } from './shared-types'

/** 门：默认不接线（无 IPC/UI）；置 true 仅为将来脚本/agent 入口显式开启。 */
export const CHAPTER_WORKFLOW_MAIN_ON = false

export interface ChapterClosedLoopSeed {
  settings: AppSettings
  /** 调用方提供的本章素材（各 TaskHandler 所需文本/数据；见设计 §5 素材包约定）。 */
  context: Record<string, unknown>
  /** 项目级 Agent 差异化配置（缺省角色回退内置档位）。 */
  profiles?: AgentProfileMap
  /** 步骤覆盖（enable/humanize/failurePolicy 等）。 */
  steps?: ChapterWorkflowRunInput['steps']
  reAuditAfterRepair?: boolean
  repairMinRatio?: number
  humanizeMinRatio?: number
  signal?: AbortSignal
}

/** 可注入的单步任务调用（默认走 runAiTask；桩可替换为确定性实现）。 */
export type ChapterStepTaskRunner = (
  task: string,
  settings: AppSettings,
  context: Record<string, unknown>,
  signal?: AbortSignal
) => Promise<{ ok: boolean; error?: string; text?: string; structured?: unknown }>

/** 默认执行器：真实 TaskHandler（runAiTask）。 */
const DEFAULT_RUNNER: ChapterStepTaskRunner = async (task, settings, context, signal) => {
  const payload: AiTaskPayload = {
    task: task as AiTaskPayload['task'],
    settings,
    context
  }
  try {
    const response = await runAiTask(payload, undefined, signal)
    const result = (response.result ?? {}) as Record<string, unknown>
    const content = typeof result.content === 'string' ? result.content : undefined
    return { ok: true, text: content, structured: response.result }
  } catch (error) {
    signal?.throwIfAborted()
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 从 runAiTask 返回里取「结构化产物」（memo/audit/session-note 为嵌套对象，其余整包）。 */
function structuredForRole(role: ChapterWorkflowStepId, result: unknown): unknown {
  const r = (result ?? {}) as Record<string, unknown>
  if (role === 'memo') return r.memo ?? result
  if (role === 'audit') return r.audit ?? result
  if (role === 'session-note') return r.sessionNote ?? result
  return result
}

/** 构造共享 runChapterWorkflow 需要的步骤执行器（每步按 role 调任务并套用差异化 settings）。 */
export function createChapterClosedLoopExecutor(
  seed: ChapterClosedLoopSeed,
  runTask: ChapterStepTaskRunner = DEFAULT_RUNNER
): WorkflowStepExecutor {
  return async (step, state, _profile) => {
    const role = step.id
    const task = CHAPTER_STEP_TASKS[role]
    // 差异化 settings：全局 →（项目 profiles）→ 内置档位
    const settings = resolveStepSettings(seed.settings, seed.profiles, role)
    const context = buildChapterStepContext(role, seed.context, state)
    const out = await runTask(task, settings, context, seed.signal)
    if (!out.ok) return { ok: false, error: out.error }
    return {
      ok: true,
      text: out.text,
      structured: structuredForRole(role, out.structured) as WorkflowStepOutput['structured']
    }
  }
}

/** 运行一次单章闭环，返回 summary（最终正文/审计/修复/复审/每步运行记录）。 */
export async function runChapterClosedLoop(
  seed: ChapterClosedLoopSeed
): Promise<ChapterWorkflowSummary> {
  const executor = createChapterClosedLoopExecutor(seed)
  return runChapterWorkflow(executor, {
    steps: seed.steps,
    profiles: seed.profiles,
    reAuditAfterRepair: seed.reAuditAfterRepair,
    repairMinRatio: seed.repairMinRatio,
    humanizeMinRatio: seed.humanizeMinRatio
  })
}
