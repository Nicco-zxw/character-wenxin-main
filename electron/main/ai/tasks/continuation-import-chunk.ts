import type { AiTaskResult, ContinuationImportChunkResult } from '../shared-types'
import type { PromptBuildInput, TaskHandler } from './base'
import { extractJsonObject, jsonStringField } from './base'

const handler: TaskHandler = {
  name: 'continuation-import-chunk',
  outputType: 'json',
  useSkills: false,
  defaultCapabilities: ['settings', 'analysis', 'characters', 'outline'],
  buildPrompt(input: PromptBuildInput) {
    const { context, capabilityPreamble } = input
    return {
      system: `${capabilityPreamble.system}\n\n你是小说续写导入分析器。只返回 JSON，不要补写、改写或评价原文。所有结论必须来自输入章节。`,
      user: `${capabilityPreamble.user}\n\n分析以下章节批次：\n${JSON.stringify(context.chapters ?? [])}\n\n每章输出：chapterId、title、80-150字 summary、重要 characters、尚未解决的 hooks、明确出现的 worldFacts、organizations 和人物 relationships。characters 中 name 是原文姓名，role 是该章能确认的身份或作用。worldFacts 只记录后续必须遵守的地理、规则、历史、物种或势力事实。relationships 只记录本章有直接证据的关系。不确定时留空，不要虚构。\n\n返回格式：{"entries":[{"chapterId":"","title":"","summary":"","characters":[{"name":"","role":""}],"hooks":[""],"worldFacts":[{"type":"","title":"","content":""}],"organizations":[{"name":"","type":"","description":"","members":[""]}],"relationships":[{"fromCharacter":"","toCharacter":"","type":"","description":""}]}]}`
    }
  },
  normalize(raw: string): AiTaskResult {
    const parsed = extractJsonObject(raw)
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.map((value) => {
          const entry = value && typeof value === 'object' ? value as Record<string, unknown> : {}
          return {
            chapterId: jsonStringField(entry.chapterId),
            title: jsonStringField(entry.title),
            summary: jsonStringField(entry.summary),
            characters: Array.isArray(entry.characters)
              ? entry.characters.map((characterValue) => {
                  const character = characterValue && typeof characterValue === 'object'
                    ? characterValue as Record<string, unknown>
                    : {}
                  return { name: jsonStringField(character.name), role: jsonStringField(character.role) }
                }).filter((character) => character.name)
              : [],
            hooks: Array.isArray(entry.hooks)
              ? entry.hooks.map((hook) => jsonStringField(hook)).filter(Boolean).slice(0, 8)
              : [],
            worldFacts: Array.isArray(entry.worldFacts)
              ? entry.worldFacts.map((factValue) => {
                  const fact = factValue && typeof factValue === 'object' ? factValue as Record<string, unknown> : {}
                  return {
                    type: jsonStringField(fact.type) || '其他',
                    title: jsonStringField(fact.title),
                    content: jsonStringField(fact.content)
                  }
                }).filter((fact) => fact.title && fact.content).slice(0, 8)
              : [],
            organizations: Array.isArray(entry.organizations)
              ? entry.organizations.map((organizationValue) => {
                  const organization = organizationValue && typeof organizationValue === 'object'
                    ? organizationValue as Record<string, unknown>
                    : {}
                  return {
                    name: jsonStringField(organization.name),
                    type: jsonStringField(organization.type),
                    description: jsonStringField(organization.description),
                    members: Array.isArray(organization.members)
                      ? organization.members.map((member) => jsonStringField(member)).filter(Boolean).slice(0, 12)
                      : []
                  }
                }).filter((organization) => organization.name && organization.description).slice(0, 8)
              : [],
            relationships: Array.isArray(entry.relationships)
              ? entry.relationships.map((relationshipValue) => {
                  const relationship = relationshipValue && typeof relationshipValue === 'object'
                    ? relationshipValue as Record<string, unknown>
                    : {}
                  return {
                    fromCharacter: jsonStringField(relationship.fromCharacter),
                    toCharacter: jsonStringField(relationship.toCharacter),
                    type: jsonStringField(relationship.type),
                    description: jsonStringField(relationship.description)
                  }
                }).filter((relationship) => (
                  relationship.fromCharacter && relationship.toCharacter && relationship.description
                )).slice(0, 12)
              : []
          }
        }).filter((entry) => entry.chapterId && entry.summary)
      : []
    return { entries } as ContinuationImportChunkResult
  },
  validate(result: AiTaskResult): boolean {
    return (result as ContinuationImportChunkResult).entries.length > 0
  },
  resolveMaxTokens(): number {
    return 6000
  }
}

export default handler
