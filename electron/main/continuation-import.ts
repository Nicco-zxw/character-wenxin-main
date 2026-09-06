import { createHash } from 'node:crypto'
import { basename, extname } from 'node:path'
import { readFile } from 'node:fs/promises'

import {
  parseContinuationNovelText,
  type ContinuationNovelFilePreview
} from '@shared/continuation-import'

const MAX_IMPORT_FILE_SIZE = 30 * 1024 * 1024

type DecodedNovel = {
  text: string
  encoding: string
}

function decodeWith(buffer: Buffer, encoding: string): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(buffer)
  } catch {
    return null
  }
}

export function decodeContinuationNovelBuffer(buffer: Buffer): DecodedNovel {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    return { text: buffer.subarray(3).toString('utf8'), encoding: 'UTF-8 BOM' }
  }
  if (buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
    return { text: new TextDecoder('utf-16le').decode(buffer.subarray(2)), encoding: 'UTF-16 LE' }
  }
  if (buffer.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    return { text: new TextDecoder('utf-16be').decode(buffer.subarray(2)), encoding: 'UTF-16 BE' }
  }

  const utf8Text = decodeWith(buffer, 'utf-8')
  if (utf8Text !== null) {
    return { text: utf8Text, encoding: 'UTF-8' }
  }

  const gb18030Text = decodeWith(buffer, 'gb18030')
  if (gb18030Text !== null) {
    return { text: gb18030Text, encoding: 'GB18030' }
  }

  throw new Error('无法识别 TXT 文件编码，请先将文件转换为 UTF-8。')
}

export async function inspectContinuationNovelFile(filePath: string): Promise<ContinuationNovelFilePreview & { sourceHash: string }> {
  const bytes = await readFile(filePath)
  if (bytes.length > MAX_IMPORT_FILE_SIZE) {
    throw new Error('TXT 文件超过 30 MB，当前版本暂不支持导入。')
  }

  const decoded = decodeContinuationNovelBuffer(bytes)
  const fileName = basename(filePath)
  const fallbackTitle = basename(filePath, extname(filePath)).trim() || '未命名作品'
  const parsed = parseContinuationNovelText(decoded.text, fallbackTitle)

  return {
    ...parsed,
    filePath,
    fileName,
    fileSize: bytes.length,
    encoding: decoded.encoding,
    sourceHash: createHash('sha256').update(bytes).digest('hex')
  }
}
