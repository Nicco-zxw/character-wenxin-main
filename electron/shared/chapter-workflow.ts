/**
 * P8.8：单章「规划-写-审-改-结算」闭环 —— 纯编排核心（共享，单一决策源）。
 *
 * 由 P8.2 的 `electron/main/ai/chapter-workflow/{types,runner}` 收敛到 `electron/shared/`，
 * 让 渲染层（六步流式路径）与 未来主进程 chapter-workflow 协调器 **共用同一套决策**：
 *   - 六步顺序 / 默认步骤配置 / 审计分支（shouldRepairAfterAudit）/ 修复与润色长度门
 *     （replacementAccepted）/ 复审开关（RE_AUDIT_AFTER_REPAIR）/
 *     runChapterWorkflow 纯顺序器（执行器注入、裁决内聚）。
 * 语义逐条对齐渲染层 `useChapterFirstDraft`（audit 仅在 memo 已产出时执行、draft stop
 * 中止、session-note 收尾），避免「协调器 vs 渲染层六步」语义分叉。
 *
 * 本文件为**纯函数 + 纯类型**（仅 type 依赖 `./agent-profiles`，无运行 value import），
 * 三端（main/preload/renderer）均可 import（@shared），node --test 可直引单测。
 */
import type { AgentProfile, ChapterAgentRole } from './agent-profiles'

// ── 类型 ──
/** 单章闭环步骤 = 六角色（与渲染层六步 / ChapterAgentRole 一一对应）。 */
export type ChapterWorkflowStepId = ChapterAgentRole

/** 单步失败策略：skip=记录后跳过继续；stop=中止整个工作流。 */
export type ChapterFailurePolicy = 'skip' | 'stop'

/** 单步配置（对齐渲染层 FirstDraftStepConfig 语义）。 */
export interface ChapterWorkflowStepConfig {
  readonly id: ChapterWorkflowStepId
  readonly enabled: boolean
  readonly failurePolicy: ChapterFailurePolicy
  /** 该步 userPrompt 补充（透传给执行器上下文，可选）。 */
  readonly userPrompt?: string
}

export type ChapterWorkflowStepConfigMap = Partial<Record<ChapterWorkflowStepId, ChapterWorkflowStepConfig>>

/** 审计问题最小结构（对齐渲染层 ChapterAuditPayload 判定所需字段）。 */
export interface WorkflowAuditIssue {
  readonly severity: 'critical' | 'warning' | 'hint'
  readonly category?: string
  readonly hint?: string
}

/** 审计结果最小结构（判定 repair 是否需要 / 复审收敛）。 */
export interface WorkflowAuditResult {
  readonly pass: boolean
  readonly issues: ReadonlyArray<WorkflowAuditIssue>
}

/** 单步执行产出（由调用方注入的 executor 提供）。 */
export interface WorkflowStepOutput {
  readonly ok: boolean
  readonly error?: string
  /** 文本类产出（draft/repair/humanize）。 */
  readonly text?: string
  /** 结构化产出（memo / audit / session-note 解析结果）。 */
  readonly structured?: WorkflowAuditResult | Record<string, unknown>
}

/** 步骤间共享工作态（memo→draft→audit→repair→humanize→session-note 传递）。 */
export interface WorkflowWorkingState {
  memo?: Record<string, unknown>
  draftText?: string
  finalText?: string
  audit?: WorkflowAuditResult
  repairedText?: string
  humanizedText?: string
}

/** 单步运行记录（summary 审计 / UI 展示）。 */
export interface WorkflowStepRun {
  readonly id: ChapterWorkflowStepId
  readonly status: 'ran' | 'skipped' | 'error' | 'aborted'
  readonly error?: string
}

/** 注入的步骤执行器：真实接线时为「TaskHandler 流式/非流式执行」，单测时用桩。 */
export type WorkflowStepExecutor = (
  step: ChapterWorkflowStepConfig,
  state: WorkflowWorkingState,
  profile: AgentProfile | undefined
) => Promise<WorkflowStepOutput>

export interface ChapterWorkflowRunInput {
  /** 单步覆盖配置（缺省用 DEFAULT_CHAPTER_WORKFLOW_STEPS）。 */
  readonly steps?: ChapterWorkflowStepConfigMap
  /** 每步差异化 AgentProfile（透传 executor；由接线方从 AgentProfileMap 提取）。 */
  readonly profiles?: Partial<Record<ChapterWorkflowStepId, AgentProfile>>
  /** repair 后是否复审（默认关，见 RE_AUDIT_AFTER_REPAIR）。 */
  readonly reAuditAfterRepair?: boolean
  /** 修复文本采用的最小长度比（默认 0.5，与渲染层现状一致）。 */
  readonly repairMinRatio?: number
  /** 润色文本采用的最小长度比（默认 0.5）。 */
  readonly humanizeMinRatio?: number
}

