import type { TaskHandler, PromptBuildInput } from './base'
import { extractJsonObject } from './base'
import type { AiTaskResult, ReferenceStyleChunkResult } from '../shared-types'
import { formatProjectSkillsContext } from '../prompts/shared'

/**
 * 将未知值标准化为字符串数组，最多取前 4 项
 * @param value - 待标准化的值
 * @param fallback - 值无效时的默认数组
 * @returns 字符串数组
 */
function toList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  const normalized = value.map((item) => String(item).trim()).filter(Boolean).slice(0, 4)
  return normalized.length ? normalized : fallback
}

/** 参考作品分块分析任务：对单个分块进行局部风格和桥段作用分析 */
const handler: TaskHandler = {
  name: 'reference-style-chunk',
  outputType: 'json',
  defaultCapabilities: ['settings', 'analysis', 'writing-style', 'outline', 'import-export', 'project-skills'],
  buildPrompt(input: PromptBuildInput) {
    const { context, capabilityPreamble, skillsBlock } = input
    const projectSkillsBlock = formatProjectSkillsContext(context.projectSkills)
    const skillsSection = projectSkillsBlock || skillsBlock
      ? `\n\n## 拆书方法论（来自当前项目已启用 skills）\n\n以下是当前项目在 reference 阶段启用的 skills。它们不是硬约束模板，但应作为本次拆书的主要观察框架、术语来源和维度优先级。请优先综合这些 skills 的共同关注点来分析本分块；若不同 skills 口径不一致，请融合后输出，不要机械照抄单个 skill。\n\n${projectSkillsBlock || ''}${projectSkillsBlock && skillsBlock ? '\n\n## 补充命中 Skills\n\n' : ''}${projectSkillsBlock ? '' : ''}${skillsBlock || ''}` : ''
    return {
      system: `${capabilityPreamble.system}\n\n你是小说拆书分块分析助手。请只返回 JSON 对象，不要返回 Markdown，不要解释。字段必须包含 overview、sentenceStyle、dialogueRatio、pacingControl、emotionExpression、plotFunction、hookDesign、informationRelease、characterShift、tensionCurve、styleRules。${skillsSection}`,
      user: `${capabilityPreamble.user}\n\n请分析下面这个参考作品分块，提炼它在局部层面的风格和桥段作用。\n\n当前项目标题：${String(context.projectTitle ?? '')}\n当前项目题材：${String(context.projectGenre ?? '')}\n参考作品标题：${String(context.sourceTitle ?? '')}\n分块标签：${String(context.chunkLabel ?? '')}\n分块顺序：${String(context.chunkIndex ?? '')} / ${String(context.chunkTotal ?? '')}\n分块字数：${String(context.chunkCharacterCount ?? '')}\n分块局部统计：${JSON.stringify(context.chunkMetrics ?? [])}\n分块关键词：${JSON.stringify(context.chunkKeywords ?? [])}\n分块正文：\n${String(context.chunkText ?? '')}\n\n要求：\n1. 只分析这一块\n2. plotFunction 概括这段承担的桥段职责\n3. hookDesign 说明这段的钩子设计，包含开头抓力、段尾悬念或追读驱动\n4. informationRelease 说明这段如何放信息、藏信息、延后信息\n5. characterShift 说明人物关系、立场、情绪、强弱位发生了什么位移\n6. tensionCurve 说明这一段张力是怎么走的，比如平推、抬升、骤压、爆点后回收\n7. styleRules 返回 2 到 4 条局部可复用规则\n8. 不要输出版权敏感的连续原文\n9. 当前项目启用的 reference skills 应视为主要分析维度来源，但输出必须融合整理，不能变成 skill 摘抄\n\n返回格式：{"overview":"","sentenceStyle":"","dialogueRatio":"","pacingControl":"","emotionExpression":"","plotFunction":"","hookDesign":"","informationRelease":"","characterShift":"","tensionCurve":"","styleRules":[""]}`
    }
  },
  normalize(raw: string): AiTaskResult {
    const parsed = extractJsonObject(raw) as Partial<ReferenceStyleChunkResult>
    return {
      overview: parsed.overview?.trim() || '这一段以稳定推进和局部反馈为主。',
      sentenceStyle: parsed.sentenceStyle?.trim() || '句式偏直接。',
      dialogueRatio: parsed.dialogueRatio?.trim() || '对白承担推进信息的职责。',
      pacingControl: parsed.pacingControl?.trim() || '节奏以短回合推进。',
      emotionExpression: parsed.emotionExpression?.trim() || '情绪通过动作和人物反应外化。',
      plotFunction: parsed.plotFunction?.trim() || '该段桥段主要承担冲突抬升。',
      hookDesign: parsed.hookDesign?.trim() || '这段会在开头或段尾留一个继续读下去的抓手。',
      informationRelease: parsed.informationRelease?.trim() || '通过局部揭示与延后说明维持信息差。',
      characterShift: parsed.characterShift?.trim() || '人物情绪和处境会在这一段发生可感变化。',
      tensionCurve: parsed.tensionCurve?.trim() || '张力整体呈上抬趋势。',
      styleRules: toList(parsed.styleRules, ['保持信息推进和场景反馈同步。'])
    } as ReferenceStyleChunkResult
  },
  validate(result: AiTaskResult): boolean {
    const r = result as ReferenceStyleChunkResult
    return Boolean(r.overview?.trim() && r.sentenceStyle?.trim() && r.styleRules.length > 0)
  }
}
export default handler
