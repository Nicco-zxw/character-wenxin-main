import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_AGENT_PROFILES,
  CHAPTER_AGENT_PROFILES_ENABLED,
  CHAPTER_TASK_ROLES,
  chapterRoleForTask,
  applyAgentProfile,
  resolveRoleProfile,
  resolveStepSettings,
  resolveAgentProfileMaxTokens
} from './agent-profiles.ts'

const base = { model: 'base-model', temperature: 0.7 }

test('内置档位覆盖六个角色且只预设温度（不预设 model）', () => {
  const roles = ['memo', 'draft', 'audit', 'repair', 'humanize', 'session-note']
  for (const role of roles) {
    const p = DEFAULT_AGENT_PROFILES[role]
    assert.ok(p, `${role} 应有默认档位`)
    assert.equal(typeof p.temperature, 'number', `${role} 档位应预设温度`)
    const t = p.temperature ?? -1
    assert.ok(t >= 0 && t <= 2, `${role} 温度应钳制在 [0,2]`)
    assert.equal(p.model, undefined, '内置档位不预设 model（model 覆盖属显式专家项）')
  }
})

test('任务→角色映射覆盖六步任务且未知任务返回 undefined', () => {
  assert.equal(chapterRoleForTask('chapter-memo'), 'memo')
  assert.equal(chapterRoleForTask('chapter-first-draft'), 'draft')
  assert.equal(chapterRoleForTask('chapter-audit'), 'audit')
  assert.equal(chapterRoleForTask('chapter-repair'), 'repair')
  assert.equal(chapterRoleForTask('chapter-humanize'), 'humanize')
  assert.equal(chapterRoleForTask('chapter-session-note'), 'session-note')
  assert.equal(chapterRoleForTask('unknown-task'), undefined)
  assert.equal(Object.keys(CHAPTER_TASK_ROLES).length, 6)
})

test('applyAgentProfile：无 profile / 无可覆盖字段返回原引用', () => {
  assert.equal(applyAgentProfile(base, undefined), base)
  assert.equal(applyAgentProfile(base, {}), base)
  assert.equal(applyAgentProfile(base, { temperature: 0.7 }), base) // 同值不重建
  assert.equal(applyAgentProfile(base, { model: 'base-model' }), base) // 同 model 不重建
})

test('applyAgentProfile：覆盖 temperature 与 model，并保留未动字段（浅拷贝）', () => {
  const settings = { model: 'm', temperature: 0.7, topP: 0.9 }
  const out = applyAgentProfile(settings, { temperature: 0.2, model: 'audit-model' })
  assert.notEqual(out, settings)
  assert.equal(out.model, 'audit-model')
  assert.equal(out.temperature, 0.2)
  assert.equal(out.topP, 0.9) // 未动字段保留
  // 原始对象不被篡改
  assert.equal(settings.model, 'm')
  assert.equal(settings.temperature, 0.7)
})

test('applyAgentProfile：temperature 钳制到 [0,2]', () => {
  assert.equal(applyAgentProfile(base, { temperature: 9 }).temperature, 2)
  assert.equal(applyAgentProfile(base, { temperature: -3 }).temperature, 0)
  assert.equal(applyAgentProfile(base, { temperature: 1.5 }).temperature, 1.5)
})

test('resolveRoleProfile：map 优先，缺省角色回退内置档位', () => {
  const map = { draft: { temperature: 1.0, model: 'draft-x' } }
  assert.equal(resolveRoleProfile(map, 'draft')?.temperature, 1.0)
  assert.equal(resolveRoleProfile(map, 'draft')?.model, 'draft-x')
  assert.equal(resolveRoleProfile(map, 'audit')?.temperature, DEFAULT_AGENT_PROFILES.audit?.temperature)
  assert.equal(resolveRoleProfile(undefined, 'memo')?.temperature, 0.6)
  assert.equal(resolveRoleProfile(map, undefined), undefined)
  assert.equal(resolveRoleProfile(undefined, undefined), undefined)
})

test('resolveStepSettings：合并链 全局→map→内置档位', () => {
  const map = { draft: { temperature: 1.0, model: 'draft-x' } }
  const draft = resolveStepSettings(base, map, 'draft')
  assert.equal(draft.temperature, 1.0)
  assert.equal(draft.model, 'draft-x')

  // audit 不在 map → 回退内置 0.2
  const audit = resolveStepSettings(base, map, 'audit')
  assert.equal(audit.temperature, 0.2)
  assert.equal(audit.model, 'base-model')

  // 无 map 时 draft 走内置档位
  assert.equal(resolveStepSettings(base, undefined, 'draft').temperature, 0.8)
  // 无 role / 无 map → 原引用不变
  assert.equal(resolveStepSettings(base, undefined, undefined), base)
})

test('resolveAgentProfileMaxTokens：profile 优先，否则任务默认', () => {
  assert.equal(resolveAgentProfileMaxTokens(undefined, 4096), 4096)
  assert.equal(resolveAgentProfileMaxTokens({}, 4096), 4096)
  assert.equal(resolveAgentProfileMaxTokens({ maxTokens: 8000 }, 4096), 8000)
  assert.equal(resolveAgentProfileMaxTokens({ maxTokens: 0 }, 4096), 1) // 下限 1
  assert.equal(resolveAgentProfileMaxTokens({ maxTokens: 2048.9 }, 4096), 2048) // 向下取整
  assert.equal(resolveAgentProfileMaxTokens({}, undefined), undefined)
})

test('差异化开关为布尔量（默认关 → 行为与现状一致，可整体回退）', () => {
  assert.equal(typeof CHAPTER_AGENT_PROFILES_ENABLED, 'boolean')
})
