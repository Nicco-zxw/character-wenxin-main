const RELATIVE_PLACEHOLDER_VALUES = new Set(['刚刚更新', '刚刚创建', '刚刚导入'])

export function createProjectEditedAt(): string {
  return new Date().toISOString()
}

export function formatProjectEditedAt(value?: string): string {
  const raw = value?.trim()
  if (!raw || RELATIVE_PLACEHOLDER_VALUES.has(raw)) {
    return '未记录'
  }

  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) {
    return raw
  }

  const pad = (part: number): string => String(part).padStart(2, '0')
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  ].join(' ')
}
