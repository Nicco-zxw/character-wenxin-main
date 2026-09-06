import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  buildTraceFromStoryContext,
  CONTEXT_BUDGET_ON,
  CONTEXT_TRACE_ON,
  createContextTrace,
  evaluateContextBudget,
  initContextTraceSchema,
  PROTECTED_TOKEN_BUDGET
} from './context-trace.ts'

function makeCtx() {
  return {
    characterStates: [{
      characterId: '林岚', chapterIndex: 1, location: '城北',
      physicalState: '正常', mentalState: '警觉', arcStage: '', powerLevel: '',
      knowledge: [], inventory: [], goals: []
    }],
    activeForeshadowing: [{
      foreshadowingId: 'fw-1', type: '暗线', description: '旧信', status: 'active',
      plantedChapter: 0, plantedMethod: '道具', payoffChapter: 9, resolvedChapter: null,
      clues: [], connections: []
    }],
    relationships: [{
      relationshipId: 'r1', participantA: '林岚', participantB: '顾川',
      currentStatus: '合作', tensionPoints: [], trajectory: '', lastInteractionChapter: 1
    }],
    recentTimeline: [{ chapterIndex: 1, storyDate: 'D2', events: ['到旧港'], worldStateChanges: [] }],
    worldRules: [{ ruleId: 'w1', ruleContent: '念力异能世界', establishedChapter: 0, exceptions: [], mustComply: true }],
    activeClocks: [{ clockId: 'c1', eventDescription: '地下集会收网', deadlineChapter: 19, status: 'active', urgency: 'high' }]
  }
}

test('P7.4 buildTraceFromStoryContext：六大来源 + protected/compressible 分层 + token 粗估 + 无重复', () => {
  assert.equal(CONTEXT_TRACE_ON, true)
  const t = buildTraceFromStoryContext(makeCtx())
  assert.deepEqual(t.selectedSources.map((s) => s.source), [
    'world_rules', 'active_foreshadowing', 'countdown_clocks',
    'character_states', 'relationships', 'recent_timeline'
  ])
  assert.deepEqual(t.tiers.protected, ['world_rules', 'active_foreshadowing', 'countdown_clocks'])
  assert.deepEqual(t.tiers.compressible, ['character_states', 'relationships', 'recent_timeline'])
  assert.ok(t.tokens.protectedTokens > 0)
  assert.ok(t.tokens.compressibleTokens > 0)
  assert.ok(t.tokens.totalSelectedTokens <= t.tokens.protectedTokens + t.tokens.compressibleTokens)
  // 每源带 reason；source 无重复
  assert.equal(new Set(t.selectedSources.map((s) => s.source)).size, t.selectedSources.length)
  for (const s of t.selectedSources) assert.ok(s.reason.length > 0)
})

test('P7.4 空上下文 → 无来源入选', () => {
  const t = buildTraceFromStoryContext({
    characterStates: [], activeForeshadowing: [], relationships: [],
    recentTimeline: [], worldRules: [], activeClocks: []
  })
  assert.equal(t.selectedSources.length, 0)
  assert.equal(t.tokens.totalSelectedTokens, 0)
})

test('P7.4 createContextTrace 落库读回 + source 去重', () => {
  const db = new DatabaseSync(':memory:')
  initContextTraceSchema(db)
  const t = buildTraceFromStoryContext(makeCtx())
  // 人为加重复来源，落库应去重
  const dup = [...t.selectedSources, t.selectedSources[0]]
  const id = createContextTrace(db, {
    projectId: 'p', chapterIndex: 2, runKind: 'sync', sourceEventId: 'run-9',
    selectedSources: dup, tiers: t.tiers, tokens: t.tokens
  })
  assert.ok(id.startsWith('ct-'))
  const row = db.prepare('SELECT * FROM context_traces WHERE id = ?').get(id)
  assert.equal(row.project_id, 'p')
  assert.equal(row.chapter_index, 2)
  assert.equal(row.run_kind, 'sync')
  assert.equal(row.source_event_id, 'run-9')
  const sources = JSON.parse(row.selected_sources_json)
  assert.equal(new Set(sources.map((s) => s.source)).size, sources.length)
  assert.equal(sources.length, t.selectedSources.length)
})

test('P6.4 evaluateContextBudget：protected 未超限/超限/边界/自定义上限', () => {
  assert.equal(CONTEXT_BUDGET_ON, false) // 默认关=仅审计
  assert.equal(PROTECTED_TOKEN_BUDGET, 8000)
  // 未超限
  const ok = evaluateContextBudget({ protectedTokens: 4000 })
  assert.equal(ok.overBudget, false)
  assert.equal(ok.budgetLimit, 8000)
  assert.equal(ok.exceededBy, 0)
  // 边界：恰好等于上限不算超
  assert.equal(evaluateContextBudget({ protectedTokens: 8000 }).overBudget, false)
  // 超限
  const over = evaluateContextBudget({ protectedTokens: 9000 })
  assert.equal(over.overBudget, true)
  assert.equal(over.exceededBy, 1000)
  // 自定义上限
  assert.equal(evaluateContextBudget({ protectedTokens: 300 }, { budgetLimit: 200 }).overBudget, true)
})

test('P6.4 createContextTrace 附 budget/compression → token_budget_json 含评估、compression_json 落压缩记录', () => {
  const db = new DatabaseSync(':memory:')
  initContextTraceSchema(db)
  const t = buildTraceFromStoryContext(makeCtx())
  const budget = evaluateContextBudget(t.tokens, { budgetLimit: 1 }) // 强制超限
  const id = createContextTrace(db, {
    projectId: 'p', chapterIndex: 3, runKind: 'settle', sourceEventId: 'run-1',
    selectedSources: t.selectedSources, tiers: t.tiers, tokens: t.tokens,
    budget,
    compression: { applied: [], reason: 'protected 超预算（未压缩，不可降级）' }
  })
  const row = db.prepare('SELECT token_budget_json, compression_json FROM context_traces WHERE id = ?').get(id)
  const tb = JSON.parse(row.token_budget_json)
  assert.equal(tb.overBudget, true)
  assert.equal(tb.budgetLimit, 1)
  assert.ok(tb.exceededBy > 0)
  // 兼容旧内容：tokens 字段仍保留
  assert.equal(typeof tb.totalSelectedTokens, 'number')
  const comp = JSON.parse(row.compression_json)
  assert.deepEqual(comp.applied, [])
  assert.ok(comp.reason.includes('超预算'))
})
