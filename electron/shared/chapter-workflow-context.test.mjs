import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHAPTER_STEP_TASKS,
  criticalIssuesOf,
  formatMemoForRepairText,
  auditSummaryText,
  buildChapterStepContext,
  roleOf
} from './chapter-workflow-context.ts'

const memo = { currentTask: '推动冲突', emotionArc: '由忍到怒', payoffs: ['铜钱'], doNotDo: ['不降智'] }
const audit = { pass: false, issues: [{ severity: 'critical' }, { severity: 'warning' }] }

test('任务名映射覆盖六步', () => {
  assert.equal(CHAPTER_STEP_TASKS.memo, 'chapter-memo')
  assert.equal(CHAPTER_STEP_TASKS.draft, 'chapter-first-draft')
  assert.equal(CHAPTER_STEP_TASKS.audit, 'chapter-audit')
  assert.equal(CHAPTER_STEP_TASKS.repair, 'chapter-repair')
  assert.equal(CHAPTER_STEP_TASKS.humanize, 'chapter-humanize')
  assert.equal(CHAPTER_STEP_TASKS['session-note'], 'chapter-session-note')
  assert.equal(Object.keys(CHAPTER_STEP_TASKS).length, 6)
  assert.equal(roleOf('chapter-audit'), 'audit')
  assert.equal(roleOf('unknown'), undefined)
})

test('criticalIssuesOf：只取 critical', () => {
  const out = criticalIssuesOf(audit)
  assert.equal(out.length, 1)
  assert.equal(out[0].severity, 'critical')
  assert.deepEqual(criticalIssuesOf(undefined), [])
})

test('formatMemoForRepairText：把结构化 memo 渲染为纯文本片段', () => {
  const text = formatMemoForRepairText(memo)
  assert.ok(text.includes('任务：推动冲突'))
  assert.ok(text.includes('情绪轨迹：由忍到怒'))
  assert.ok(text.includes('兑现：铜钱'))
  assert.ok(text.includes('红线：不降智'))
  assert.equal(formatMemoForRepairText(undefined), '')
})

test('auditSummaryText', () => {
  assert.equal(auditSummaryText({ pass: true, issues: [] }), '通过')
  assert.ok(auditSummaryText(audit).includes('未通过，2 个问题'))
  assert.equal(auditSummaryText(undefined), '未审计')
})

test('buildChapterStepContext：以 seed base 为底并叠加各步工作态', () => {
  const base = { projectId: 'p', chapterTitle: '第3章', userPrompt: 'x' }
  const state = { memo, draftText: 'D'.repeat(500), finalText: 'D'.repeat(500), audit, repairedText: 'R'.repeat(500) }

  const memoCtx = buildChapterStepContext('memo', base, state)
  assert.equal(memoCtx.projectId, 'p')
  assert.equal('chapterMemo' in memoCtx, false)

  const draftCtx = buildChapterStepContext('draft', base, state)
  assert.deepEqual(draftCtx.chapterMemo, memo)

  const auditCtx = buildChapterStepContext('audit', base, state)
  assert.equal(auditCtx.draftText, state.draftText)
  assert.deepEqual(auditCtx.chapterMemo, memo)

  const repairCtx = buildChapterStepContext('repair', base, state)
  assert.equal(repairCtx.chapterContent, state.finalText)
  assert.ok(String(repairCtx.chapterMemoText).includes('推动冲突'))
  assert.equal(repairCtx.auditIssues.length, 1)

  const humanizeCtx = buildChapterStepContext('humanize', base, state)
  assert.equal(humanizeCtx.sourceText, state.finalText)

  const noteCtx = buildChapterStepContext('session-note', base, state)
  assert.equal(noteCtx.emotionArc, '由忍到怒')
  assert.equal(noteCtx.auditSummary, '未通过，2 个问题')
  assert.equal(noteCtx.finalSource, '修复稿')
  assert.ok(String(noteCtx.endingSnippet).length <= 200)
})

test('buildChapterStepContext：无最终正文/无 memo 时容错', () => {
  const base = { projectId: 'p' }
  const repairCtx = buildChapterStepContext('repair', base, {})
  assert.equal('chapterContent' in repairCtx, false)
  assert.equal('chapterMemoText' in repairCtx, false)
  assert.deepEqual(repairCtx.auditIssues, [])
  const noteCtx = buildChapterStepContext('session-note', base, {})
  assert.equal(noteCtx.auditSummary, '未审计')
  assert.equal(noteCtx.finalSource, '初稿')
})
