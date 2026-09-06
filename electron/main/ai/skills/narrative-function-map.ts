/**
 * 叙事功能到 Skill 参考文件的映射表。
 * 用于在 matcher 中根据章节的叙事功能（从大纲/摘要推断）增加相关 skill 的匹配分数。
 */

type NarrativeFunctionEntry = {
  keywords: string[]
  /** 英文 skill id/description 子串模式，兼容 oh-story 系列 skill。 */
  skillPatterns: string[]
  /** 中文触发词，比对 skill 的 manifest.triggers，命中主工具箱（Distilled-Novel-Toolbox）。 */
  skillTriggers?: string[]
}

const NARRATIVE_FUNCTION_MAP: NarrativeFunctionEntry[] = [
  {
    keywords: ['背叛', '反转', '真相', '揭露', '欺骗', '阴谋', '暴露'],
    skillPatterns: ['reversal', 'hooks'],
    skillTriggers: ['反转', '爽点', '打脸', '钩子', '悬念']
  },
  {
    keywords: ['战斗', '打斗', '交手', '对决', '围攻', '厮杀', '追杀'],
    skillPatterns: ['combat', 'style-combat'],
    skillTriggers: ['节奏', '画面感', '动作']
  },
  {
    keywords: ['告白', '表白', '感情', '心动', '暧昧', '分手', '重逢'],
    skillPatterns: ['emotional', 'emotion'],
    skillTriggers: ['情绪', '代入感', '共情', '沉浸']
  },
  {
    keywords: ['升级', '突破', '觉醒', '进化', '获得', '传承'],
    skillPatterns: ['genre', 'commercial'],
    skillTriggers: ['爽点', '爽感', '金手指', '类型', '商业']
  },
  {
    keywords: ['对话', '谈判', '审讯', '说服', '争吵', '辩论'],
    skillPatterns: ['dialogue'],
    skillTriggers: ['对话', '语言风格', '台词']
  },
  {
    keywords: ['开篇', '第一章', '开头', '序章', '引子'],
    skillPatterns: ['opening', 'hooks'],
    skillTriggers: ['钩子', '开篇', '悬念', '爽点']
  },
  {
    keywords: ['布局', '铺垫', '伏笔', '暗线', '悬念'],
    skillPatterns: ['hooks', 'plot'],
    skillTriggers: ['钩子', '悬念', '伏笔', '节奏']
  },
  {
    keywords: ['高潮', '决战', '最终', '终极', '生死'],
    skillPatterns: ['plot', 'emotional', 'reversal'],
    skillTriggers: ['节奏', '情绪', '爽点', '反转']
  },
  {
    keywords: ['日常', '过渡', '休息', '恢复', '准备'],
    skillPatterns: ['craft', 'writing-craft'],
    skillTriggers: ['节奏', '语言风格']
  },
  {
    keywords: ['世界', '设定', '规则', '体系', '势力'],
    skillPatterns: ['genre', 'worldbuild'],
    skillTriggers: ['世界观', '设定', '体系', '类型']
  }
]

/** 叙事功能匹配结果：英文 id/description 模式 + 中文 trigger 词。 */
export type NarrativeMatch = {
  patterns: string[]
  triggers: string[]
}

/**
 * 根据叙事上下文文本（章节摘要、大纲冲突等）判断哪些 skill 模式应该获得加分。
 * 同时返回英文 id/description 子串模式与中文 trigger 词，供 matcher 多维比对。
 */
export function matchNarrativeFunction(narrativeText: string): NarrativeMatch {
  if (!narrativeText.trim()) return { patterns: [], triggers: [] }

  const matchedPatterns = new Set<string>()
  const matchedTriggers = new Set<string>()
  const lower = narrativeText.toLowerCase()

  for (const entry of NARRATIVE_FUNCTION_MAP) {
    const hits = entry.keywords.filter((kw) => lower.includes(kw))
    if (hits.length > 0) {
      for (const pattern of entry.skillPatterns) {
        matchedPatterns.add(pattern)
      }
      for (const trigger of entry.skillTriggers ?? []) {
        matchedTriggers.add(trigger)
      }
    }
  }

  return { patterns: Array.from(matchedPatterns), triggers: Array.from(matchedTriggers) }
}
