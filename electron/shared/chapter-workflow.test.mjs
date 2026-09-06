import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHAPTER_WORKFLOW_ORDER,
  DEFAULT_CHAPTER_WORKFLOW_STEPS,
  resolveWorkflowSteps,
  countCriticalIssues,
  shouldRepairAfterAudit,
  replacementAccepted,
  RE_AUDIT_AFTER_REPAIR,
  runChapterWorkflow
} from './chapter-workflow.ts'

/** 构造桩执行器：按 step.id 返回可配置产出；fail[stepId] 可注入失败。 */
function makeExecutor(opts = {}) {
  const calls = []
  const fail = opts.fail ?? {}
  const executor = async (step) => {
    calls.push(step.id)
    if (fail[step.id]) throw new Error(fail[step.id])
    switch (step.id) {
      case 'memo':
        return { ok: true, structured: opts.memoStructured === undefined ? { currentTask: 'x' } : opts.memoStructured }
      case 'draft':
        return { ok: true, text: opts.draftText === undefined ? 'D'.repeat(1000) : opts.draftText }
      case 'audit':
        return { ok: true, structured: opts.auditResult === undefined ? { pass: true, issues: [] } : opts.auditResult }
      case 'repair':
        return { ok: true, text: opts.repairedText === undefined ? 'R'.repeat(1000) : opts.repairedText }
      case 'humanize':
        return { ok: true, text: opts.humanizedText === undefined ? 'H'.repeat(1000) : opts.humanizedText }
      case 'session-note':
        return { ok: true }
      default:
        return { ok: false }
    }
  }
  return { calls, executor }
}

test('默认顺序与配置：memo→draft→audit→session-note，humanize 默认关，无 repair', async () => {
  const { calls, executor } = makeExecutor()
  const res = await runChapterWorkflow(executor)
  assert.deepEqual(calls, ['memo', 'draft', 'audit', 'session-note'])
  assert.equal(res.ok, true)
  assert.equal(res.aborted, undefined)
  assert.equal(res.repairTriggered, false)
  assert.equal(res.reAudited, false)
  assert.ok(res.memo, '应带回结构化 memo')
  assert.ok(res.finalText && res.finalText.startsWith('D'), '最终正文 = 初稿')
})

test('resolveWorkflowSteps：默认六步 / 顺序 / 默认开关与失败策略', () => {
  const steps = resolveWorkflowSteps(undefined)
  assert.equal(steps.length, 6)
  assert.deepEqual(steps.map((s) => s.id), CHAPTER_WORKFLOW_ORDER)
  assert.equal(steps.find((s) => s.id === 'draft').enabled, true)
  assert.equal(steps.find((s) => s.id === 'draft').failurePolicy, 'stop')
  assert.equal(steps.find((s) => s.id === 'humanize').enabled, false)
  assert.equal(DEFAULT_CHAPTER_WORKFLOW_STEPS.memo.failurePolicy, 'skip')
})

test('resolveWorkflowSteps：覆盖合并（启用 humanize / 关 draft / 带 userPrompt）', () => {
  const steps = resolveWorkflowSteps({
    humanize: { id: 'humanize', enabled: true, failurePolicy: 'skip' },
    draft: { id: 'draft', enabled: false, failurePolicy: 'stop', userPrompt: '改写要求' }
  })
  assert.equal(steps.find((s) => s.id === 'humanize').enabled, true)
  const draft = steps.find((s) => s.id === 'draft')
  assert.equal(draft.enabled, false)
  assert.equal(draft.userPrompt, '改写要求')
  assert.equal(draft.failurePolicy, 'stop')
})

test('决策：shouldRepairAfterAudit 仅在 !pass 且存在 critical 时触发', () => {
  const critical = { pass: false, issues: [{ severity: 'critical' }, { severity: 'warning' }] }
  assert.equal(countCriticalIssues(undefined), 0)
  assert.equal(countCriticalIssues(critical), 1)
  assert.equal(shouldRepairAfterAudit(undefined), false)
  assert.equal(shouldRepairAfterAudit({ pass: true, issues: [{ severity: 'critical' }] }), false)
  assert.equal(shouldRepairAfterAudit({ pass: false, issues: [{ severity: 'warning' }] }), false)
  assert.equal(shouldRepairAfterAudit(critical), true)
})

test('决策：replacementAccepted 长度门（>original*minRatio）', () => {
  assert.equal(replacementAccepted(undefined, 'abc'), false)
  assert.equal(replacementAccepted('abc', undefined), false)
  assert.equal(replacementAccepted('', 'abc'), false)
  assert.equal(replacementAccepted('abc', 'abc'), true) // 等长必然 >0.5
  assert.equal(replacementAccepted('xx', 'xxxx', 0.5), false) // 2 > 2 为假（边界）
  assert.equal(replacementAccepted('xxx', 'xxxx', 0.5), true) // 3 > 2
  assert.equal(replacementAccepted('short', 'D'.repeat(1000)), false)
})

