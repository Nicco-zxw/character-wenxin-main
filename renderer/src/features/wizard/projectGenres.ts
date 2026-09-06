import type { NovelLength } from '@/types/app'

export type GenreGroupId = 'common' | 'female' | 'male' | 'custom'

export interface ProjectGenreOption {
  key: string
  label: string
  group: GenreGroupId
  isCustom?: boolean
}

export const PROJECT_GENRE_GROUP_LABELS: Record<Exclude<GenreGroupId, 'custom'>, string> = {
  common: '常见题材',
  female: '女频细分',
  male: '男频细分'
}

export const PROJECT_GENRE_OPTIONS: ProjectGenreOption[] = [
  { key: 'sci-fi', label: '科幻', group: 'common' },
  { key: 'fantasy', label: '奇幻', group: 'common' },
  { key: 'xianxia', label: '仙侠', group: 'common' },
  { key: 'urban', label: '都市', group: 'common' },
  { key: 'mystery', label: '悬疑', group: 'common' },
  { key: 'historical', label: '历史', group: 'common' },
  { key: 'romance', label: '言情', group: 'common' },
  { key: 'horror', label: '恐怖', group: 'common' },
  { key: 'campus', label: '校园', group: 'common' },
  { key: 'light-novel', label: '轻小说', group: 'common' },
  { key: 'apocalypse', label: '末世', group: 'common' },
  { key: 'esports', label: '游戏竞技', group: 'common' },
  { key: 'ancient-romance', label: '古言', group: 'female' },
  { key: 'modern-romance', label: '现言', group: 'female' },
  { key: 'wealthy', label: '豪门', group: 'female' },
  { key: 'transmigration', label: '穿越', group: 'female' },
  { key: 'palace', label: '宫斗', group: 'female' },
  { key: 'farming', label: '种田', group: 'female' },
  { key: 'bl', label: '双男主', group: 'female' },
  { key: 'xuanhuan', label: '玄幻', group: 'male' },
  { key: 'wuxia', label: '武侠', group: 'male' },
  { key: 'officialdom', label: '官场', group: 'male' },
  { key: 'business', label: '商战', group: 'male' },
  { key: 'hongkong', label: '港综', group: 'male' },
  { key: 'espionage', label: '谍战', group: 'male' },
  { key: 'military', label: '军事', group: 'male' },
  { key: 'fanfiction', label: '同人', group: 'male' },
  { key: 'custom', label: '自定义', group: 'custom', isCustom: true }
]

export const PROJECT_GENRE_GROUPS = ['common', 'female', 'male'] as const

export const DEFAULT_PROJECT_GENRE_KEY = 'sci-fi'

export const DEFAULT_PROJECT_GENRE = PROJECT_GENRE_OPTIONS.find(
  (option) => option.key === DEFAULT_PROJECT_GENRE_KEY
)?.label ?? '科幻'

export const NOVEL_LENGTH_OPTIONS: Array<{ value: NovelLength; label: string; description: string }> = [
  {
    value: 'long',
    label: '长篇',
    description: '适合连载推进，允许多线铺陈与持续升级。'
  },
  {
    value: 'short',
    label: '短篇',
    description: '更聚焦单线冲突，强调完整闭环与集中爆发。'
  }
]

export function resolveNovelLengthLabel(length?: NovelLength | string | null): string {
  return length === 'short' ? '短篇' : '长篇'
}
