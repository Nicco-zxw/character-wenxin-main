import type { AiTaskResult, ContinuationImportAggregateResult } from '../shared-types'
import type { PromptBuildInput, TaskHandler } from './base'
import { extractJsonObject, jsonStringField } from './base'

const handler: TaskHandler = {
  name: 'continuation-import-aggregate',
  outputType: 'json',
  useSkills: false,
  defaultCapabilities: ['settings', 'analysis', 'characters', 'relations', 'outline', 'worldview'],
  buildPrompt(input: PromptBuildInput) {
    const { context, capabilityPreamble } = input
    return {
      system: `${capabilityPreamble.system}\n\n你是小说续写项目的资料整理助手。只基于章节分析汇总事实，只返回 JSON，不要续写正文。`,
      user: `${capabilityPreamble.user}\n\n作品：${String(context.projectTitle ?? '')}\n题材：${String(context.projectGenre ?? '')}\n需要人物、关系与势力：${Boolean(context.includeCharacters)}\n需要世界观：${Boolean(context.includeWorldview)}\n需要大纲：${Boolean(context.includeOutline)}\n章节分析：\n${JSON.stringify(context.chapterAnalyses ?? [])}\n\n要求：\n1. bookSummary 概括已有剧情，不预测后续。\n2. continuationStatus 说明最后剧情位置、核心角色当前状态、主要冲突。\n3. pendingHooks 只保留尚未解决且有来源依据的悬念，并尽量原样保留章节分析中的 hook 文本。\n4. characters 合并同名角色，输出核心人物；未要求人物时返回空数组。\n5. relationships 只输出 characters 中人物之间有明确证据的关系，intensity 为 0-100；未要求人物时返回空数组。\n6. organizations 只输出原文明确存在的组织或势力，members 只关联 characters 中的人物；未要求人物时返回空数组。\n7. worldviewEntries 按地理、法则、物种、势力、历史等分类整理明确设定；未要求世界观时返回空数组。\n8. volumeSummaries 按输入中的 volumeTitle 聚合；未要求大纲时返回空数组。\n9. 不确定的内容不要编造。\n\n返回格式：{"bookSummary":"","continuationStatus":"","pendingHooks":[""],"characters":[{"name":"","role":"","description":"","tags":[""]}],"worldviewEntries":[{"type":"","title":"","content":""}],"organizations":[{"name":"","type":"","description":"","motto":"","members":[{"name":"","role":"","notes":""}]}],"relationships":[{"fromCharacter":"","toCharacter":"","type":"","description":"","intensity":50}],"volumeSummaries":[{"title":"","summary":""}]}`
    }
  },
  normalize(raw: string): AiTaskResult {
    const parsed = extractJsonObject(raw)
    const characters = Array.isArray(parsed.characters)
      ? parsed.characters.map((value) => {
          const item = value && typeof value === 'object' ? value as Record<string, unknown> : {}
          return {
            name: jsonStringField(item.name),
            role: jsonStringField(item.role),
            description: jsonStringField(item.description),
            tags: Array.isArray(item.tags) ? item.tags.map((tag) => jsonStringField(tag)).filter(Boolean).slice(0, 4) : []
          }
        }).filter((item) => item.name && item.description)
      : []
    const volumeSummaries = Array.isArray(parsed.volumeSummaries)
      ? parsed.volumeSummaries.map((value) => {
          const item = value && typeof value === 'object' ? value as Record<string, unknown> : {}
          return { title: jsonStringField(item.title), summary: jsonStringField(item.summary) }
        }).filter((item) => item.title && item.summary)
      : []
    const worldviewEntries = Array.isArray(parsed.worldviewEntries)
      ? parsed.worldviewEntries.map((value) => {
          const item = value && typeof value === 'object' ? value as Record<string, unknown> : {}
          return {
            type: jsonStringField(item.type) || '其他',
            title: jsonStringField(item.title),
            content: jsonStringField(item.content)
          }
        }).filter((item) => item.title && item.content)
      : []
    const organizations = Array.isArray(parsed.organizations)
      ? parsed.organizations.map((value) => {
          const item = value && typeof value === 'object' ? value as Record<string, unknown> : {}
          const members = Array.isArray(item.members)
            ? item.members.map((memberValue) => {
                const member = memberValue && typeof memberValue === 'object'
                  ? memberValue as Record<string, unknown>
                  : {}
                return {
                  name: jsonStringField(member.name),
                  role: jsonStringField(member.role),
                  notes: jsonStringField(member.notes)
                }
              }).filter((member) => member.name)
            : []
          return {
            name: jsonStringField(item.name),
            type: jsonStringField(item.type) || '其他势力',
            description: jsonStringField(item.description),
            motto: jsonStringField(item.motto),
            members
          }
        }).filter((item) => item.name && item.description)
      : []
    const relationships = Array.isArray(parsed.relationships)
      ? parsed.relationships.map((value) => {
          const item = value && typeof value === 'object' ? value as Record<string, unknown> : {}
          const rawIntensity = Number(item.intensity)
          return {
            fromCharacter: jsonStringField(item.fromCharacter),
            toCharacter: jsonStringField(item.toCharacter),
            type: jsonStringField(item.type) || '关联',
            description: jsonStringField(item.description),
            intensity: Number.isFinite(rawIntensity) ? Math.min(100, Math.max(0, rawIntensity)) : 50
          }
        }).filter((item) => item.fromCharacter && item.toCharacter && item.description)
      : []
    return {
      bookSummary: jsonStringField(parsed.bookSummary),
      continuationStatus: jsonStringField(parsed.continuationStatus),
      pendingHooks: Array.isArray(parsed.pendingHooks)
        ? parsed.pendingHooks.map((hook) => jsonStringField(hook)).filter(Boolean).slice(0, 30)
        : [],
      characters,
      worldviewEntries,
      organizations,
      relationships,
      volumeSummaries
    } as ContinuationImportAggregateResult
  },
  validate(result: AiTaskResult): boolean {
    const value = result as ContinuationImportAggregateResult
    return Boolean(value.bookSummary && value.continuationStatus)
  },
  resolveMaxTokens(): number {
    return 8000
  }
}

export default handler