test('audit 报 critical → repair 触发并替换（长度门通过），humanize 默认不跑', async () => {
  const auditCritical = { pass: false, issues: [{ severity: 'critical' }, { severity: 'warning' }] }
  const { calls, executor } = makeExecutor({ auditResult: auditCritical, repairedText: 'R'.repeat(2000) })
  const res = await runChapterWorkflow(executor)
  assert.deepEqual(calls, ['memo', 'draft', 'audit', 'repair', 'session-note'])
  assert.equal(res.repairTriggered, true)
  assert.ok(res.finalText.startsWith('R'), '修复稿应替换初稿')
})

test('audit !pass 但无 critical → 不触发 repair', async () => {
  const auditWarn = { pass: false, issues: [{ severity: 'warning' }] }
  const { calls, executor } = makeExecutor({ auditResult: auditWarn })
  const res = await runChapterWorkflow(executor)
  assert.deepEqual(calls, ['memo', 'draft', 'audit', 'session-note'])
  assert.equal(res.repairTriggered, false)
  assert.ok(res.finalText.startsWith('D'))
})

test('repair 文本过短（长度门未过）→ 不替换，保留初稿', async () => {
  const auditCritical = { pass: false, issues: [{ severity: 'critical' }] }
  const { calls, executor } = makeExecutor({ auditResult: auditCritical, repairedText: 'tiny' })
  const res = await runChapterWorkflow(executor)
  assert.deepEqual(calls, ['memo', 'draft', 'audit', 'repair', 'session-note'])
  assert.equal(res.repairTriggered, false)
  assert.ok(res.finalText.startsWith('D'), '过短修复稿不被采纳')
})

test('memo 禁用 → audit 不执行（门控），仅 draft+session-note', async () => {
  const { calls, executor } = makeExecutor()
  const res = await runChapterWorkflow(executor, {
    steps: { memo: { id: 'memo', enabled: false, failurePolicy: 'skip' } }
  })
  assert.deepEqual(calls, ['draft', 'session-note'])
  assert.equal(res.ok, true)
  assert.ok(res.finalText.startsWith('D'))
})

test('memo 失败（skip）→ draft 继续，audit 因无 memo 跳过', async () => {
  const { calls, executor } = makeExecutor({ fail: { memo: 'memo boom' } })
  const res = await runChapterWorkflow(executor)
  assert.deepEqual(calls, ['memo', 'draft', 'session-note']) // memo 被尝试执行后失败
  assert.equal(res.ok, true)
  assert.equal(res.memo, undefined)
  assert.ok(res.finalText.startsWith('D'))
})

test('draft 失败（stop）→ 中止整个工作流，ok=false/failureStep=draft', async () => {
  const { calls, executor } = makeExecutor({ fail: { draft: 'draft boom' } })
  const res = await runChapterWorkflow(executor)
  assert.deepEqual(calls, ['memo', 'draft'])
  assert.equal(res.ok, false)
  assert.equal(res.aborted, true)
  assert.equal(res.failureStep, 'draft')
  assert.equal(res.finalText, undefined)
})

test('humanize 启用 → 执行并替换（长度门通过）', async () => {
  const { calls, executor } = makeExecutor({ humanizedText: 'H'.repeat(2000) })
  const res = await runChapterWorkflow(executor, {
    steps: { humanize: { id: 'humanize', enabled: true, failurePolicy: 'skip' } }
  })
  assert.deepEqual(calls, ['memo', 'draft', 'audit', 'humanize', 'session-note'])
  assert.ok(res.finalText.startsWith('H'), '润色稿应替换最终正文')
})

test('reAuditAfterRepair=true → repair 后再次 audit（复审），reAudited=true', async () => {
  const auditCritical = { pass: false, issues: [{ severity: 'critical' }] }
  const { calls, executor } = makeExecutor({ auditResult: auditCritical, repairedText: 'R'.repeat(2000) })
  const res = await runChapterWorkflow(executor, { reAuditAfterRepair: true })
  assert.deepEqual(calls, ['memo', 'draft', 'audit', 'repair', 'audit', 'session-note'])
  assert.equal(res.repairTriggered, true)
  assert.equal(res.reAudited, true)
})

test('复审开关默认关（RE_AUDIT_AFTER_REPAIR=false）→ 仅一次 audit', async () => {
  assert.equal(RE_AUDIT_AFTER_REPAIR, false)
  const auditCritical = { pass: false, issues: [{ severity: 'critical' }] }
  const { calls, executor } = makeExecutor({ auditResult: auditCritical, repairedText: 'R'.repeat(2000) })
  const res = await runChapterWorkflow(executor)
  assert.deepEqual(calls, ['memo', 'draft', 'audit', 'repair', 'session-note'])
  assert.equal(res.reAudited, false)
})
