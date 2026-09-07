import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  getLatestCharacterStates,
  initStoryStateSchema,
  readProjectLedger,
  bumpProjectLedger
} from '../../story-state-store.ts'
import {
  initSettlementSchema,
  readSettlementRun
} from './settlement-store.ts'
import { commitSettlement } from './committer.ts'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE chapters (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    INSERT INTO chapters (id, project_id, title, sort_order)
    VALUES ('c1', 'p', '第一章', 1);
  `)
  initStoryStateSchema(db)
  initSettlementSchema(db)
  return db
}

const delta = {
  characters_updated: [{
    character_id: '林岚',
    changes: { mental_state: '警觉' }
  }],
  relationships_delta: [],
  foreshadowing_delta: { planted: [], advanced: [], resolved: [] },
  timeline: {
    story_time_elapsed: '',
    current_story_date: '',
    events: ['林岚发现异响'],
    world_state_changes: []
  }
}

const input = {
  runId: 'run-atomic',
  projectId: 'p',
  chapterId: 'c1',
  chapterIndex: 1,
  contentHash: 'hash',
  baseLedgerVersion: 0,
  actor: 'observer',
  delta,
  issues: [],
  status: 'settled',
  decision: 'apply',
  reason: 'ok'
}

test('摘要阶段故障会回滚状态、快照、账本版本和结算记录', () => {
  const db = makeDb()
  const before = readProjectLedger(db, 'p')

  assert.throws(
    () => commitSettlement(db, input, { afterReducer: () => { throw new Error('injected') } }),
    /injected/
  )

  assert.deepEqual(getLatestCharacterStates(db, 'p', ['林岚']), [])
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM settlement_snapshots').get().count, 0)
  assert.equal(readProjectLedger(db, 'p').ledgerVersion, before.ledgerVersion)
  assert.equal(readSettlementRun(db, 'p', 'c1', 1), null)
})

test('基础账本版本过期时拒绝提交', () => {
  const db = makeDb()
  bumpProjectLedger(db, 'p', { settledThroughChapter: 0 })

  assert.throws(
    () => commitSettlement(db, { ...input, baseLedgerVersion: 0 }),
    /STALE_BASE_VERSION/
  )
  assert.deepEqual(getLatestCharacterStates(db, 'p', ['林岚']), [])
  assert.equal(readSettlementRun(db, 'p', 'c1', 1), null)
})

test('成功提交一次性推进状态、摘要、账本版本与结算记录', () => {
  const db = makeDb()
  db.prepare(`
    INSERT INTO chapter_resettlement_queue
      (project_id, chapter_id, chapter_index, reason, created_at, resolved_at)
    VALUES ('p', 'c1', 1, '回溯后重结算', '2026-09-07T00:00:00.000Z', NULL)
  `).run()
  const result = commitSettlement(db, input)

  assert.deepEqual(result, { runId: 'run-atomic', committedLedgerVersion: 1 })
  assert.equal(getLatestCharacterStates(db, 'p', ['林岚'])[0].mentalState, '警觉')
  assert.equal(readProjectLedger(db, 'p').settledThroughChapter, 1)
  const run = readSettlementRun(db, 'p', 'c1', 1)
  assert.equal(run?.baseLedgerVersion, 0)
  assert.equal(run?.committedLedgerVersion, 1)
  assert.ok(db.prepare(`
    SELECT resolved_at FROM chapter_resettlement_queue
    WHERE project_id = 'p' AND chapter_id = 'c1'
  `).get().resolved_at)
})
