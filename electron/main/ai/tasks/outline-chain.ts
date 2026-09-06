import type { TaskHandler, PromptBuildInput } from './base'
import { extractJsonObject } from './base'
import type { AiTaskResult, OutlineBatchResult } from '../shared-types'
import { resolveWritingStyleInstruction } from '../prompts/shared'
import { normalizeOutline } from './outline-item'

/** 剧情链规划任务：基于当前章节规划 2-4 个后续大纲节点 */
const handler: TaskHandler = {
  name: 'outline-chain',
  outputType: 'json',
  defaultCapabilities: ['settings', 'outline', 'chapters', 'worldview', 'characters', 'relations', 'writing-style', 'project-skills'],
  buildPrompt(input: PromptBuildInput) {
    const { context, capabilityPreamble, skillsBlock } = input
    const writingStyle = resolveWritingStyleInstruction(context)
    return {
      system: `${capabilityPreamble.system}\n\n你是小说剧情链规划助手。请只返回 JSON 对象，不要返回 Markdown。字段必须包含 entries，entries 中每项都必须包含 title、wordTarget、conflict、summary。`,
      user: `${capabilityPreamble.user}\n\n请基于以下上下文，为当前章节之后连续规划 2 到 4 个后续剧情大纲节点。\n\n项目标题：${String(context.projectTitle ?? '')}\n项目题材：${String(context.projectGenre ?? '')}\n当前分卷：${String(context.chapterVolumeTitle ?? '')}\n当前分卷摘要：${String(context.chapterVolumeSummary ?? '')}\n当前章节标题：${String(context.chapterTitle ?? '')}\n当前章节摘要：${String(context.chapterSummary ?? '')}\n当前章节状态：${String(context.chapterStatus ?? '')}\n当前章节正文：\n${String(context.chapterContent ?? '')}\n当前关联大纲节点：${JSON.stringify(context.currentOutlineItem ?? {})}\n当前分卷已有节点：${JSON.stringify(context.currentVolumeOutlineItems ?? [])}\n世界观关键词：${JSON.stringify(context.worldviewTitles ?? [])}\n角色参考：${JSON.stringify(context.characters ?? [])}\n当前项目启用 skills：\n${skillsBlock || '暂无'}\n补充要求：${String(context.userPrompt ?? '')}\n\n要求：\n1. entries 返回 2 到 4 个后续节点，必须严格体现"当前章节之后"的连续推进\n2. 第一条要紧贴当前章节收束后的直接后果\n3. 后续条目之间要形成递进\n4. ${writingStyle}\n\n返回格式：{"entries":[{"title":"","wordTarget":"","conflict":"","summary":""}]}`
    }
  },
  normalize(raw: string): AiTaskResult {
    const parsed = extractJsonObject(raw) as Partial<OutlineBatchResult>
    const entries = Array.isArray(parsed.entries) ? parsed.entries.slice(0, 5).map((e) => normalizeOutline(e as Record<string, unknown>)) : []
    return { entries } as OutlineBatchResult
  },
  validate(result: AiTaskResult): boolean {
    return (result as OutlineBatchResult).entries.length > 0
  }
}
export default handler
