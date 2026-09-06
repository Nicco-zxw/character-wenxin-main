import assert from 'node:assert/strict'
import test from 'node:test'

import { clampBranchCount, sanitizeForecastRoot } from './normalize.ts'

function rawBranches() {
  return [
    { id: 'x', title: '分支甲', beats: ['推进', ''], decision: '  立刻行动  ' },
    { id: 'x', title: '分支乙', beats: 'not-array' },
    { title: '' }, // 缺标题 → 丢弃
    { title: '  分支丙  ', risks: ['r1'] }
  ]
}

test('clampBranchCount 限制在 [2,5]', () => {
  assert.equal(clampBranchCount(1), 2)
  assert.equal(clampBranchCount(2), 2)
  assert.equal(clampBranchCount(3), 3)
  assert.equal(clampBranchCount(9), 5)
  assert.equal(clampBranchCount(Number.NaN), 2)
})

test('净化：id 重排唯一、title 必填、文本去空、裁剪到上限', () => {
  const out = sanitizeForecastRoot({ title: '  下一步  ', branches: rawBranches() }, 4)
  assert.equal(out.title, '下一步')
  // 有效分支：甲、乙、丙 → 3 个
  assert.equal(out.branches.length, 3)
  assert.deepEqual(out.branches.map((b) => b.id), ['b1', 'b2', 'b3'])
  assert.equal(out.branches[0].decision, '立刻行动')
  assert.deepEqual(out.branches[0].beats, ['推进'])
  assert.deepEqual(out.branches[1].beats, [])
  assert.deepEqual(out.branches[2].risks, ['r1'])
})

test('净化：超量分支被裁剪到 clamp 上限', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, title: `分支${i}` }))
  const out = sanitizeForecastRoot({ branches: many }, 5)
  assert.equal(out.branches.length, 5)
})

test('净化：无任何合法分支 → 抛错', () => {
  assert.throws(() => sanitizeForecastRoot({ branches: [{ id: 'a' }, 'junk'] }, 3), /无有效分支/)
  assert.throws(() => sanitizeForecastRoot({ branches: [] }, 3), /无有效分支/)
  assert.throws(() => sanitizeForecastRoot(null, 3), /无有效分支/)
})
