import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { initStoryStateSchema } from '../../story-state-store.ts'
import {
  adoptForecastBranchWithMemo,
  countStoryStateRows,
  createForecastRecord,
  getForecast,
  initForecastSchema,
  selectForecastBranch
} from './store.ts'
import { buildAdoptionMemoFromBranch, formatAdoptionMemoText } from './adoption.ts'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  initStoryStateSchema(db)
  initForecastSchema(db)
  return db
}

function branches() {
  return [
    { id: 'b1', title: '分支A：稳进', beats: ['节拍1', '节拍2'], decision: '稳扎稳打推进', risks: ['节奏偏慢'], fit: '贴合作者收线意图' },
    { id: 'b2', title: '分支B：突袭', beats: ['节拍3'], decision: '趁夜突袭', changes: ['敌方据点易主'], risks: ['风险高'] }
  ]
}

// ── 纯构造 ──
test('buildAdoptionMemoFromBranch：从 decision/beats/risks/fit 收敛', () => {
  const memo = buildAdoptionMemoFromBranch(branches()[0])
  assert.equal(memo.currentTask, '稳扎稳打推进')
  assert.deepEqual(memo.suggestedHooks, ['节拍1', '节拍2'])
  assert.ok(memo.note.includes('风险：节奏偏慢'))
  assert.ok(memo.note.includes('贴合作者收线意图'))
})

test('buildAdoptionMemoFromBranch：无 decision 时回退 title/节拍/默认', () => {
  assert.equal(buildAdoptionMemoFromBranch({ title: '分支X', beats: ['节拍A'] }).currentTask, '沿「分支X」推进下一章')
  assert.equal(buildAdoptionMemoFromBranch({ beats: ['只有节拍'] }).currentTask, '只有节拍')
  assert.equal(buildAdoptionMemoFromBranch({}).currentTask, '按所选分支继续推进')
  assert.equal(buildAdoptionMemoFromBranch(undefined).currentTask, '按所选分支继续推进')
})

test('buildAdoptionMemoFromBranch：容错脏字段/非数组', () => {
  const memo = buildAdoptionMemoFromBranch({ beats: 'not-array', risks: null, changes: ['x'], fit: '' })
  assert.deepEqual(memo.suggestedHooks, [])
  assert.ok(memo.note.includes('预计世界变化：x'))
})

test('formatAdoptionMemoText：渲染可读文本', () => {
  const text = formatAdoptionMemoText({ currentTask: '推动冲突', suggestedHooks: ['A', 'B'], note: '注意风险' })
  assert.ok(text.includes('【核心任务】推动冲突'))
  assert.ok(text.includes('【钩子/节拍建议】A；B'))
  assert.ok(text.includes('【注意】注意风险'))
  assert.equal(formatAdoptionMemoText(undefined), '')
})

// ── 存储 + 隔离承诺 ──
test('adopt-memo：置 selected + 落 memo/adoptedAt，隔离不写正史', () => {
  const db = makeDb()
  const created = createForecastRecord(db, { projectId: 'p', baseChapterIndex: 3, branches: branches() })
  const before = countStoryStateRows(db, 'p')

  const memo = buildAdoptionMemoFromBranch(branches()[1])
  const res = adoptForecastBranchWithMemo(db, 'p', created.id, 'b2', memo)
  assert.equal(res.ok, true)
  const record = res.record ?? getForecast(db, 'p', created.id)
  assert.ok(record, '应能读到更新后的记录')
  assert.equal(record.status, 'selected')
  assert.equal(record.selectedBranchId, 'b2')
  assert.equal(record.adoptedAt != null, true)
  assert.deepEqual(record.adoptionMemo, memo)

  // 隔离：正史行数不变
  assert.equal(countStoryStateRows(db, 'p'), before)
})

test('adopt-memo：非法分支/不存在 → 报错不改状态', () => {
  const db = makeDb()
  const created = createForecastRecord(db, { projectId: 'p', baseChapterIndex: 0, branches: branches() })
  const badBranch = adoptForecastBranchWithMemo(db, 'p', created.id, 'nope', {})
  assert.equal(badBranch.ok, false)
  assert.equal(getForecast(db, 'p', created.id)?.status, 'active')

  const badId = adoptForecastBranchWithMemo(db, 'p', 'missing', 'b1', {})
  assert.equal(badId.ok, false)
})

test('adopt-memo：幂等重复采用同一分支可覆盖 memo', () => {
  const db = makeDb()
  const created = createForecastRecord(db, { projectId: 'p', baseChapterIndex: 0, branches: branches() })
  adoptForecastBranchWithMemo(db, 'p', created.id, 'b1', { currentTask: 'v1' })
  adoptForecastBranchWithMemo(db, 'p', created.id, 'b1', { currentTask: 'v2' })
  assert.equal(getForecast(db, 'p', created.id)?.adoptionMemo?.currentTask, 'v2')
})

// ── 旧库迁移 ──
test('旧库（无 adoption 列）启动 initForecastSchema 自动补列', () => {
  const db = new DatabaseSync(':memory:')
  initStoryStateSchema(db)
  db.exec(`
    CREATE TABLE narrative_forecasts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      base_chapter_index INTEGER NOT NULL,
      base_content_hash TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      selected_branch_id TEXT,
      branch_count INTEGER NOT NULL DEFAULT 0,
      branches_json TEXT NOT NULL DEFAULT '[]',
      summary_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `)
  db.prepare(`INSERT INTO narrative_forecasts (id, project_id, base_chapter_index, title, status, branch_count, branches_json, summary_json, created_at, updated_at)
    VALUES ('old', 'p', 0, '', 'active', 0, '[]', '{}', 't', 't')`).run()
  initForecastSchema(db) // 触发 ensureForecastAdoptionColumns 迁移
  const cols = db.prepare('PRAGMA table_info(narrative_forecasts)').all().map((c) => c.name)
  assert.ok(cols.includes('adoption_memo_json'))
  assert.ok(cols.includes('adopted_at'))
  const res = adoptForecastBranchWithMemo(db, 'p', 'old', 'b1', { currentTask: 'x' })
  // b1 不存在 → 报错即可证明可写
  assert.equal(res.ok, false)
})

test('select 分支后仍可读（不破坏既有语义），adopt 兼容 select 状态', () => {
  const db = makeDb()
  const created = createForecastRecord(db, { projectId: 'p', baseChapterIndex: 0, branches: branches() })
  assert.equal(selectForecastBranch(db, 'p', created.id, 'b1').ok, true)
  const record = getForecast(db, 'p', created.id)
  assert.ok(record, '应能读到 select 后的记录')
  assert.equal(record.status, 'selected')
  const memo = buildAdoptionMemoFromBranch(branches()[1])
  const res = adoptForecastBranchWithMemo(db, 'p', created.id, 'b2', memo)
  assert.equal(res.ok, true)
  assert.equal(res.record?.selectedBranchId, 'b2')
  assert.deepEqual(res.record?.adoptionMemo, memo)
})
