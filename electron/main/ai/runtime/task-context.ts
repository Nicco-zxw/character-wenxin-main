import type { AiTaskPayload, AppSettings } from '../shared-types'
import { ensureWorkspaceDb } from '../../workspace-store'
import { buildStoryStateContext, formatStoryStateForPrompt } from '../../story-state-store'
import { retrieveHybridContext, formatSemanticSegmentsForPrompt } from '../knowledge-retrieval'

/**
 * 在任务执行前补全生成上下文：
 * - chapter-first-draft / chapter-assistant / chapter-analysis / chapter-scene-plan 注入故事状态块与语义片段
 * - story-deep-audit 注入故事状态块
 *
 * 失败时静默跳过，不阻塞主流程。
 */
export async function enrichTaskContextForGeneration(
  task: AiTaskPayload,
  settings: AppSettings
): Promise<void> {
  const projectId = String(task.context.projectId ?? '').trim()
  if (!projectId) {
    return
  }

  if (
    task.task === 'chapter-first-draft' ||
    task.task === 'chapter-assistant' ||
    task.task === 'chapter-analysis' ||
    task.task === 'chapter-scene-plan'
  ) {
    try {
      const hybrid = await retrieveHybridContext(task, settings)
      if (!hybrid) {
        return
      }
      if (hybrid.storyStateBlock) {
        task.context.storyStateBlock = hybrid.storyStateBlock
      } else {
        delete task.context.storyStateBlock
      }
      const semanticBlock = formatSemanticSegmentsForPrompt(hybrid.semanticSegments)
      if (semanticBlock) {
        task.context.semanticSegmentsBlock = semanticBlock
      } else {
        delete task.context.semanticSegmentsBlock
      }
    } catch {
      // 混合检索失败不阻塞生成
    }
    return
  }

  if (task.task !== 'story-deep-audit') {
    return
  }

  try {
    const db = await ensureWorkspaceDb()
    const involvedCharIds = extractInvolvedCharacterIds(task.context)
    const storyState = buildStoryStateContext(db, projectId, involvedCharIds)
    const storyStateBlock = formatStoryStateForPrompt(storyState)
    if (storyStateBlock) {
      task.context.storyStateBlock = storyStateBlock
    }
  } catch {
    // 状态库查询失败不阻塞生成
  }
}

function extractInvolvedCharacterIds(context: Record<string, unknown>): string[] {
  const ids: string[] = []
  const characters = context.characters
  if (!Array.isArray(characters)) {
    return ids
  }

  for (const char of characters) {
    if (char && typeof char === 'object' && 'id' in char) {
      ids.push(String((char as { id: string }).id))
    }
  }

  return ids
}
