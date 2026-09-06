/**
 * P8.5：forecast 采用衔接 —— adoption-memo 纯构造（轨道三→轨道一）。
 *
 * 决策（2026-09-04）：采用分支后生成「下一章建议 memo」，**预填 memo 草稿（作者在环）**
 * 而非自动进上下文；产物只写 forecast 域（不写正史）。
 *
 * 本模块纯函数：把已选分支的走向收敛为下一章 memo 建议（对齐 chapter-memo 语义子集），
 * 并输出可读文本供「预填写作备忘 / 展示 / 复制」。无 LLM、无副作用、可单测。
 */
export interface AdoptionMemo {
  /** 下一章核心任务/走向（作者可改）。 */
  currentTask: string
  /** 剧情钩子/节拍建议。 */
  suggestedHooks: string[]
  /** 注意：风险 / 与作者意图匹配说明。 */
  note: string
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function arr(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : String(item ?? '').trim()))
    .filter(Boolean)
}

/**
 * 从分支记录构建下一章建议 memo（确定性映射，不编造语义）。
 *  - currentTask ← decision || 「沿『title』推进」 || 首个节拍 || 默认；
 *  - suggestedHooks ← 前 2 个节拍（beats，作为下一步候选钩子）；
 *  - note ← risks（每行）+ fit（匹配说明）。
 */
export function buildAdoptionMemoFromBranch(
  branch: Record<string, unknown> | undefined
): AdoptionMemo {
  const title = str(branch?.title)
  const decision = str(branch?.decision)
  const beats = arr(branch?.beats)
  const changes = arr(branch?.changes)
  const risks = arr(branch?.risks)
  const fit = str(branch?.fit)

  const currentTask =
    decision ||
    (title ? `沿「${title}」推进下一章` : '') ||
    beats[0] ||
    '按所选分支继续推进'
  const suggestedHooks = beats.slice(0, 2)

  const noteLines: string[] = []
  if (risks.length > 0) noteLines.push(`风险：${risks.join('；')}`)
  if (changes.length > 0) noteLines.push(`预计世界变化：${changes.join('；')}`)
  if (fit) noteLines.push(`与作者意图匹配：${fit}`)
  if (noteLines.length === 0) noteLines.push('（无额外注意项）')

  return { currentTask, suggestedHooks, note: noteLines.join('\n') }
}

/** 渲染为可读文本（供「预填写作备忘 / 弹窗展示 / 复制」）。 */
export function formatAdoptionMemoText(memo: AdoptionMemo | undefined): string {
  if (!memo) return ''
  const parts: string[] = []
  if (memo.currentTask?.trim()) parts.push(`【核心任务】${memo.currentTask.trim()}`)
  const hooks = Array.isArray(memo.suggestedHooks)
    ? memo.suggestedHooks.map((h) => String(h).trim()).filter(Boolean)
    : []
  if (hooks.length > 0) parts.push(`【钩子/节拍建议】${hooks.join('；')}`)
  if (memo.note?.trim()) parts.push(`【注意】${memo.note.trim()}`)
  return parts.join('\n')
}
