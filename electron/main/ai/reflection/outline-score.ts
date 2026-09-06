/**
 * P6.3.2 outline-batch 结果的轻量自评（纯函数，可单测）。
 * 返回 runReflectiveLoop 所需的 { score(0-100), critique }。
 * 规则聚焦「章纲可写作性」的确定性信号：节点数、标题/冲突/摘要完整、标题重复、字数区间。
 */
import type { ReflectEvaluation } from './reflection-loop'

export interface OutlineBatchEntryLike {
  title?: unknown
  wordTarget?: unknown
  conflict?: unknown
  summary?: unknown
}

export const OUTLINE_WORD_TARGET_MIN = 3000
export const OUTLINE_WORD_TARGET_MAX = 4000

function toText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim()
}

function toNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

export function scoreOutlineEntries(entries: unknown): ReflectEvaluation {
  const list = Array.isArray(entries) ? entries : []
  const issues: string[] = []

  if (list.length === 0) {
    return { score: 0, critique: '未生成任何章纲节点。请检查输入（分卷/已有节点）后重试。' }
  }

  if (list.length < 3) {
    issues.push(`章纲节点偏少（${list.length} 条），建议生成 3-5 条以推进本卷剧情。`)
  }

  const seen = new Set<string>()
  let duplicateCount = 0
  let incompleteCount = 0
  let shortTitleCount = 0
  let wordTargetOffCount = 0

  for (const raw of list) {
    const item = raw != null && typeof raw === 'object' ? raw as OutlineBatchEntryLike : {}
    const title = toText(item.title)
    if (!title) {
      incompleteCount += 1
      continue
    }
    if (title.length < 2) shortTitleCount += 1
    const key = title
    if (seen.has(key)) duplicateCount += 1
    seen.add(key)

    if (!toText(item.summary) || !toText(item.conflict)) incompleteCount += 1

    const wordTarget = toNumber(item.wordTarget)
    if (wordTarget != null && (wordTarget < OUTLINE_WORD_TARGET_MIN || wordTarget > OUTLINE_WORD_TARGET_MAX)) {
      wordTargetOffCount += 1
    }
  }

  if (duplicateCount > 0) issues.push(`存在 ${duplicateCount} 个重复标题的节点，需去重或改名。`)
  if (incompleteCount > 0) issues.push(`有 ${incompleteCount} 个节点缺少标题/冲突/摘要，需补全。`)
  if (shortTitleCount > 0) issues.push(`有 ${shortTitleCount} 个节点标题过短，需更具体。`)
  if (wordTargetOffCount > 0) issues.push(`有 ${wordTargetOffCount} 个节点字数目标超出 ${OUTLINE_WORD_TARGET_MIN}-${OUTLINE_WORD_TARGET_MAX}，请调整。`)

  let score = 100
  score -= duplicateCount * 20
  score -= incompleteCount * 10
  score -= shortTitleCount * 5
  score -= wordTargetOffCount * 5
  if (list.length < 3) score -= 15
  score = Math.max(0, score)

  return { score, critique: issues.length ? issues.join('\n') : '' }
}
