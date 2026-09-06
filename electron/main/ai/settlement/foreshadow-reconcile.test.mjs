import assert from 'node:assert/strict'
import test from 'node:test'

import { reconcileForeshadowing } from './foreshadow-reconcile.ts'

function hook(id, overrides = {}) {
  return {
    foreshadowingId: id,
    type: '暗线',
    description: '',
    status: 'active',
    plantedChapter: 1,
    plantedMethod: '',
    payoffChapter: null,
    resolvedChapter: null,
    clues: [],
    connections: [],
    ...overrides
  }
}

function deltaWith(partial) {
  return {
    characters_updated: [],
    relationships_delta: [],
    foreshadowing_delta: { planted: [], advanced: [], resolved: [], ...partial },
    timeline: { story_time_elapsed: '', current_story_date: '', events: [] }
  }
}

function byCategory(issues, category) {
  return issues.filter((i) => i.category === category)
}

test('回收不存在的伏笔 → warning (foreshadow_unplanted_resolve)', () => {
  const issues = reconcileForeshadowing({
    activeForeshadowing: [],
    chapterIndex: 3,
    delta: deltaWith({ resolved: [{ id: '伏笔-x', method: '揭示', impact: '真相' }] })
  })
  assert.equal(byCategory(issues, 'foreshadow_unplanted_resolve').length, 1)
})

test('重复埋设活跃伏笔 → warning (foreshadow_duplicate_plant)', () => {
  const issues = reconcileForeshadowing({
    activeForeshadowing: [hook('伏笔-1')],
    chapterIndex: 3,
    delta: deltaWith({ planted: [{ id: '伏笔-1', type: '暗线', description: '', method: '' }] })
  })
  assert.equal(byCategory(issues, 'foreshadow_duplicate_plant').length, 1)
})

test('重复回收已 resolved 伏笔 → hint (foreshadow_duplicate_resolve)', () => {
  const issues = reconcileForeshadowing({
    activeForeshadowing: [hook('伏笔-1', { status: 'resolved', resolvedChapter: 2 })],
    chapterIndex: 4,
    delta: deltaWith({ resolved: [{ id: '伏笔-1', method: '揭示', impact: '' }] })
  })
  assert.equal(byCategory(issues, 'foreshadow_duplicate_resolve').length, 1)
})

test('超过 payoff 章未回收且本章未回收 → hint (foreshadow_overdue)', () => {
  const issues = reconcileForeshadowing({
    activeForeshadowing: [hook('伏笔-1', { payoffChapter: 5 })],
    chapterIndex: 7,
    delta: deltaWith({})
  })
  assert.equal(byCategory(issues, 'foreshadow_overdue').length, 1)
})

test('本章已回收的过期伏笔不报 overdue', () => {
  const issues = reconcileForeshadowing({
    activeForeshadowing: [hook('伏笔-1', { payoffChapter: 5 })],
    chapterIndex: 7,
    delta: deltaWith({ resolved: [{ id: '伏笔-1', method: '揭示', impact: '' }] })
  })
  assert.equal(byCategory(issues, 'foreshadow_overdue').length, 0)
  assert.equal(byCategory(issues, 'foreshadow_unplanted_resolve').length, 0)
})

test('clean 场景（正常推进）无问题', () => {
  const issues = reconcileForeshadowing({
    activeForeshadowing: [hook('伏笔-1', { payoffChapter: 9 })],
    chapterIndex: 6,
    delta: deltaWith({ advanced: [{ id: '伏笔-1', clue: '旧信', method: '侧写' }] })
  })
  assert.equal(issues.length, 0)
})

test('②伏笔身份归一：resolve id 物名漂移（半块玉佩 vs 账本半枚玉佩）→ 按同一伏笔回收，不报 unplanted', () => {
  const issues = reconcileForeshadowing({
    activeForeshadowing: [hook('半枚玉佩')],
    chapterIndex: 9,
    delta: deltaWith({ resolved: [{ id: '半块玉佩', method: '货郎辨认', impact: '' }] })
  })
  assert.equal(byCategory(issues, 'foreshadow_unplanted_resolve').length, 0)
  const drift = byCategory(issues, 'foreshadow_id_drift')
  assert.equal(drift.length, 1)
  assert.equal(drift[0].severity, 'hint')
  assert.ok(drift[0].message.includes('半枚玉佩'))
})

test('②不同物不误配：resolve 玉佩 而账本只有旧信 → 仍报 unplanted', () => {
  const issues = reconcileForeshadowing({
    activeForeshadowing: [hook('旧信')],
    chapterIndex: 9,
    delta: deltaWith({ resolved: [{ id: '玉佩', method: 'x', impact: '' }] })
  })
  assert.equal(byCategory(issues, 'foreshadow_unplanted_resolve').length, 1)
  assert.equal(byCategory(issues, 'foreshadow_id_drift').length, 0)
})

test('②planted 物名漂移重复埋设 → duplicate_plant（id 漂移文案）', () => {
  const issues = reconcileForeshadowing({
    activeForeshadowing: [hook('半枚玉佩')],
    chapterIndex: 4,
    delta: deltaWith({ planted: [{ id: '半块玉佩', type: '信物', description: '', method: '' }] })
  })
  const dup = byCategory(issues, 'foreshadow_duplicate_plant')
  assert.equal(dup.length, 1)
  assert.ok(dup[0].message.includes('id 漂移'))
})

test('②精确 id 回收不产 id_drift', () => {
  const issues = reconcileForeshadowing({
    activeForeshadowing: [hook('旧铜钱')],
    chapterIndex: 9,
    delta: deltaWith({ resolved: [{ id: '旧铜钱', method: 'x', impact: '' }] })
  })
  assert.equal(byCategory(issues, 'foreshadow_id_drift').length, 0)
  assert.equal(byCategory(issues, 'foreshadow_unplanted_resolve').length, 0)
})

