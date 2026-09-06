export const DEFAULT_CHAPTER_WORD_TARGET = '3000'

export function normalizeChapterWordTarget(value?: string | number | null): string {
  const raw = typeof value === 'number' ? String(value) : (value ?? '').trim()
  const digits = raw.replace(/\D/g, '')
  return digits || DEFAULT_CHAPTER_WORD_TARGET
}

export function parseChapterWordTarget(value?: string | number | null): number {
  return Number.parseInt(normalizeChapterWordTarget(value), 10)
}

export function formatChapterWordTargetLabel(value?: string | number | null): string {
  return `${normalizeChapterWordTarget(value)}字`
}