/** 工作流最终汇总（记账/UI 消费）。 */
export interface ChapterWorkflowSummary {
  readonly steps: ReadonlyArray<WorkflowStepRun>
  readonly ok: boolean
  readonly aborted?: boolean
  readonly finalText?: string
  readonly memo?: Record<string, unknown>
  readonly audit?: WorkflowAuditResult
  readonly repairTriggered: boolean
  readonly reAudited: boolean
  readonly failureStep?: ChapterWorkflowStepId
}

// ── 常量与决策 ──
/** 六步规范顺序（与渲染层 / 设计文档一致）。 */
export const CHAPTER_WORKFLOW_ORDER: ReadonlyArray<ChapterWorkflowStepId> = [
  'memo',
  'draft',
  'audit',
  'repair',
  'humanize',
  'session-note'
]

/** 默认步骤配置（与渲染层默认一致）：draft 必需(stop)；humanize 默认关；其余默认开(skip)。 */
export const DEFAULT_CHAPTER_WORKFLOW_STEPS: Readonly<Record<ChapterWorkflowStepId, ChapterWorkflowStepConfig>> = {
  memo: { id: 'memo', enabled: true, failurePolicy: 'skip' },
  draft: { id: 'draft', enabled: true, failurePolicy: 'stop' },
  audit: { id: 'audit', enabled: true, failurePolicy: 'skip' },
  repair: { id: 'repair', enabled: true, failurePolicy: 'skip' },
  humanize: { id: 'humanize', enabled: false, failurePolicy: 'skip' },
  'session-note': { id: 'session-note', enabled: true, failurePolicy: 'skip' }
}

/** 修复/润色文本采用的最小长度比（渲染层现状 hardcode 0.5）。 */
export const DEFAULT_REPAIR_MIN_RATIO = 0.5
export const DEFAULT_HUMANIZE_MIN_RATIO = 0.5

/** 复审开关：repair 后是否再审计一次（默认关=保守；真机验证后置 true，可回退）。 */
export const RE_AUDIT_AFTER_REPAIR = false

/** 由规范顺序 + 覆盖项合并出实际步骤配置（纯函数）。 */
export function resolveWorkflowSteps(
  overrides: ChapterWorkflowStepConfigMap | undefined
): ReadonlyArray<ChapterWorkflowStepConfig> {
  return CHAPTER_WORKFLOW_ORDER.map((id) => {
    const base = DEFAULT_CHAPTER_WORKFLOW_STEPS[id]
    const o = overrides?.[id]
    return {
      id,
      enabled: o?.enabled ?? base.enabled,
      failurePolicy: o?.failurePolicy ?? base.failurePolicy,
      userPrompt: o?.userPrompt
    }
  })
}

/** critical 问题计数。 */
export function countCriticalIssues(audit: WorkflowAuditResult | undefined): number {
  if (!audit) return 0
  return audit.issues.reduce((n, i) => n + (i.severity === 'critical' ? 1 : 0), 0)
}

/** 是否触发修复：audit 存在 && !pass && critical>0（渲染层现状判定）。 */
export function shouldRepairAfterAudit(audit: WorkflowAuditResult | undefined): boolean {
  if (!audit) return false
  return !audit.pass && countCriticalIssues(audit) > 0
}

/** 候选文本是否替换当前正文：长度门 `candidate.length > original.length*minRatio`（渲染层现状）。 */
export function replacementAccepted(
  candidate: string | undefined,
  original: string | undefined,
  minRatio = DEFAULT_REPAIR_MIN_RATIO
): boolean {
  if (!candidate || !original) return false
  return candidate.length > original.length * minRatio
}

/** 类型守卫：结构化结果是否为审计结果。 */
export function isAuditResult(value: unknown): value is WorkflowAuditResult {
  if (!value || typeof value !== 'object') return false
  const v = value as { pass?: unknown; issues?: unknown }
  return typeof v.pass === 'boolean' && Array.isArray(v.issues)
}

// ── 纯顺序器 ──
/**
 * 运行单章闭环（纯顺序器）。
 * @param execute 注入的步骤执行器（真实接线：TaskHandler；单测：桩）
 * @param input 步骤覆盖 / 每步 profile / 复审与门阈值
 */
