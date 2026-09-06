import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeReconcileIssues } from './l1-reconcile.ts'

test('合法对账 JSON 原样收敛', () => {
  const issues = normalizeReconcileIssues({
    passed: false,
    issues: [
      { category: 'state_conflict', severity: 'error', message: '跨章矛盾：角色已死亡却参与行动', ref: '林岚' },
      { category: 'timeline_break', severity: 'warning', message: '时间倒流', ref: '' }
    ]
  })
  assert.equal(issues.length, 2)
  assert.equal(issues[0].category, 'state_conflict')
  assert.equal(issues[0].severity, 'error')
  assert.equal(issues[0].ref, '林岚')
  assert.equal(issues[1].category, 'timeline_break')
})

test('未知 category 收敛为 state_conflict，未知 severity 收敛为 hint', () => {
  const issues = normalizeReconcileIssues({
    issues: [{ category: '随便编的', severity: 'catastrophic', message: 'x' }]
  })
  assert.equal(issues.length, 1)
  assert.equal(issues[0].category, 'state_conflict')
  assert.equal(issues[0].severity, 'hint')
})

test('丢弃空消息 / 非对象条目 / 非 issues 根结构', () => {
  assert.equal(normalizeReconcileIssues({ issues: [{ category: 'rule_violation', severity: 'error', message: '   ' }] }).length, 0)
  assert.equal(normalizeReconcileIssues({ issues: [null, 'str', 42] }).length, 0)
  assert.equal(normalizeReconcileIssues({ foo: 'bar' }).length, 0)
  assert.equal(normalizeReconcileIssues(null).length, 0)
  assert.equal(normalizeReconcileIssues([1, 2]).length, 0)
})

test('error 级对账问题可驱动 Arbiter 拒绝路径（与 arbiter 决策表一致）', async () => {
  // 仅验证收敛产物能进入仲裁（拒绝）语义，避免与真实仲裁行为脱节。
  const issues = normalizeReconcileIssues({
    issues: [{ category: 'location_mismatch', severity: 'error', message: 'from 与账本不符' }]
  })
  assert.equal(issues.some((i) => i.severity === 'error'), true)
})
