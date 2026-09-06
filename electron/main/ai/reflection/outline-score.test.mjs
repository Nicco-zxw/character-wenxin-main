import assert from 'node:assert/strict'
import test from 'node:test'

import { scoreOutlineEntries } from './outline-score.ts'

function entry(title, overrides = {}) {
  return {
    title,
    wordTarget: '3500',
    conflict: '冲突',
    summary: '概要',
    ...overrides
  }
}

test('空结果 → 0 分并给出批评', () => {
  const r = scoreOutlineEntries([])
  assert.equal(r.score, 0)
  assert.match(r.critique, /未生成任何章纲节点/)
})

test('3-5 条完整节点 → 100 分', () => {
  const r = scoreOutlineEntries([
    entry('雨夜来信'),
    entry('旧港密谈'),
    entry('废弃仓库')
  ])
  assert.equal(r.score, 100)
  assert.equal(r.critique, '')
})

test('重复标题 → 扣分并在 critique 说明', () => {
  const r = scoreOutlineEntries([entry('旧港密谈'), entry('旧港密谈'), entry('废弃仓库')])
  assert.ok(r.score < 100)
  assert.match(r.critique, /重复标题/)
})

test('缺摘要/冲突、字数越界、标题过短 → 扣分并说明', () => {
  const r = scoreOutlineEntries([
    entry('x', { summary: '' }),
    entry('y', { wordTarget: '8000' }),
    entry('z', { wordTarget: '1000' }),
    entry('单', { conflict: '' }),
    entry('正常标题', {}),
    entry('正常标题2', {})
  ])
  assert.ok(r.score >= 0 && r.score < 100)
  assert.match(r.critique, /缺少标题\/冲突\/摘要/)
  assert.match(r.critique, /字数目标超出/)
  assert.match(r.critique, /标题过短/)
})

test('少于 3 条 → 扣分', () => {
  const r = scoreOutlineEntries([entry('a')])
  assert.ok(r.score < 100)
  assert.match(r.critique, /章纲节点偏少/)
})

test('score 下限为 0（不出现负数）', () => {
  const manyDup = Array.from({ length: 6 }, () => entry('a'))
  const r = scoreOutlineEntries(manyDup)
  assert.ok(r.score >= 0)
})
