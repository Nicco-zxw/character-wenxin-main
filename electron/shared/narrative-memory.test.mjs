import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MemoryLayerSchema,
  NarrativeProjectionEnvelopeSchema,
  RollbackPlanSchema
} from './narrative-memory.ts'

test('五层记忆 ID 只接受 M0-M4', () => {
  assert.equal(MemoryLayerSchema.parse('M0'), 'M0')
  assert.equal(MemoryLayerSchema.parse('M4'), 'M4')
  assert.equal(MemoryLayerSchema.safeParse('M5').success, false)
})

test('投影 Envelope 要求非负账本版本和 64 位源哈希', () => {
  const result = NarrativeProjectionEnvelopeSchema.safeParse({
    schemaVersion: 1,
    projectId: 'project-1',
    ledgerVersion: 3,
    atChapter: 2,
    generatedAt: '2026-09-07T00:00:00.000Z',
    sourceHash: 'a'.repeat(64),
    snapshot: { constitution: {}, truth: {}, episodes: {}, evidence: {}, working: {} }
  })
  assert.equal(result.success, true)

  assert.equal(NarrativeProjectionEnvelopeSchema.safeParse({
    schemaVersion: 1,
    projectId: 'project-1',
    ledgerVersion: -1,
    atChapter: 2,
    generatedAt: 'bad-date',
    sourceHash: 'short',
    snapshot: {}
  }).success, false)
})

test('回溯计划对下游章节排序去重', () => {
  const plan = RollbackPlanSchema.parse({
    projectId: 'project-1',
    targetChapter: 3,
    invalidatedChapters: [5, 4, 5],
    retainedChapterIds: ['c4', 'c5'],
    baseLedgerVersion: 9
  })
  assert.deepEqual(plan.invalidatedChapters, [4, 5])
})

test('回溯计划拒绝目标章及以前的失效章节', () => {
  assert.equal(RollbackPlanSchema.safeParse({
    projectId: 'project-1',
    targetChapter: 3,
    invalidatedChapters: [3],
    retainedChapterIds: ['c3'],
    baseLedgerVersion: 9
  }).success, false)
})
