import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LIGHT_CHECK_ERROR_UPGRADE,
  runLightCheck
} from './light-check.ts'

/** StoryStateContext 最小构造 */
function emptyCtx(over = {}) {
  return {
    characterStates: [],
    activeForeshadowing: [],
    relationships: [],
    recentTimeline: [],
    worldRules: [],
    activeClocks: [],
    ...over
  }
}

function charState(id, over = {}) {
  return {
    characterId: id, chapterIndex: 0, location: '', physicalState: '正常', mentalState: '',
    arcStage: '', powerLevel: '', knowledge: [], inventory: [], goals: [],
    ...over
  }
}

function mkDelta(over = {}) {
  return {
    characters_updated: [],
    relationships_delta: [],
    foreshadowing_delta: { planted: [], advanced: [], resolved: [] },
    timeline: { story_time_elapsed: '', current_story_date: '', events: [], world_state_changes: [] },
    ...over
  }
}

test('A1 全局开关默认开启', () => {
  assert.equal(LIGHT_CHECK_ERROR_UPGRADE, true)
})

test('A2b location 粒度宽松：账本「宣化府」vs from「宣化府城门外茶棚」同地不同粒度 → 不报；跨地仍报', () => {
  const ctx = emptyCtx({ characterStates: [charState('林岚', { location: '宣化府' })] })
  const same = runLightCheck('', ctx, mkDelta({
    characters_updated: [{ character_id: '林岚', changes: { location: { from: '宣化府城门外茶棚', to: '宣化府' } } }]
  }))
  assert.equal(same.violations.length, 0)
  assert.equal(same.passed, true)

  const cross = runLightCheck('', ctx, mkDelta({
    characters_updated: [{ character_id: '林岚', changes: { location: { from: '边城', to: '宣化府' } } }]
  }))
  assert.equal(cross.violations.length, 1)
  assert.equal(cross.violations[0].type, 'location_mismatch')
  assert.equal(cross.violations[0].severity, 'error')
})

test('A1 location_mismatch：可确证 → error，passed=false；关闭后回退 warning', () => {
  const ctx = emptyCtx({ characterStates: [charState('林岚', { location: '旧港' })] })
  const delta = mkDelta({
    characters_updated: [{ character_id: '林岚', changes: { location: { from: '城北', to: '渡口' } } }]
  })

  const on = runLightCheck('', ctx, delta)
  assert.equal(on.violations.length, 1)
  assert.equal(on.violations[0].type, 'location_mismatch')
  assert.equal(on.violations[0].severity, 'error')
  assert.equal(on.passed, false)

  const off = runLightCheck('', ctx, delta, { errorUpgrade: false })
  assert.equal(off.violations[0].severity, 'warning')
  assert.equal(off.passed, true)
})

test('A1 item_not_owned：移除库存中不存在的物品 → R4 降级为 warning（易主/未记账持有不可确证）', () => {
  const ctx = emptyCtx({ characterStates: [charState('林岚', { inventory: ['伞'] })] })
  const delta = mkDelta({
    characters_updated: [{
      character_id: '林岚',
      changes: { inventory_delta: { added: [], removed: ['剑'] } }
    }]
  })
  const r = runLightCheck('', ctx, delta)
  assert.equal(r.violations.length, 1)
  assert.equal(r.violations[0].type, 'item_not_owned')
  assert.equal(r.violations[0].severity, 'warning')
  assert.equal(r.passed, true)
})

test('A1 state_conflict：昏迷/死亡却报主动行为且未恢复 → error', () => {
  const ctx = emptyCtx({ characterStates: [charState('林岚', { physicalState: '昏迷' })] })
  const delta = mkDelta({
    characters_updated: [{
      character_id: '林岚',
      changes: { goals_update: { completed: [], added: ['追凶'] } }
    }]
  })
  const r = runLightCheck('', ctx, delta)
  assert.equal(r.violations.length, 1)
  assert.equal(r.violations[0].type, 'state_conflict')
  assert.equal(r.violations[0].severity, 'error')
  assert.equal(r.passed, false)
})

test('A1 rule_violation：关键词启发式（弱证据）即使开启仍保持 warning', () => {
  const ctx = emptyCtx({
    characterStates: [charState('林岚')],
    worldRules: [{
      ruleId: 'w1', ruleContent: '城内禁止使用火把、火焰、火球', establishedChapter: 1,
      exceptions: [], mustComply: true
    }]
  })
  // 命中关键词「使用火」（"使用火把" 中 "把" 被虚词表剔除）与「火焰」≥ 阈值 2
  const r = runLightCheck('他使用火把与火焰', ctx, mkDelta({ characters_updated: [{ character_id: '林岚', changes: {} }] }))
  const rule = r.violations.find((v) => v.type === 'rule_violation')
  assert.ok(rule, '应报 rule_violation')
  assert.equal(rule.severity, 'warning')
})

