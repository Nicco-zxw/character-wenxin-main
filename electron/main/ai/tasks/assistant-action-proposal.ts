import type { TaskHandler, PromptBuildInput } from './base'
import { extractJsonObject } from './base'
import type { AiTaskResult, AssistantActionProposalResult } from '../shared-types'

/** 助手动作提议任务：将用户请求转换为单步可确认的写作动作提议 */
const handler: TaskHandler = {
  name: 'assistant-action-proposal',
  outputType: 'json',
  defaultCapabilities: ['settings', 'chapters', 'worldview', 'characters', 'relations', 'outline', 'inspiration', 'writing-style', 'project-skills', 'versioning'],
  buildPrompt(input: PromptBuildInput) {
    const { context, capabilityPreamble, knowledgeBlock } = input
    const retrievalBlock = knowledgeBlock ? `\n\n检索到的项目记忆与参考资料：\n${knowledgeBlock}` : ''
    return {
      system: `${capabilityPreamble.system}\n\n你是小说创作助手的动作提议生成器。请只返回 JSON 对象，不要返回 Markdown、解释或额外文本。你只能从受控动作白名单中选择一个动作。字段必须包含 commandType、target、reason、title、summary、destructive、requiresConfirmation、payload。`,
      user: `${capabilityPreamble.user}\n\n请基于当前小说项目上下文，把用户请求转换成一个单步、可确认的写作动作提议。\n\n允许动作白名单：\n1. insert-into-chapter\n2. update-chapter-title\n3. update-chapter-summary\n4. create-outline-item\n5. append-workflow-document-entry\n6. update-workflow-document\n7. save-knowledge-document\n\n项目标题：${String(context.projectTitle ?? '')}\n项目题材：${String(context.projectGenre ?? '')}\n当前章节标题：${String(context.chapterTitle ?? '')}\n当前章节摘要：${String(context.chapterSummary ?? '')}\n当前章节正文：\n${String(context.chapterContent ?? '')}\n\n当前选中文本：\n${String(context.selectedText ?? '') || '暂无'}\n\n快捷动作：${String(context.quickAction ?? '自由提问')}\n用户请求：${String(context.userPrompt ?? '')}${retrievalBlock}\n\n生成规则：\n1. 一次只允许提议一个动作\n2. 如果是正文写入，payload 必须包含 content 和 mode（cursor/append/replace-selection）\n3. 如果是标题更新，payload 必须包含 value\n4. 如果是摘要更新，payload 必须包含 value\n5. 如果是创建大纲，payload 必须包含至少 title、summary\n6. 对会覆盖已有内容的动作，destructive 必须为 true，requiresConfirmation 必须为 true\n7. title / summary 是给确认卡片展示的短文案\n8. 所有文本均用简体中文\n\n返回格式：{"commandType":"","target":"","reason":"","title":"","summary":"","destructive":false,"requiresConfirmation":true,"payload":{}}`
    }
  },
  normalize(raw: string): AiTaskResult {
    const parsed = extractJsonObject(raw) as Partial<AssistantActionProposalResult>
    const validCommands = ['insert-into-chapter', 'update-chapter-title', 'update-chapter-summary', 'create-outline-item', 'append-workflow-document-entry', 'update-workflow-document', 'save-knowledge-document']
    const validTargets = ['chapter-content', 'chapter-title', 'chapter-summary', 'outline-item', 'workflow-document', 'knowledge-document']
    return {
      commandType: validCommands.includes(parsed.commandType ?? '') ? parsed.commandType! : 'insert-into-chapter',
      target: validTargets.includes(parsed.target ?? '') ? parsed.target! : 'chapter-content',
      reason: String(parsed.reason ?? '').trim() || 'AI 提议执行一个写作动作。',
      title: String(parsed.title ?? '').trim() || '写作动作提议',
      summary: String(parsed.summary ?? '').trim() || '准备执行一个与当前章节相关的写作动作。',
      before: typeof parsed.before === 'string' ? parsed.before.trim() : undefined,
      after: typeof parsed.after === 'string' ? parsed.after.trim() : undefined,
      destructive: Boolean(parsed.destructive),
      requiresConfirmation: parsed.requiresConfirmation !== false,
      payload: parsed.payload && typeof parsed.payload === 'object' ? parsed.payload as Record<string, unknown> : {}
    } as AssistantActionProposalResult
  },
  validate(result: AiTaskResult): boolean {
    const r = result as AssistantActionProposalResult
    return Boolean(r.commandType && r.target && r.reason?.trim() && r.title?.trim() && r.summary?.trim() && r.payload && typeof r.payload === 'object' && Object.keys(r.payload).length > 0)
  }
}
export default handler
