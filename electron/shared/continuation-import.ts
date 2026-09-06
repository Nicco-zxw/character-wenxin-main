// 这段代码实现了一个鲁棒的小说文本导入器，能够：
// 自动识别多种中外章节卷标题格式（正则覆盖广）
// 处理中文数字与阿拉伯数字混合标题
// 规范化噪声文本（BOM、多余空行、空白字符等）
// 提供置信度与警告信息，便于人工校对
// 将无结构文本转化为结构化数据，为后续续写、分章编辑提供基础
// 它在细节上做了大量容错处理，体现了实际工程中文本解析的复杂度与设计思路
export type ContinuationImportConfidence = 'high' | 'medium' | 'low'

export type ContinuationImportChapter = {
  id: string
  title: string
  volumeTitle: string
  content: string
  characterCount: number
  confidence: ContinuationImportConfidence
}

export type ContinuationImportDocument = {
  title: string
  characterCount: number
  chapterCount: number
  volumeCount: number
  chapters: ContinuationImportChapter[]
  warnings: string[]
}

export type ContinuationNovelFilePreview = ContinuationImportDocument & {
  filePath: string
  fileName: string
  fileSize: number
  encoding: string
}

const CHINESE_NUMBER = '零〇一二三四五六七八九十百千万两'
const CHAPTER_HEADING_RE = new RegExp(
  `^(?:第\\s*[0-9${CHINESE_NUMBER}]+\\s*[章节回]|chapter\\s*[0-9]+|序章|楔子|引子|前言|后记|尾声|终章|大结局|番外(?:\\s*[0-9${CHINESE_NUMBER}]+)?)(?:[：:、.．\\-—\\s]*[^。！？!?；;]{0,48})?$`,
  'iu'
)
const VOLUME_HEADING_RE = new RegExp(
  `^(?:第\\s*[0-9${CHINESE_NUMBER}]+\\s*[卷部集]|[卷部集]\\s*[0-9${CHINESE_NUMBER}]+)(?:[：:、.．\\-—\\s]+.{0,48})?$`,
  'u'
)

function countCharacters(text: string): number {
  return text.replace(/\s+/g, '').length
}

function trimBlankBoundaryLines(text: string): string {
  const lines = text.split('\n')
  let start = 0
  let end = lines.length

  while (start < end && lines[start].trim() === '') start += 1
  while (end > start && lines[end - 1].trim() === '') end -= 1

  return lines.slice(start, end).join('\n')
}

export function normalizeContinuationNovelText(rawText: string): string {
  const normalized = rawText
    .replace(/^\uFEFF/, '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')

  return trimBlankBoundaryLines(normalized)
}

function isLikelyHeading(line: string, pattern: RegExp): boolean {
  const value = line.trim()
  if (!value || value.length > 72 || /[。！？!?；;]$/.test(value)) {
    return false
  }
  return pattern.test(value)
}

function createChapter(
  index: number,
  title: string,
  volumeTitle: string,
  content: string,
  confidence: ContinuationImportConfidence
): ContinuationImportChapter {
  const normalizedContent = trimBlankBoundaryLines(content)
  return {
    id: `import-chapter-${index + 1}`,
    title: title.trim() || `第${index + 1}章`,
    volumeTitle: volumeTitle.trim() || '正文',
    content: normalizedContent,
    characterCount: countCharacters(normalizedContent),
    confidence
  }
}

