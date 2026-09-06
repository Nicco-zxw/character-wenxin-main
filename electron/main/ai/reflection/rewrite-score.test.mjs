import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreRewriteText } from './rewrite-score.ts'
import { runReflectiveLoop } from './reflection-loop.ts'

const SOURCE = '他推开客栈的门，夜风裹着雨腥味扑来。掌柜正在柜台后拨算盘，头也没抬。'
const CHANGED = '他一把推开客栈斑驳的木门，夜风裹着雨腥味扑面而来。掌柜在柜台后头也不抬，只顾噼啪拨着算盘。'

test('空输出 → 0 分', () => {
  assert.deepEqual(scoreRewriteText(SOURCE, ''), { score: 0, critique: '输出为空。请基于改写要求实际改写，并只输出改写后的完整文本。' })
})

test('与原文完全相同 → 20 分（退化：无实质改动）', () => {
  const r = scoreRewriteText(SOURCE, SOURCE)
  assert.equal(r.score, 20)
  assert.ok(r.critique.includes('完全相同'))
})

test('疑似截断（过短 <0.15×）→ 25 分', () => {
  const r = scoreRewriteText(SOURCE, '他推开门')
  assert.equal(r.score, 25)
  assert.ok(r.critique.includes('过短'))
})

test('疑似叠解释（过长 >6×）→ 45 分', () => {
  const long = '这是为了解释场景与人物心态而写的超长铺垫，'.repeat(20) + SOURCE
  const r = scoreRewriteText(SOURCE, long)
  assert.equal(r.score, 45)
  assert.ok(r.critique.includes('过长'))
})

test('实质改写且形态合理 → 88 分（首轮即收敛）', () => {
  const r = scoreRewriteText(SOURCE, CHANGED)
  assert.equal(r.score, 88)
  assert.ok(r.critique.includes('实质改写'))
})

test('改写比原文短但未低于退化阈值 → 仍达标（润色允许精简）', () => {
  const terse = '他推门进屋，夜风裹着雨腥味扑来。掌柜头也不抬地拨着算盘。'
  assert.equal(scoreRewriteText(SOURCE, terse).score, 88)
})

test('集成：良好改写首轮收敛（1 轮 passed）', async () => {
  const result = await runReflectiveLoop({
    initialInput: SOURCE,
    maxIterations: 2,
    passScore: 80,
    act: async () => ({ text: CHANGED }),
    evaluate: (output) => scoreRewriteText(SOURCE, output.text)
  })
  assert.equal(result.passed, true)
  assert.equal(result.iterations, 1)
})

test('集成：退化输出触发带 critique 重做（第 2 轮仍退化 → passed=false、2 轮）', async () => {
  const attempts = []
  const result = await runReflectiveLoop({
    initialInput: SOURCE,
    maxIterations: 2,
    passScore: 80,
    act: async (_input, feedback) => {
      attempts.push(feedback)
      return { text: attempts.length === 1 ? SOURCE : SOURCE } // 始终原样 → 永不达标
    },
    evaluate: (output) => scoreRewriteText(SOURCE, output.text)
  })
  assert.equal(result.passed, false)
  assert.equal(result.iterations, 2)
  assert.ok(String(attempts[1] ?? '').includes('完全相同'), '第 2 轮应带上轮 critique')
})
