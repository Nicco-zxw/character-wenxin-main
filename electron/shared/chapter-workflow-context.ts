/**
 * P8.9：章节闭环「步骤上下文映射」（纯函数 · 单一映射源）。
 *
 * 交互式六步（渲染层 useChapterFirstDraft）为每步现拼 context；本模块把「工作态 → 各 TaskHandler
 * 步骤 payload 所需字段」的**映射规则收敛为纯函数**，供未来主进程 chapter-workflow runner（脚本/agent/
 * 自动连写）复用，保证两处映射一致、可单测。不触碰 LLM/DB/electron（仅 type 依赖 ./chapter-workflow）。
 */
import type { WorkflowAuditResult, WorkflowWorkingState } from './chapter-workflow'

/** 单章六步角色（与 chapter-workflow 的六步一致）。 */
export type ChapterWorkflowRole =
  | 'memo'
  | 'draft'
  | 'audit'
  | 'repair'
  | 'humanize'
  | 'session-note'

/** 角色 → TaskHandler 任务名。 */
export const CHAPTER_STEP_TASKS: Readonly<Record<ChapterWorkflowRole, string>> = {
  memo: 'chapter-memo',
  draft: 'chapter-first-draft',
  audit: 'chapter-audit',
  repair: 'chapter-repair',
  humanize: 'chapter-humanize',
  'session-note': 'chapter-session-note'
}

/** 提取审计中的 critical 问题（供 repair payload 的 auditIssues）。 */
export function criticalIssuesOf(audit: WorkflowAuditResult | undefined): WorkflowAuditResult['issues'] {
  if (!audit) return []
  return audit.issues.filter((i) => i.severity === 'critical')
}

/** 把结构化 memo 渲染为 repair 可用的纯文本片段（对齐渲染层 formatMemoForRepair）。 */
export function formatMemoForRepairText(memo: Record<string, unknown> | undefined): string {
  if (!memo) return ''
  const parts: string[] = []
  if (typeof memo.currentTask === 'string' && memo.currentTask) parts.push(`任务：${memo.currentTask}`)
  if (typeof memo.emotionArc === 'string' && memo.emotionArc) parts.push(`情绪轨迹：${memo.emotionArc}`)
  if (Array.isArray(memo.payoffs)) {
    const payoffs = memo.payoffs.filter((x) => typeof x === 'string' && x).join('；')
    if (payoffs) parts.push(`兑现：${payoffs}`)
  }
  if (Array.isArray(memo.doNotDo)) {
    const redLines = memo.doNotDo.filter((x) => typeof x === 'string' && x).join('；')
    if (redLines) parts.push(`红线：${redLines}`)
  }
  return parts.join('\n')
}

/** 审计结果的文本摘要（供 session-note 的 auditSummary）。 */
export function auditSummaryText(audit: WorkflowAuditResult | undefined): string {
  if (!audit) return '未审计'
  return audit.pass ? '通过' : `未通过，${audit.issues.length} 个问题`
}

/**
 * 组装某步 TaskHandler 的 payload context：
 * 以 seed 提供的基础素材（base）为底，叠加本步所需的工作态字段（draftText/最终正文/memo/审计等）。
 * 规则尽量对齐渲染层六步（不追求逐字段等价的交互式语义，字段名与渲染层一致）。
 */
export function buildChapterStepContext(
  role: ChapterWorkflowRole,
  base: Record<string, unknown>,
  state: WorkflowWorkingState
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  const finalText = state.finalText ?? state.draftText

  switch (role) {
    case 'memo':
      // memo 所需素材全部来自 seed base（渲染层 memoBaseContext 语义）；无需工作态
      break
    case 'draft':
      if (state.memo) out.chapterMemo = state.memo
      break
    case 'audit':
      if (state.draftText) out.draftText = state.draftText
      if (state.memo) out.chapterMemo = state.memo
      break
    case 'repair':
      if (finalText) out.chapterContent = finalText
      if (state.memo) out.chapterMemoText = formatMemoForRepairText(state.memo)
      out.auditIssues = criticalIssuesOf(state.audit)
      break
    case 'humanize':
      if (finalText) out.sourceText = finalText
      break
    case 'session-note':
      if (state.memo && typeof state.memo.emotionArc === 'string') out.emotionArc = state.memo.emotionArc
      if (finalText) out.endingSnippet = finalText.slice(-200)
      out.auditSummary = auditSummaryText(state.audit)
      out.finalSource = state.repairedText ? '修复稿' : '初稿'
      break
  }
  return out
}

/** 把角色映射为共享 workflow 的步骤 id 字符串（供 runner 层类型收窄用）。 */
export function roleOf(task: string): ChapterWorkflowRole | undefined {
  const entry = Object.entries(CHAPTER_STEP_TASKS).find(([, name]) => name === task)
  return entry ? (entry[0] as ChapterWorkflowRole) : undefined
}
