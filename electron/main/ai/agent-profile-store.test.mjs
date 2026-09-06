import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  AGENT_ROLES,
  initAgentProfileSchema,
  readProjectAgentProfiles,
  readProjectAgentSettings,
  sanitizeAgentProfiles,
  writeProjectAgentProfiles,
  writeProjectAgentSettings
} from './agent-profile-store.ts'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  initAgentProfileSchema(db)
  return db
}

test('sanitize：只保留六角色、丢弃未知角色与字段', () => {
  const clean = sanitizeAgentProfiles({
    draft: { model: 'x', temperature: 0.8, maxTokens: 4000, junk: 1 },
    audit: { temperature: 0.2 },
    bogusRole: { model: 'y' }
  })
  assert.deepEqual(clean, {
    draft: { model: 'x', temperature: 0.8, maxTokens: 4000 },
    audit: { temperature: 0.2 }
  })
  assert.equal('bogusRole' in clean, false)
})

test('sanitize：clamp temperature 0-2、maxTokens ≥1 整数、空 profile 丢弃', () => {
  const clean = sanitizeAgentProfiles({
    memo: { temperature: 9, maxTokens: 0.4 },
    humanize: {}
  })
  assert.equal(clean.memo?.temperature, 2)
  assert.equal(clean.memo?.maxTokens, 1)
  assert.equal(clean.humanize, undefined)
  assert.equal(AGENT_ROLES.length, 6)
})

test('sanitize：脏输入/非对象 → {}', () => {
  assert.deepEqual(sanitizeAgentProfiles(null), {})
  assert.deepEqual(sanitizeAgentProfiles('x'), {})
  assert.deepEqual(sanitizeAgentProfiles(undefined), {})
})

test('读：无配置 → {}；写读回环（覆盖更新）', () => {
  const db = makeDb()
  assert.deepEqual(readProjectAgentProfiles(db, 'p1'), {})

  const saved = writeProjectAgentProfiles(db, 'p1', {
    draft: { model: 'creative', temperature: 0.9 },
    audit: { temperature: 0.1 }
  })
  assert.deepEqual(saved.draft?.model, 'creative')
  assert.deepEqual(readProjectAgentProfiles(db, 'p1'), {
    draft: { model: 'creative', temperature: 0.9 },
    audit: { temperature: 0.1 }
  })

  // 覆盖更新只保留新写入的角色
  writeProjectAgentProfiles(db, 'p1', { draft: { temperature: 0.5 } })
  assert.deepEqual(readProjectAgentProfiles(db, 'p1'), { draft: { temperature: 0.5 } })
})

test('读：项目隔离（p1 写入不影响 p2）', () => {
  const db = makeDb()
  writeProjectAgentProfiles(db, 'p1', { draft: { temperature: 0.8 } })
  assert.deepEqual(readProjectAgentProfiles(db, 'p2'), {})
  assert.equal(readProjectAgentProfiles(db, 'p1').draft?.temperature, 0.8)
})

test('settings：默认 disabled + 空 profiles；写入 enabled 后读回', () => {
  const db = makeDb()
  assert.deepEqual(readProjectAgentSettings(db, 'p1'), { enabled: false, profiles: {} })

  const saved = writeProjectAgentSettings(db, 'p1', { enabled: true, profiles: { draft: { temperature: 0.9 } } })
  assert.equal(saved.enabled, true)
  assert.deepEqual(saved.profiles, { draft: { temperature: 0.9 } })
  assert.deepEqual(readProjectAgentSettings(db, 'p1'), { enabled: true, profiles: { draft: { temperature: 0.9 } } })

  // 关闭不影响 profiles
  writeProjectAgentSettings(db, 'p1', { enabled: false })
  const after = readProjectAgentSettings(db, 'p1')
  assert.equal(after.enabled, false)
  assert.deepEqual(after.profiles, { draft: { temperature: 0.9 } })
})

test('settings：writeProjectAgentProfiles 写 profiles 时 enabled 保持默认关', () => {
  const db = makeDb()
  writeProjectAgentProfiles(db, 'p1', { audit: { temperature: 0.1 } })
  const s = readProjectAgentSettings(db, 'p1')
  assert.equal(s.enabled, false)
  assert.deepEqual(s.profiles, { audit: { temperature: 0.1 } })
})

test('旧表（无 enabled 列）启动 initAgentProfileSchema 自动补列', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE project_agent_profiles (
      project_id TEXT PRIMARY KEY,
      profiles_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    ) STRICT;
  `)
  db.prepare(`INSERT INTO project_agent_profiles (project_id, profiles_json, updated_at) VALUES ('p1', '{}', 't')`).run()
  initAgentProfileSchema(db)
  const cols = db.prepare('PRAGMA table_info(project_agent_profiles)').all().map((c) => c.name)
  assert.ok(cols.includes('enabled'))
  assert.deepEqual(readProjectAgentSettings(db, 'p1'), { enabled: false, profiles: {} })
})
