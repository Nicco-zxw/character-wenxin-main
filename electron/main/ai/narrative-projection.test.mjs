import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  applyStateDelta,
  bumpProjectLedger,
  initStoryStateSchema
} from '../story-state-store.ts'
import { buildNarrativeProjection } from './narrative-projection.ts'

function makeDbWithOneSettledChapter() {
  const db = new DatabaseSync(':memory:')
  initStoryStateSchema(db)
  applyStateDelta(db, 'p', 0, {
    characters_updated: [{ character_id: '林岚', changes: { mental_state: '警觉' } }],
    relationships_delta: [],
    foreshadowing_delta: {
      planted: [{ id: '伏笔-1', type: '物件', description: '旧信', method: '露出', payoff_chapter: 5 }],
      advanced: [],
      resolved: []
    },
    timeline: {
      story_time_elapsed: '',
      current_story_date: '第一日',
      events: ['林岚发现异响'],
      world_state_changes: []
    }
  })
  bumpProjectLedger(db, 'p', { settledThroughChapter: 0 })
  return db
}

test('JSON 与 Markdown 投影共享账本版本和源哈希', () => {
  const db = makeDbWithOneSettledChapter()
  const generatedAt = '2026-09-07T00:00:00.000Z'
  const projection = buildNarrativeProjection(db, 'p', 0, generatedAt)
  const parsed = JSON.parse(projection.json)

  assert.equal(parsed.ledgerVersion, projection.ledgerVersion)
  assert.equal(parsed.sourceHash, projection.sourceHash)
  assert.match(projection.markdown, /ledgerVersion: 1/)
  assert.match(projection.markdown, new RegExp(`sourceHash: ${projection.sourceHash}`))
  assert.equal(buildNarrativeProjection(db, 'p', 0, generatedAt).json, projection.json)
})

test('历史章投影不会包含未来章节事实', () => {
  const db = makeDbWithOneSettledChapter()
  applyStateDelta(db, 'p', 2, {
    characters_updated: [{ character_id: '林岚', changes: { mental_state: '释然' } }],
    relationships_delta: [],
    foreshadowing_delta: {
      planted: [],
      advanced: [{ id: '伏笔-1', clue: '火漆来自王府', method: '辨认' }],
      resolved: []
    },
    timeline: {
      story_time_elapsed: '',
      current_story_date: '第三日',
      events: ['真相揭晓'],
      world_state_changes: []
    }
  })

  const parsed = JSON.parse(
    buildNarrativeProjection(db, 'p', 0, '2026-09-07T00:00:00.000Z').json
  )
  assert.equal(parsed.snapshot.truth.characterStates[0].mentalState, '警觉')
  assert.deepEqual(parsed.snapshot.truth.recentTimeline[0].events, ['林岚发现异响'])
  assert.deepEqual(parsed.snapshot.truth.activeForeshadowing[0].clues, [])
})
