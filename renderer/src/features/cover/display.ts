import type { CSSProperties } from 'vue'

function isImageCoverValue(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized.startsWith('data:image/')
    || normalized.startsWith('blob:')
    || normalized.startsWith('http://')
    || normalized.startsWith('https://')
    || normalized.startsWith('file://')
}

function toCssUrl(value: string): string {
  return `url(${JSON.stringify(value)})`
}

export function resolveCoverStyle(
  cover: string | null | undefined,
  fallback = 'linear-gradient(135deg, #f6d365 0%, #fda085 100%)'
): CSSProperties {
  const resolved = String(cover ?? '').trim()
  if (!resolved) {
    return { background: fallback }
  }

  if (isImageCoverValue(resolved)) {
    return {
      backgroundColor: '#111827',
      backgroundImage: toCssUrl(resolved),
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat',
      backgroundSize: 'cover'
    }
  }

  return { background: resolved }
}

export function isImageCover(cover: string | null | undefined): boolean {
  return isImageCoverValue(String(cover ?? '').trim())
}
