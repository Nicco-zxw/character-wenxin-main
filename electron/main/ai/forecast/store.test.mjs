import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { initStoryStateSchema } from '../../story-state-store.ts'
import {
  countStoryStateRows,
  createForecastRecord,
  expireForecastsOlderThan,
  getForecast,
  initForecastSchema,
  listForecasts,
  selectForecastBranch,
  validateForecastBranches
} from './store.ts'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  initStoryStateSchema(db)
  initForecastSchema(db)
  return db
}

function branches() {
  return [
    { id: 'b1', title: '分支A：稳进', beats: ['a'] },
    { id: 'b2', title: '分支B：突袭', beats: ['b'] },
    { id: 'b3', title: '分支C：退守', beats: ['c'] }
  ]
}

test('create → active，get/list 一致', () => {
  const db = makeDb()
  const created = createForecastRecord(db, {
    projectId: 'p',
    baseChapterIndex: 3,
    title: '第4章推演',
    branches: branches()
  })
  assert.equal(created.status, 'active')
  const rec = getForecast(db, 'p', created.id)
  assert.equal(rec?.branchCount, 3)
  assert.equal(rec?.status, 'active')
  assert.equal(rec?.branches.length, 3)
  assert.equal(listForecasts(db, 'p').length, 1)
  // 跨项目隔离
  assert.equal(listForecasts(db, 'other').length, 0)
})

test('非法分支被拒绝（空/缺 title/重复 id）', () => {
  const db = makeDb()
  assert.ok(validateForecastBranches([]) !== null)
  assert.throws(() => createForecastRecord(db, { projectId: 'p', baseChapterIndex: 0, branches: [] }))
  assert.throws(() => createForecastRecord(db, { projectId: 'p', baseChapterIndex: 0, branches: [{ id: '', title: 'x' }] }))
  assert.throws(() => createForecastRecord(db, { projectId: 'p', baseChapterIndex: 0, branches: [{ id: 'a', title: '' }] }))
  assert.throws(() => createForecastRecord(db, { projectId: 'p', baseChapterIndex: 0, branches: [{ id: 'a', title: 'x' }, { id: 'a', title: 'y' }] }))
})

test('select：存在分支 → selected；不存在/已过期 → 拒绝', () => {
  const db = makeDb()
  const { id } = createForecastRecord(db, { projectId: 'p', baseChapterIndex: 1, title: 't', branches: branches() })
  assert.deepEqual(selectForecastBranch(db, 'p', id, 'b2'), { ok: true })
  const rec = getForecast(db, 'p', id)
  assert.equal(rec?.status, 'selected')
  assert.equal(rec?.selectedBranchId, 'b2')

  // 不存在的分支
  const { id: id2 } = createForecastRecord(db, { projectId: 'p', baseChapterIndex: 2, title: 't2', branches: branches() })
  assert.equal(selectForecastBranch(db, 'p', id2, 'no-such').ok, false)

  // 已过期不可选
  const { id: id3 } = createForecastRecord(db, { projectId: 'p', baseChapterIndex: 0, title: 't3', branches: branches() })
  expireForecastsOlderThan(db, 'p', 2)
  assert.equal(selectForecastBranch(db, 'p', id3, 'b1').ok, false)
})

test('正史推进 → 旧 forecast 过期（不删除，可审计）', () => {
  const db = makeDb()
  const a = createForecastRecord(db, { projectId: 'p', baseChapterIndex: 0, branches: branches() })
  const b = createForecastRecord(db, { projectId: 'p', baseChapterIndex: 3, branches: branches() })
  expireForecastsOlderThan(db, 'p', 3)
  assert.equal(getForecast(db, 'p', a.id)?.status, 'expired')
  assert.equal(getForecast(db, 'p', b.id)?.status, 'active')
  assert.equal(listForecasts(db, 'p').length, 2)
})

test('隔离承诺：forecast 全操作不影响 story 正史表', () => {
  const db = makeDb()
  const before = countStoryStateRows(db, 'p')
  const a = createForecastRecord(db, { projectId: 'p', baseChapterIndex: 0, branches: branches() })
  selectForecastBranch(db, 'p', a.id, 'b1')
  expireForecastsOlderThan(db, 'p', 5)
  assert.equal(countStoryStateRows(db, 'p'), before)
})
