import type { TaskHandler, PromptBuildInput } from './base'
import { normalizeAssistantText } from './base'
import type { AiTaskResult, ChapterAssistantResult } from '../shared-types'

/** 风格指纹提取任务：从参考小说中提取六大维度的作者风格指纹并落库 */
const handler: TaskHandler = {
  name: 'style-fingerprint-extract',
  outputType: 'text',
  defaultCapabilities: ['settings', 'analysis', 'writing-style', 'project-skills'],
  maxSkills: 6,
  buildPrompt(input: PromptBuildInput) {
    const { context, capabilityPreamble, skillsBlock } = input

    const referenceTitle = String(context.referenceTitle ?? '').trim() || '未命名参考作品'
    const referenceGenre = String(context.referenceGenre ?? '').trim() || '未指明'
    const sourceText = String(context.sourceText ?? '').trim()
    const targetTitle = String(context.projectTitle ?? '').trim() || '当前项目'
    const targetGenre = String(context.projectGenre ?? '').trim() || '未指明'

    return {
      system: `${capabilityPreamble.system}

你是一个**风格指纹提取 agent**，工作在 CharacterArc 的"知识中心"管线里。
本次任务：从一本参考小说中提取完整的、可量化的"作者风格指纹"（author_fingerprint），
落库后供后续风格迁移和章节写作时检索复用。

## 强制工作流程

1. **优先调用** \`skill_load("style-fingerprint")\` 加载风格指纹提取方法论。
   如果返回错误说该 skill 不存在，fallback 到你自己掌握的文学风格分析框架。
2. 按需 \`skill_read_reference("style-fingerprint", "references/fingerprint-schema.md")\` 加载输出 schema。
3. 对用户提供的参考小说原文进行**六大维度**深度分析：
   - 叙事层（POV/时间结构/章节机制）
   - 语言层（句式/词汇/节奏）
   - 对话层（占比/机制/语言特征）
   - 描写层（场景/角色/动作）
   - 禁忌层（绝对禁令/风格约束/逻辑一致性）
   - 主题层（核心关切/象征/哲学立场）
4. 分析完成后调用 \`knowledge_save_document\` 落库，产出一份完整的风格指纹文档。

## 必须产出的知识文档

| 维度 | sourceType | 标题格式 |
|---|---|---|
| 完整风格指纹（YAML格式） | reference-summary | 《xxx》｜作者风格指纹 |

content 必须是结构化的 YAML 格式（用 markdown code block 包裹），包含以下根键：
- \`narrative_architecture\`（叙事层）
- \`linguistic_signature\`（语言层）
- \`dialogue_system\`（对话层）
- \`descriptive_protocol\`（描写层）
- \`forbidden_patterns\`（禁忌层）
- \`thematic_execution\`（主题层）
- \`technical_metadata\`（元数据）

keywords 务必填写：作者名（如已知）、题材、核心风格标签（如"冷峻""诗意""快节奏"）。

## 分析要求

- **量化优先**：所有比例必须基于实际统计（如句长分布、对话占比），不能主观估计
- **可执行性**：每条规则必须具体到 AI 可直接执行的程度（如"短句占40%用于动作场景"）
- **举例佐证**：关键特征必须引用原文片段作为证据（≤50字/条）
- **禁忌明确**：至少列出10个具体的禁用词/句式/叙事模式

## 关键约束

- 样本文本通常3-10万字，需确保统计有效性
- 不要照抄原文长段——提取的是可复现的规则，不是内容
- 如果原文太短（<1万字），在输出中标注"样本量不足，统计可能有偏差"
- 落库完成后给出简短中文总结即可结束

${skillsBlock ? `\n## 项目当前启用 skills\n\n${skillsBlock}` : ''}`,
      user: `${capabilityPreamble.user}

## 当前任务上下文

- 当前项目：${targetTitle}（题材：${targetGenre}）
- 参考作品：${referenceTitle}（题材：${referenceGenre}）

## 参考小说原文

${sourceText || '（未提供原文文本——请告诉用户需要先提供参考小说原文。）'}

## 行动指令

按 system prompt 里"强制工作流程"逐步推进：加载 skill → 分析六大维度 → 落库风格指纹文档 → 给出确认总结。`
    }
  },
  normalize(raw: string): AiTaskResult {
    return normalizeAssistantText(raw) as AiTaskResult
  },
  validate(result: AiTaskResult): boolean {
    return typeof (result as ChapterAssistantResult).content === 'string'
  },
  resolveMaxTokens(): number {
    return 8000
  }
}
export default handler
