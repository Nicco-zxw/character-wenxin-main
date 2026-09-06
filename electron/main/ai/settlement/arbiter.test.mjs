import assert from 'node:assert/strict'
import test from 'node:test'

import { arbitrateSettlement } from './arbiter.ts'
import { DEFAULT_SETTLEMENT_POLICY } from './types.ts'

function baseInput(overrides = {}) {
  return {
    projectId: 'p1',
    chapterId: 'c1',
    chapterIndex: 2,
    contentHash: 'hash-abc',
    content: '章节正文',
    delta: null,
    preIssues: [],
    alreadySettled: false,
    observeAttempt: 0,
    policy: DEFAULT_SETTLEMENT_POLICY,
    ...overrides
  }
}

function deltaFixture() {
  return {
    characters_updated: [],
    relationships_delta: [],
    foreshadowing_delta: { planted: [], advanced: [], resolved: [] },
    timeline: { story_time_elapsed: '1天', current_story_date: '', events: [] }
  }
}

test('无状态变更 → skip / skipped', () => {
  const d = arbitrateSettlement(baseInput({ delta: null }))
  assert.equal(d.type, 'skip')
  assert.equal(d.status, 'skipped')
})

test('幂等：相同正文已结算且不允许重放 → skip / skipped', () => {
  const d = arbitrateSettlement(baseInput({
    delta: deltaFixture(),
    alreadySettled: true,
    policy: DEFAULT_SETTLEMENT_POLICY
  }))
  assert.equal(d.type, 'skip')
  assert.equal(d.status, 'skipped')
})

test('幂等但允许重放 → 走正常裁决 apply', () => {
  const d = arbitrateSettlement(baseInput({
    delta: deltaFixture(),
    alreadySettled: true,
    policy: { ...DEFAULT_SETTLEMENT_POLICY, allowReapply: true }
  }))
  assert.equal(d.type, 'apply')
})

test('无问题 → apply / settled', () => {
  const d = arbitrateSettlement(baseInput({ delta: deltaFixture() }))
  assert.equal(d.type, 'apply')
  assert.equal(d.status, 'settled')
})

test('仅 warning → apply_with_warning / settled_with_warning', () => {
  const d = arbitrateSettlement(baseInput({
    delta: deltaFixture(),
    preIssues: [{ category: 'foreshadow_unplanted_resolve', severity: 'warning', message: 'x', ref: '伏笔-1' }]
  }))
  assert.equal(d.type, 'apply_with_warning')
  assert.equal(d.status, 'settled_with_warning')
})

test('首轮 error 且允许自动重观察 → retry_observe', () => {
  const d = arbitrateSettlement(baseInput({
    delta: deltaFixture(),
    preIssues: [{ category: 'location_mismatch', severity: 'error', message: '位置不一致' }]
  }))
  assert.equal(d.type, 'retry_observe')
  assert.equal(d.status, 'rejected')
})

test('不允许自动重观察时 error → 直接 reject', () => {
  const d = arbitrateSettlement(baseInput({
    delta: deltaFixture(),
    preIssues: [{ category: 'location_mismatch', severity: 'error', message: '位置不一致' }],
    policy: { ...DEFAULT_SETTLEMENT_POLICY, allowAutoReobserve: false }
  }))
  assert.equal(d.type, 'reject')
  assert.equal(d.status, 'rejected')
})

test('重试后（observeAttempt>=1）仍 error → reject（拒绝落盘）', () => {
  const d = arbitrateSettlement(baseInput({
    delta: deltaFixture(),
    preIssues: [{ category: 'location_mismatch', severity: 'error', message: '位置仍不一致' }],
    observeAttempt: 1
  }))
  assert.equal(d.type, 'reject')
  assert.equal(d.status, 'rejected')
  assert.match(d.reason, /拒绝写入状态库/)
})
