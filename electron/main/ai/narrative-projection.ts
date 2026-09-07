import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { NarrativeProjectionEnvelopeSchema } from '../../shared/narrative-memory.ts'
import { buildNarrativeSnapshot, readProjectLedger } from '../story-state-store.ts'

export interface NarrativeProjection {
  ledgerVersion: number
  sourceHash: string
  json: string
  markdown: string
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)])
    )
  }
  return value
}

function stableStringify(value: unknown, space?: number): string {
  return JSON.stringify(stableValue(value), null, space)
}

export function buildNarrativeProjection(
  db: DatabaseSync,
  projectId: string,
  atChapter: number,
  generatedAt = new Date().toISOString()
): NarrativeProjection {
  const snapshot = buildNarrativeSnapshot(db, projectId, atChapter)
  const sourceHash = createHash('sha256').update(stableStringify(snapshot)).digest('hex')
  const ledgerVersion = readProjectLedger(db, projectId).ledgerVersion
  const envelope = NarrativeProjectionEnvelopeSchema.parse({
    schemaVersion: 1,
    projectId,
    ledgerVersion,
    atChapter,
    generatedAt,
    sourceHash,
    snapshot
  })
  const json = stableStringify(envelope, 2)
  const markdown = [
    '---',
    `schemaVersion: ${envelope.schemaVersion}`,
    `projectId: ${JSON.stringify(envelope.projectId)}`,
    `ledgerVersion: ${envelope.ledgerVersion}`,
    `atChapter: ${envelope.atChapter}`,
    `generatedAt: ${envelope.generatedAt}`,
    `sourceHash: ${envelope.sourceHash}`,
    '---',
    '',
    '# 叙事记忆投影',
    '',
    '## M0 创作宪法',
    '',
    '```json',
    stableStringify(envelope.snapshot.constitution, 2),
    '```',
    '',
    '## M1 时序真相',
    '',
    '```json',
    stableStringify(envelope.snapshot.truth, 2),
    '```',
    '',
    '## M2 章节事件',
    '',
    '```json',
    stableStringify(envelope.snapshot.episodes, 2),
    '```',
    '',
    '## M3 证据引用',
    '',
    '```json',
    stableStringify(envelope.snapshot.evidence, 2),
    '```',
    '',
    '## M4 工作记忆',
    '',
    '```json',
    stableStringify(envelope.snapshot.working, 2),
    '```',
    ''
  ].join('\n')

  return { ledgerVersion, sourceHash, json, markdown }
}
