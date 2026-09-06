import assert from 'node:assert/strict'
import test from 'node:test'

import { decideAutoSettle } from './auto-settle.ts'

function base(overrides = {}) {
  return {
    enabled: false,
    isLatest: true,
    length: 1000,
    minLength: 50,
    contentHash: 'hash-new',
    lastSettledHash: null,
    lastAutoAtMs: 0,
    nowMs: 1_000_000,
    minIntervalMs: 60_000,
    ...overrides
  }
}

test('默认关闭 → disabled', () => {
  assert.equal(decideAutoSettle(base()), 'disabled')
})

test('开启后满足条件 → proceed', () => {
  assert.equal(decideAutoSettle(base({ enabled: true })), 'proceed')
})

test('非最新章节 → not-latest', () => {
  assert.equal(decideAutoSettle(base({ enabled: true, isLatest: false })), 'not-latest')
})

test('正文过短 → empty', () => {
  assert.equal(decideAutoSettle(base({ enabled: true, length: 10, minLength: 50 })), 'empty')
})

test('正文与最近一次结算相同 → up-to-date（零成本）', () => {
  assert.equal(
    decideAutoSettle(base({ enabled: true, contentHash: 'h', lastSettledHash: 'h' })),
    'up-to-date'
  )
})

test('距上次自动结算过近 → throttled', () => {
  assert.equal(
    decideAutoSettle(base({
      enabled: true,
      lastAutoAtMs: 1_000_000 - 5_000,
      nowMs: 1_000_000,
      minIntervalMs: 60_000
    })),
    'throttled'
  )
})

test('超过间隔且有内容变化 → proceed', () => {
  assert.equal(
    decideAutoSettle(base({
      enabled: true,
      lastAutoAtMs: 1_000_000 - 120_000,
      nowMs: 1_000_000,
      minIntervalMs: 60_000
    })),
    'proceed'
  )
})
