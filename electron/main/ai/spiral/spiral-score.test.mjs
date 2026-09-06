import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreSpiralValidate } from './spiral-score.ts'

const ALL_PASS = {
  arcValidation: { isComplete: true, gaps: [] },
  plotCausalChain: { isSound: true, breaks: [] },
  settingConsistency: { isConsistent: true, contradictions: [] },
  patches: {}
}

test('全通过 → 100 分', () => {
  const r = scoreSpiralValidate(ALL_PASS)
  assert.equal(r.score, 100)
  assert.ok(r.critique.includes('通过'))
})

test('弧光缺口 → -30（70），critique 附缺口', () => {
  const r = scoreSpiralValidate({
    arcValidation: { isComplete: false, gaps: ['第三幕主角动机缺失'] },
    plotCausalChain: { isSound: true, breaks: [] },
    settingConsistency: { isConsistent: true, contradictions: [] }
  })
  assert.equal(r.score, 70)
  assert.ok(r.critique.includes('弧光'))
  assert.ok(r.critique.includes('第三幕主角动机缺失'))
})

test('因果断裂 + 设定矛盾 → 40 分，critique 含两类', () => {
  const r = scoreSpiralValidate({
    arcValidation: { isComplete: true, gaps: [] },
    plotCausalChain: { isSound: false, breaks: ['配角为何突然反水无铺垫'] },
    settingConsistency: { isConsistent: false, contradictions: ['第二章城市名与后文不一致'] }
  })
  assert.equal(r.score, 40)
  assert.ok(r.critique.includes('因果链'))
  assert.ok(r.critique.includes('配角为何突然反水无铺垫'))
  assert.ok(r.critique.includes('设定'))
})

test('三维全挂 → 10 分（下限 0）', () => {
  const r = scoreSpiralValidate({
    arcValidation: { isComplete: false, gaps: ['g1'] },
    plotCausalChain: { isSound: false, breaks: ['b1'] },
    settingConsistency: { isConsistent: false, contradictions: ['c1'] }
  })
  assert.equal(r.score, 10)
})

test('异常结构 → 0 分 + 明确 critique', () => {
  const r = scoreSpiralValidate(null)
  assert.equal(r.score, 0)
  assert.ok(r.critique.includes('缺失'))
})

test('每类问题最多列 3 条防超长', () => {
  const gaps = ['a', 'b', 'c', 'd', 'e']
  const r = scoreSpiralValidate({
    arcValidation: { isComplete: false, gaps },
    plotCausalChain: { isSound: true, breaks: [] },
    settingConsistency: { isConsistent: true, contradictions: [] }
  })
  assert.equal(r.score, 70)
  const listed = (r.critique.match(/^- 缺口：/gm) ?? []).length
  assert.ok(listed <= 3)
  assert.ok(!r.critique.includes('缺口：d'))
})