export async function runChapterWorkflow(
  execute: (
    step: ChapterWorkflowStepConfig,
    state: WorkflowWorkingState,
    profile: AgentProfile | undefined
  ) => Promise<WorkflowStepOutput>,
  input: ChapterWorkflowRunInput = {}
): Promise<ChapterWorkflowSummary> {
  const steps = resolveWorkflowSteps(input.steps)
  const stepOf = (id: ChapterWorkflowStepId): ChapterWorkflowStepConfig =>
    steps.find((s) => s.id === id) as ChapterWorkflowStepConfig
  const runs: WorkflowStepRun[] = []
  const state: WorkflowWorkingState = {}
  let aborted = false
  let failureStep: ChapterWorkflowStepId | undefined
  let repairTriggered = false
  let reAudited = false

  const runOne = async (id: ChapterWorkflowStepId): Promise<WorkflowStepOutput | undefined> => {
    const step = stepOf(id)
    if (!step.enabled) {
      runs.push({ id, status: 'skipped' })
      return undefined
    }
    let out: WorkflowStepOutput
    try {
      out = await execute(step, state, input.profiles?.[id])
    } catch (error) {
      out = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (!out.ok) {
      const stopping = step.failurePolicy === 'stop'
      runs.push({ id, status: stopping ? 'aborted' : 'error', error: out.error })
      if (stopping) {
        aborted = true
        failureStep = id
      }
      return undefined
    }
    runs.push({ id, status: 'ran' })
    return out
  }

  // 1) memo（规划硬契约）：缺省可 skip；产出结构化 memo 供 audit 门使用
  const memoOut = await runOne('memo')
  if (!aborted && memoOut?.structured && typeof memoOut.structured === 'object') {
    state.memo = memoOut.structured as Record<string, unknown>
  }

  // 2) draft（写初稿）：必需（stop）；空正文视为无内容管线
  const draftOut = aborted ? undefined : await runOne('draft')
  if (aborted) return finish()
  if (draftOut?.text) {
    state.draftText = draftOut.text
    state.finalText = draftOut.text
  }
  const hasContent = Boolean(state.draftText)

  // 3) audit（审）：仅当 启用 && 已有 memo && 有正文（渲染层现状：audit 依赖 chapterMemo）
  const auditWanted = hasContent && stepOf('audit').enabled && Boolean(state.memo)
  if (!auditWanted && hasContent && stepOf('audit').enabled) {
    runs.push({ id: 'audit', status: 'skipped' }) // 无 memo → 无可审（记录 skipped 便于审计）
  }
  if (auditWanted) {
    const auditOut = await runOne('audit')
    if (!aborted && auditOut?.structured && isAuditResult(auditOut.structured)) {
      state.audit = auditOut.structured
    }
  }

  // 4) repair（改）：audit 判定需修才触发；长度门通过才替换最终正文
  if (!aborted && hasContent && state.audit && shouldRepairAfterAudit(state.audit)) {
    const repairOut = await runOne('repair')
    if (!aborted && repairOut?.text && replacementAccepted(repairOut.text, state.finalText ?? '', input.repairMinRatio)) {
      state.finalText = repairOut.text
      state.repairedText = repairOut.text
      repairTriggered = true
      const wantReAudit = input.reAuditAfterRepair ?? RE_AUDIT_AFTER_REPAIR
      if (wantReAudit) {
        const reOut = await runOne('audit')
        if (!aborted && reOut?.structured && isAuditResult(reOut.structured)) {
          state.audit = reOut.structured
        }
        reAudited = true
      }
    }
  }

  // 5) humanize（去 AI 味，默认关）：长度门通过才替换
  if (!aborted && hasContent && stepOf('humanize').enabled) {
    const humOut = await runOne('humanize')
    if (!aborted && humOut?.text && replacementAccepted(humOut.text, state.finalText ?? '', input.humanizeMinRatio)) {
      state.finalText = humOut.text
      state.humanizedText = humOut.text
    }
  }

  // 6) session-note（写作日志）：最终正文落定后执行（渲染层现状）
  if (!aborted && hasContent && stepOf('session-note').enabled) {
    await runOne('session-note')
  }

  return finish()

  function finish(): ChapterWorkflowSummary {
    return {
      steps: runs,
      ok: !aborted,
      aborted: aborted || undefined,
      finalText: state.finalText,
      memo: state.memo,
      audit: state.audit,
      repairTriggered,
      reAudited,
      failureStep: failureStep || undefined
    }
  }
}