export function parseContinuationNovelText(rawText: string, fallbackTitle = '未命名作品'): ContinuationImportDocument {
  const text = normalizeContinuationNovelText(rawText)
  if (!text) {
    throw new Error('导入的 TXT 文件没有可用正文。')
  }

  const lines = text.split('\n')
  const headingIndexes: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (isLikelyHeading(lines[index], CHAPTER_HEADING_RE)) {
      headingIndexes.push(index)
    }
  }

  const warnings: string[] = []
  if (headingIndexes.length < 2) {
    warnings.push('未识别到稳定的章节标题，已将全文保留为一个章节，请在校对页手动拆分。')
    const chapter = createChapter(0, '全文', '正文', text, 'low')
    return {
      title: fallbackTitle.trim() || '未命名作品',
      characterCount: countCharacters(text),
      chapterCount: 1,
      volumeCount: 1,
      chapters: [chapter],
      warnings
    }
  }

  const chapters: ContinuationImportChapter[] = []
  const volumeByLine: string[] = []
  let currentVolume = '正文'
  for (let index = 0; index < lines.length; index += 1) {
    if (isLikelyHeading(lines[index], VOLUME_HEADING_RE)) {
      currentVolume = lines[index].trim()
    }
    volumeByLine[index] = currentVolume
  }

  for (let chapterIndex = 0; chapterIndex < headingIndexes.length; chapterIndex += 1) {
    const headingIndex = headingIndexes[chapterIndex]
    currentVolume = volumeByLine[headingIndex] || '正文'
    if (chapters.length === 0) {
      const prefaceLines = lines.slice(0, headingIndex).filter((line) => !isLikelyHeading(line, VOLUME_HEADING_RE))
      const preface = trimBlankBoundaryLines(prefaceLines.join('\n'))
      if (countCharacters(preface) >= 8) {
        chapters.push(createChapter(chapters.length, '正文前内容', currentVolume, preface, 'medium'))
        warnings.push('检测到第一章之前存在正文内容，请确认是否需要保留。')
      }
    }

    const nextHeadingIndex = headingIndexes[chapterIndex + 1] ?? lines.length
    const title = lines[headingIndex].trim()
    const bodyLines = lines
      .slice(headingIndex + 1, nextHeadingIndex)
      .filter((line) => !isLikelyHeading(line, VOLUME_HEADING_RE))
    const body = trimBlankBoundaryLines(bodyLines.join('\n'))
    const confidence: ContinuationImportConfidence = body ? 'high' : 'low'
    chapters.push(createChapter(chapters.length, title, currentVolume, body, confidence))
  }

  const emptyChapterCount = chapters.filter((chapter) => chapter.characterCount === 0).length
  if (emptyChapterCount > 0) {
    warnings.push(`有 ${emptyChapterCount} 个章节没有正文，请在导入前检查。`)
  }

  const duplicateTitles = new Set<string>()
  const seenTitles = new Set<string>()
  for (const chapter of chapters) {
    if (seenTitles.has(chapter.title)) duplicateTitles.add(chapter.title)
    seenTitles.add(chapter.title)
  }
  if (duplicateTitles.size > 0) {
    warnings.push(`检测到 ${duplicateTitles.size} 个重复章节标题。`)
  }

  return {
    title: fallbackTitle.trim() || '未命名作品',
    characterCount: countCharacters(text),
    chapterCount: chapters.length,
    volumeCount: new Set(chapters.map((chapter) => chapter.volumeTitle)).size,
    chapters,
    warnings
  }
}

export function plainNovelTextToHtml(text: string): string {
  const escapeHtml = (value: string) => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

  return normalizeContinuationNovelText(text)
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

export function buildContinuationChapterTitle(chapterCount: number): string {
  return `第${Math.max(1, chapterCount + 1)}章：续写`
}

function parseChineseChapterNumber(value: string): number | null {
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10)
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10_000 }
  let total = 0
  let section = 0
  let number = 0
  for (const char of value) {
    if (char in digits) {
      number = digits[char]
      continue
    }
    const unit = units[char]
    if (!unit) return null
    if (unit === 10_000) {
      section = (section + number) * unit
      total += section
      section = 0
      number = 0
      continue
    }
    section += (number || 1) * unit
    number = 0
  }
  const parsed = total + section + number
  return parsed > 0 ? parsed : null
}

export function inferNextContinuationChapterTitle(chapters: Array<Pick<ContinuationImportChapter, 'title'>>): string {
  for (let index = chapters.length - 1; index >= 0; index -= 1) {
    const match = chapters[index].title.match(new RegExp(`第\\s*([0-9${CHINESE_NUMBER}]+)\\s*章`, 'u'))
    if (!match) continue
    const current = parseChineseChapterNumber(match[1])
    if (current !== null) return `第${current + 1}章：续写`
  }
  return buildContinuationChapterTitle(chapters.length)
}
