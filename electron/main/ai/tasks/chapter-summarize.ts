import type { TaskHandler, PromptBuildInput } from './base'
import { normalizeAssistantText } from './base'
import type { AiTaskResult, ChapterAssistantResult } from '../shared-types'

/** 章节摘要生成任务：按四维格式（核心事件/信息增量/状态变化/留存悬念）生成结构化摘要 */
const handler: TaskHandler = {
  name: 'chapter-summarize',
  outputType: 'text',
  defaultCapabilities: ['settings', 'chapters', 'analysis'],
  buildPrompt(input: PromptBuildInput) {
    const { context, capabilityPreamble } = input
    return {
      system: `${capabilityPreamble.system}\n\n你是小说章节摘要助手。请按照指定的四维格式输出纯文本摘要，不要输出 Markdown、JSON 或额外解释。`,
      user: `${capabilityPreamble.user}\n\n请为以下章节生成一段结构化摘要。\n\n章节标题：${String(context.chapterTitle ?? '')}\n章节正文：\n${String(context.chapterContent ?? '')}\n\n要求：\n1. 严格按以下四维格式输出，每一维单独一行开头：\n   核心事件：\n   信息增量：\n   状态变化：\n   留存悬念：\n2. 每一维用 1 到 2 句话描述，总字数控制在 80 到 150 字之间\n3. 不要输出"摘要："前缀，直接从"核心事件："开始\n4. 只输出摘要正文，不要解释`
    }
  },
  normalize(raw: string): AiTaskResult {
    return normalizeAssistantText(raw) as AiTaskResult
  },
  validate(result: AiTaskResult): boolean {
    return Boolean((result as ChapterAssistantResult).content?.trim())
  }
}
export default handler