test('A1 delta 为 null → 直接通过、无违规', () => {
  const r = runLightCheck('任意正文', emptyCtx(), null)
  assert.equal(r.passed, true)
  assert.equal(r.violations.length, 0)
})

test('R3 timeline_break：delta 日期早于账本最近日期（时间倒回）→ error', () => {
  const ctx = emptyCtx({ recentTimeline: [{ chapterIndex: 8, storyDate: '腊月十四', events: [], worldStateChanges: [] }] })
  const delta = mkDelta({
    characters_updated: [{ character_id: '林岚', changes: { mental_state: '困惑' } }],
    timeline: { story_time_elapsed: '从腊月十五到腊月初三', current_story_date: '腊月初三', events: [], world_state_changes: [] }
  })
  const r = runLightCheck('', ctx, delta)
  assert.equal(r.violations.length, 1)
  assert.equal(r.violations[0].type, 'timeline_break')
  assert.equal(r.violations[0].severity, 'error')
  assert.equal(r.passed, false)
})

test('R3 timeline_break：同日/向前推进不误报', () => {
  const ctx = emptyCtx({ recentTimeline: [{ chapterIndex: 8, storyDate: '腊月十四', events: [], worldStateChanges: [] }] })
  for (const date of ['腊月十四', '腊月十五', '正月十五']) {
    const delta = mkDelta({
      characters_updated: [],
      timeline: { story_time_elapsed: '', current_story_date: date, events: [], world_state_changes: [] }
    })
    const r = runLightCheck('', ctx, delta)
    assert.equal(r.passed, true, `日期 ${date} 不应误报倒回`)
    assert.equal(r.violations.length, 0, `日期 ${date} 不应产生违规`)
  }
})

test('R3 timeline_break：无法解析的日期（非中文历法）跳过不误报', () => {
  const ctx = emptyCtx({ recentTimeline: [{ chapterIndex: 8, storyDate: '腊月十四', events: [], worldStateChanges: [] }] })
  const delta = mkDelta({
    timeline: { story_time_elapsed: '', current_story_date: '三日后', events: [], world_state_changes: [] }
  })
  const r = runLightCheck('', ctx, delta)
  assert.equal(r.passed, true)
})

test('③ 无解释瞬移护栏：极短 elapsed 跨地 + 惊讶信号 → teleport_suspected warning（不 error）', () => {
  const ctx = emptyCtx({ characterStates: [charState('林岚', { location: '官道' })] })
  const delta = mkDelta({
    characters_updated: [{ character_id: '林岚', changes: { location: { from: '官道', to: '皇都' } } }],
    timeline: { story_time_elapsed: '一夜', current_story_date: '', events: ['林岚醒来发现自己身在皇都'], world_state_changes: ['林岚从官道瞬移至皇都，骇然'] }
  })
  const r = runLightCheck('', ctx, delta)
  const tp = r.violations.find((v) => v.type === 'teleport_suspected')
  assert.ok(tp, '应报 teleport_suspected')
  assert.equal(tp.severity, 'warning')
  assert.equal(r.passed, true)
})

test('③ 正常长程移动（一日 + 无惊讶信号）不误报；无短时词不报', () => {
  const ctx = emptyCtx({ characterStates: [charState('林岚', { location: '边城' })] })
  const normal = mkDelta({
    characters_updated: [{ character_id: '林岚', changes: { location: { from: '边城', to: '宣化府' } } }],
    timeline: { story_time_elapsed: '三日', current_story_date: '', events: ['抵达宣化府'], world_state_changes: [] }
  })
  assert.equal(runLightCheck('', ctx, normal).violations.length, 0)
  const noElapsed = mkDelta({
    characters_updated: [{ character_id: '林岚', changes: { location: { from: '边城', to: '皇都' } } }],
    timeline: { story_time_elapsed: '', current_story_date: '', events: ['林岚骇然，到了皇都'], world_state_changes: [] }
  })
  assert.equal(runLightCheck('', ctx, noElapsed).violations.length, 0)
})

test('③ 世界规则已登记瞬移许可 → 豁免不报（有意超自然不误伤）', () => {
  const ctx = emptyCtx({
    characterStates: [charState('林岚', { location: '官道' })],
    worldRules: [{ ruleId: 'w1', ruleContent: '主角可瞬间移动', establishedChapter: 1, exceptions: [], mustComply: true }]
  })
  const delta = mkDelta({
    characters_updated: [{ character_id: '林岚', changes: { location: { from: '官道', to: '皇都' } } }],
    timeline: { story_time_elapsed: '眨眼', current_story_date: '', events: ['林岚瞬移至皇都'], world_state_changes: ['骇然'] }
  })
  const r = runLightCheck('', ctx, delta)
  assert.equal(r.violations.find((v) => v.type === 'teleport_suspected'), undefined)
})

