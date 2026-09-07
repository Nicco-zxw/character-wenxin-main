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
  readSettlementRun,
  settlementContentHash
} from './settlement-store.ts'
import { commitSettlement } from './committer.ts'
import {
  acquireBookLock,
  initBookLockSchema,
  releaseBookLock
} from '../locking/book-lock.ts'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE chapters (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    INSERT INTO chapters (id, project_id, title, content, sort_order)
    VALUES ('c1', 'p', '第一章', '正文', 1);
  `)
  initStoryStateSchema(db)
  initSettlementSchema(db)
  initBookLockSchema(db)
  acquireBookLock(db, { scope: 'settle:p:0', owner: 'chapter:c1', token: 'lock-1' })
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
  chapterIndex: 0,
  contentHash: settlementContentHash('正文'),
  baseLedgerVersion: 0,
  lock: { scope: 'settle:p:0', owner: 'chapter:c1', token: 'lock-1' },
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
    VALUES ('p', 'c1', 0, '回溯后重结算', '2026-09-07T00:00:00.000Z', NULL)
  `).run()
  const result = commitSettlement(db, input)

  assert.deepEqual(result, { runId: 'run-atomic', committedLedgerVersion: 1 })
  assert.equal(getLatestCharacterStates(db, 'p', ['林岚'])[0].mentalState, '警觉')
  assert.equal(readProjectLedger(db, 'p').settledThroughChapter, 0)
  const run = readSettlementRun(db, 'p', 'c1', 0)
  assert.equal(run?.baseLedgerVersion, 0)
  assert.equal(run?.committedLedgerVersion, 1)
  assert.ok(db.prepare(`
    SELECT resolved_at FROM chapter_resettlement_queue
    WHERE project_id = 'p' AND chapter_id = 'c1'
  `).get().resolved_at)
})

test('锁令牌已丢失时拒绝提交且不写入状态', () => {
  const db = makeDb()
  releaseBookLock(db, input.lock)

  assert.throws(() => commitSettlement(db, input), /BOOK_BUSY/)
  assert.equal(readProjectLedger(db, 'p').ledgerVersion, 0)
  assert.deepEqual(getLatestCharacterStates(db, 'p', ['林岚']), [])
})

test('Observer 之后正文发生变化时拒绝旧增量', () => {
  const db = makeDb()
  db.prepare("UPDATE chapters SET content = '已修改正文' WHERE id = 'c1'").run()

  assert.throws(() => commitSettlement(db, input), /STALE_CHAPTER_CONTENT/)
  assert.equal(readProjectLedger(db, 'p').ledgerVersion, 0)
})

test('章节归属或顺序不匹配时拒绝提交', () => {
  const db = makeDb()

  assert.throws(
    () => commitSettlement(db, { ...input, projectId: 'other' }),
    /CHAPTER_SCOPE_MISMATCH/
  )
})

test('回滚重结算必须从最早待处理章节开始', () => {
  const db = makeDb()
  db.prepare(`
    INSERT INTO chapters (id, project_id, title, content, sort_order)
    VALUES ('c2', 'p', '第二章', '正文二', 2)
  `).run()
  db.prepare(`
    INSERT INTO chapter_resettlement_queue
      (project_id, chapter_id, chapter_index, reason, created_at, resolved_at)
    VALUES ('p', 'c1', 0, '待处理', '2026-09-07T00:00:00.000Z', NULL)
  `).run()
  acquireBookLock(db, { scope: 'settle:p:1', owner: 'chapter:c2', token: 'lock-2' })

  assert.throws(
    () => commitSettlement(db, {
      ...input,
      runId: 'run-out-of-order',
      chapterId: 'c2',
      chapterIndex: 1,
      contentHash: settlementContentHash('正文二'),
      lock: { scope: 'settle:p:1', owner: 'chapter:c2', token: 'lock-2' }
    }),
    /RESETTLEMENT_ORDER_VIOLATION/
  )
})

test('较早章节再次结算不会让 settledThroughChapter 倒退', () => {
  const db = makeDb()
  bumpProjectLedger(db, 'p', { settledThroughChapter: 3 })

  const result = commitSettlement(db, { ...input, baseLedgerVersion: 1 })

  assert.equal(result.committedLedgerVersion, 2)
  assert.equal(readProjectLedger(db, 'p').settledThroughChapter, 3)
})

test('forecast 失效与正史提交处于同一事务', () => {
  const db = makeDb()
  db.exec(`
    CREATE TABLE narrative_forecasts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      base_chapter_index INTEGER NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO narrative_forecasts
      (id, project_id, base_chapter_index, status, updated_at)
    VALUES ('f1', 'p', -1, 'active', '2026-09-07T00:00:00.000Z');
  `)

  assert.throws(
    () => commitSettlement(db, input, {
      afterForecastInvalidation: () => { throw new Error('forecast-injected') }
    }),
    /forecast-injected/
  )
  assert.equal(db.prepare("SELECT status FROM narrative_forecasts WHERE id = 'f1'").get().status, 'active')
  assert.equal(readProjectLedger(db, 'p').ledgerVersion, 0)
  assert.deepEqual(getLatestCharacterStates(db, 'p', ['林岚']), [])
})
