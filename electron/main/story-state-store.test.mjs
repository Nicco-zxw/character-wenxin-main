import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  applyStateDelta,
  bumpProjectLedger,
  buildTruthProjectionMarkdown,
  getCharacterStateAtChapter,
  getLatestCharacterStates,
  getRelationships,
  getRelationshipsAtChapter,
  initStoryStateSchema,
  listChapterSummaries,
  normalizeStateDelta,
  pruneOrphanedStoryEmbeddings,
  queryStateAtChapter,
  readChapterSummary,
  readLedgerValue,
  readProjectLedger,
  setStoryStateClosureEnabled,
  STORY_STATE_CLOSURE_ENABLED,
  summarizeChapterAfterSettlement,
  TRUTH_LEDGER_SCHEMA_VERSION,
  writeLedgerValue
} from './story-state-store.ts'

test('项目账本版本彼此隔离且事务内单调递增', () => {
  const db = new DatabaseSync(':memory:')
  initStoryStateSchema(db)
  assert.equal(readProjectLedger(db, 'p1').ledgerVersion, 0)
  assert.equal(bumpProjectLedger(db, 'p1', { settledThroughChapter: 2 }), 1)
  assert.equal(bumpProjectLedger(db, 'p1', { settledThroughChapter: 3 }), 2)
  assert.equal(readProjectLedger(db, 'p1').settledThroughChapter, 3)
  assert.equal(readProjectLedger(db, 'p2').ledgerVersion, 0)

  initStoryStateSchema(db)
  assert.equal(readProjectLedger(db, 'p1').ledgerVersion, 2)
})

test('畸形状态增量会被规范化为可遍历、可绑定的字段', () => {
  const delta = normalizeStateDelta({
    characters_updated: [{
      character_id: '林岚',
      changes: {
        mental_state: { value: '紧张' },
        arc_progression: ['第一阶段'],
        new_knowledge: ['密道', '密道', { value: '无效' }]
      }
    }],
    foreshadowing_delta: {
      planted: null,
      advanced: { id: '伏笔-1', clue: '旧信出现', method: '侧写' },
      resolved: '无'
    },
    timeline: { events: '抵达城门' }
  })

  assert.deepEqual(delta.foreshadowing_delta.advanced, [{ id: '伏笔-1', clue: '旧信出现', method: '侧写' }])
  assert.equal(delta.characters_updated[0].changes.mental_state, undefined)
  assert.deepEqual(delta.characters_updated[0].changes.new_knowledge, ['密道'])
  assert.deepEqual(delta.timeline.events, [])
})

test('同一章节状态增量重复写入不会重复累积数组字段', () => {
  const db = new DatabaseSync(':memory:')
  initStoryStateSchema(db)
  const delta = normalizeStateDelta({
    characters_updated: [{
      character_id: '林岚',
      changes: {
        mental_state: '警觉',
        inventory_delta: { added: ['旧信'], removed: [] },
        new_knowledge: ['密道入口'],
        goals_update: { completed: [], added: ['找到证人'] }
      }
    }],
    relationships_delta: [{
      relationship_id: '林岚-顾川',
      participants: ['林岚', '顾川'],
      status_change: { from: '陌生', to: '合作', pivot_event: '共同脱险' },
      new_tension_points: ['互不信任']
    }],
    foreshadowing_delta: {
      planted: [{ id: '伏笔-1', type: '暗线', description: '旧信', method: '道具', payoff_chapter: 20 }],
      advanced: [{ id: '伏笔-1', clue: '火漆印', method: '特写' }],
      resolved: []
    },
    timeline: { current_story_date: '第三日', events: ['离城'] }
  })

  applyStateDelta(db, 'project-1', 3, delta)
  applyStateDelta(db, 'project-1', 3, delta)

  const character = db.prepare('SELECT knowledge_json, inventory_json, goals_json FROM story_character_state').get()
  const relationship = db.prepare('SELECT tension_points_json FROM story_relationships').get()
  const foreshadowing = db.prepare('SELECT clues_json FROM story_foreshadowing').get()
  assert.deepEqual(JSON.parse(character.knowledge_json), ['密道入口'])
  assert.deepEqual(JSON.parse(character.inventory_json), ['旧信'])
  assert.deepEqual(JSON.parse(character.goals_json), ['找到证人'])
  assert.deepEqual(JSON.parse(relationship.tension_points_json), ['互不信任'])
  assert.deepEqual(JSON.parse(foreshadowing.clues_json), [{ chapter: 3, clue: '火漆印', method: '特写' }])
})

test('P7.0 账本自身账：init 写 schema_version，读写与幂等', () => {
  const db = new DatabaseSync(':memory:')
  initStoryStateSchema(db)
  // 首次建库默认写入结构版本
  assert.equal(readLedgerValue(db, 'schema_version'), TRUTH_LEDGER_SCHEMA_VERSION)
  // upsert：第二次覆盖并记录 updated_at（写入高于当前结构版本的值 → re-init 不降级）
  writeLedgerValue(db, 'schema_version', '9')
  assert.equal(readLedgerValue(db, 'schema_version'), '9')
  // 不存在键 → null
  assert.equal(readLedgerValue(db, 'not-exist'), null)
  // init 幂等：不覆盖已人工升版的值
  initStoryStateSchema(db)
  assert.equal(readLedgerValue(db, 'schema_version'), '9')
})

// P7.1 closure：可组合的整包 delta helper
function mkDelta(loc, extra = {}) {
  return {
    characters_updated: loc
      ? [{ character_id: '林岚', changes: { location: { from: '', to: loc }, mental_state: '平静' } }]
      : [],
    relationships_delta: [],
    foreshadowing_delta: {
      planted: extra.planted ?? [],
      advanced: [],
      resolved: extra.resolved ?? []
    },
    timeline: {
      story_time_elapsed: '',
      current_story_date: extra.date ?? '',
      events: extra.events ?? [],
      world_state_changes: []
    }
  }
}

test('P7.1 closure：跨章关门 + 同章重结算不产生重复当前行', () => {
  const db = new DatabaseSync(':memory:')
  initStoryStateSchema(db)

  applyStateDelta(db, 'p', 0, mkDelta('城北'))
  applyStateDelta(db, 'p', 1, mkDelta('旧港'))

  // 跨章 → 两行：第0章行被关门（until=0），第1章为当前生效行
  const rows = db.prepare('SELECT chapter_index, valid_from_chapter, valid_until_chapter FROM story_character_state ORDER BY valid_from_chapter').all()
  assert.equal(rows.length, 2)
  assert.equal(rows[0].valid_from_chapter, 0)
  assert.equal(rows[0].valid_until_chapter, 0)
  assert.equal(rows[1].valid_from_chapter, 1)
  assert.equal(rows[1].valid_until_chapter, null)
  assert.equal(getLatestCharacterStates(db, 'p', ['林岚'])[0].location, '旧港')

  // 同章重结算 → 覆盖该行，仍两行且不重复当前行
  applyStateDelta(db, 'p', 1, mkDelta('旧港渡口'))
  assert.equal(db.prepare('SELECT COUNT(*) cnt FROM story_character_state').get().cnt, 2)
  assert.equal(getLatestCharacterStates(db, 'p', ['林岚'])[0].location, '旧港渡口')
})

test('P7.1 任意章点：getCharacterStateAtChapter 走生效区间', () => {
  const db = new DatabaseSync(':memory:')
  initStoryStateSchema(db)

  applyStateDelta(db, 'p', 0, mkDelta('城北'))
  applyStateDelta(db, 'p', 3, mkDelta('旧港'))

  assert.equal(getCharacterStateAtChapter(db, 'p', '林岚', 0).location, '城北')
  assert.equal(getCharacterStateAtChapter(db, 'p', '林岚', 1).location, '城北')
  assert.equal(getCharacterStateAtChapter(db, 'p', '林岚', 2).location, '城北')
  assert.equal(getCharacterStateAtChapter(db, 'p', '林岚', 3).location, '旧港')
  // 该章前未出现的角色 → null
  assert.equal(getCharacterStateAtChapter(db, 'p', '顾川', 3), null)
})

test('P7.1 queryStateAtChapter：任意章点世界状态整包（伏笔按章过滤）', () => {
  const db = new DatabaseSync(':memory:')
  initStoryStateSchema(db)

  applyStateDelta(db, 'p', 0, mkDelta('城北', {
    planted: [{ id: 'fw-a', type: '暗线', description: '旧信', method: '道具', payoff_chapter: 4 }],
    date: 'D1', events: ['抵达城北']
  }))
  applyStateDelta(db, 'p', 2, mkDelta('旧港', { date: 'D3', events: ['到旧港'] }))
  applyStateDelta(db, 'p', 3, mkDelta(null, { resolved: [{ id: 'fw-a', method: '揭示', impact: 'X' }], date: 'D4', events: ['揭晓'] }))

  // 第1章视角：城北仍生效；伏笔A active；时间线只有第0章
  const at1 = queryStateAtChapter(db, 'p', 1)
  assert.equal(at1.characterStates[0].location, '城北')
  assert.equal(at1.activeForeshadowing.length, 1)
  assert.equal(at1.recentTimeline[at1.recentTimeline.length - 1].events[0], '抵达城北')
  // 第2章视角：旧港
  assert.equal(queryStateAtChapter(db, 'p', 2).characterStates[0].location, '旧港')
  // 第3章视角（回收后）：伏笔A 不再 active
  const at3 = queryStateAtChapter(db, 'p', 3)
  assert.equal(at3.characterStates[0].location, '旧港')
  assert.equal(at3.activeForeshadowing.length, 0)
})

test('P7.1 旧库迁移：补 closure 列 + 重建索引 + valid_from 回填 + 版本升 2', () => {
  const db = new DatabaseSync(':memory:')
  // 模拟 P7.0 前旧库：无 valid_* 列、旧唯一索引、且无其它表
  db.exec(`
    CREATE TABLE story_character_state (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, character_id TEXT NOT NULL,
      chapter_index INTEGER NOT NULL, location TEXT NOT NULL DEFAULT '',
      physical_state TEXT NOT NULL DEFAULT '正常', mental_state TEXT NOT NULL DEFAULT '',
      arc_stage TEXT NOT NULL DEFAULT '', power_level TEXT NOT NULL DEFAULT '',
      knowledge_json TEXT NOT NULL DEFAULT '[]', inventory_json TEXT NOT NULL DEFAULT '[]',
      goals_json TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX idx_char_state_unique
      ON story_character_state(project_id, character_id, chapter_index);
    CREATE TABLE story_foreshadowing (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, foreshadowing_id TEXT NOT NULL,
      type TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      planted_chapter INTEGER NOT NULL, planted_method TEXT NOT NULL DEFAULT '',
      payoff_chapter INTEGER, resolved_chapter INTEGER,
      clues_json TEXT NOT NULL DEFAULT '[]', connections_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    ) STRICT;
  `)
  // 旧数据（旧 REPLACE 语义：同角色跨章保留多行，无 valid_* 列）：林岚第3章『旧港』、第5章『海边』
  const ins = db.prepare(`INSERT INTO story_character_state
    (id, project_id, character_id, chapter_index, location, updated_at)
    VALUES (?, 'p', '林岚', ?, ?, 't')`)
  ins.run('s1', 3, '旧港')
  ins.run('s2', 5, '海边')

  // 迁移不应抛错（此前缺陷：同角色多行加列后全为 until=NULL → 建「当前行部分唯一」索引 UNIQUE 冲突）
  initStoryStateSchema(db)

  const cols = db.prepare('PRAGMA table_info(story_character_state)').all().map((c) => String(c.name))
  for (const col of ['valid_from_chapter', 'valid_until_chapter', 'source_event_id', 'actor']) {
    assert.ok(cols.includes(col), `缺列 ${col}`)
  }
  // 旧唯一索引已换成「当前行部分唯一」
  const idxNames = db.prepare('PRAGMA index_list(story_character_state)').all().map((r) => String(r.name))
  assert.ok(idxNames.includes('idx_char_state_current'))
  assert.ok(!idxNames.includes('idx_char_state_unique'))
  // 存量规范化：非最大章行关门到下一章-1；最大章行保持 NULL=当前
  const row1 = db.prepare('SELECT valid_from_chapter, valid_until_chapter FROM story_character_state WHERE id = ?').get('s1')
  assert.equal(row1.valid_from_chapter, 3)
  assert.equal(row1.valid_until_chapter, 4)
  const row2 = db.prepare('SELECT valid_from_chapter, valid_until_chapter FROM story_character_state WHERE id = ?').get('s2')
  assert.equal(row2.valid_from_chapter, 5)
  assert.equal(row2.valid_until_chapter, null)
  // 当前 = 第5章；第4章视角 = 第3章态
  assert.equal(getLatestCharacterStates(db, 'p', ['林岚'])[0].location, '海边')
  assert.equal(getCharacterStateAtChapter(db, 'p', '林岚', 4).location, '旧港')
  // 版本升 2 且留痕
  assert.equal(readLedgerValue(db, 'schema_version'), TRUTH_LEDGER_SCHEMA_VERSION)
  assert.ok(readLedgerValue(db, 'migration').includes('-> 3'))
  // 迁移后可正常 closure 写读
  applyStateDelta(db, 'p', 5, mkDelta('更远处'))
  assert.equal(getLatestCharacterStates(db, 'p', ['林岚'])[0].location, '更远处')
  assert.equal(getCharacterStateAtChapter(db, 'p', '林岚', 3).location, '旧港')
})

test('P7.1 回退开关：STORY_STATE_CLOSURE_ENABLED=false 走旧 REPLACE 语义', () => {
  const prev = STORY_STATE_CLOSURE_ENABLED
  setStoryStateClosureEnabled(false)
  try {
    const db = new DatabaseSync(':memory:')
    initStoryStateSchema(db)
    applyStateDelta(db, 'p', 0, mkDelta('城北'))
    applyStateDelta(db, 'p', 1, mkDelta('旧港'))
    // 旧语义：跨章两行（按章各自一行），latest = max chapter
    assert.equal(db.prepare('SELECT COUNT(*) cnt FROM story_character_state').get().cnt, 2)
    assert.equal(getLatestCharacterStates(db, 'p', ['林岚'])[0].location, '旧港')
    // 同章 REPLACE 仍单行
    applyStateDelta(db, 'p', 1, mkDelta('渡口'))
    assert.equal(db.prepare('SELECT COUNT(*) cnt FROM story_character_state').get().cnt, 2)
    assert.equal(getLatestCharacterStates(db, 'p', ['林岚'])[0].location, '渡口')
  } finally {
    setStoryStateClosureEnabled(prev)
  }
})

test('P7.2 applyStateDelta 带 sourceEventId/actor 归因角色/关系/伏笔行', () => {
  const db = new DatabaseSync(':memory:')
  initStoryStateSchema(db)
  const full = {
    characters_updated: [{ character_id: '林岚', changes: { location: { from: '', to: '城北' } } }],
    relationships_delta: [{
      relationship_id: '林岚-顾川',
      participants: ['林岚', '顾川'],
      status_change: { from: '陌生', to: '合作', pivot_event: '共同脱险' }
    }],
    foreshadowing_delta: {
      planted: [{ id: 'fw-1', type: '暗线', description: '旧信', method: '道具', payoff_chapter: 9 }],
      advanced: [],
      resolved: []
    },
    timeline: { story_time_elapsed: '', current_story_date: '', events: [], world_state_changes: [] }
  }
  applyStateDelta(db, 'p', 0, full, { sourceEventId: 'run-1', actor: 'observer' })
  assert.equal(db.prepare("SELECT source_event_id FROM story_character_state WHERE character_id = '林岚'").get().source_event_id, 'run-1')
  assert.equal(db.prepare("SELECT actor FROM story_character_state WHERE character_id = '林岚'").get().actor, 'observer')
  assert.equal(db.prepare("SELECT source_event_id FROM story_relationships WHERE relationship_id = '林岚-顾川'").get().source_event_id, 'run-1')
  assert.equal(db.prepare("SELECT source_event_id FROM story_foreshadowing WHERE foreshadowing_id = 'fw-1'").get().source_event_id, 'run-1')

  // 第2章跨章写新行 → 新行 source=run-2；closure 关门行 source 保持 run-1
  applyStateDelta(db, 'p', 2, {
    characters_updated: [{ character_id: '林岚', changes: { location: { from: '城北', to: '旧港' } } }],
    relationships_delta: [],
    foreshadowing_delta: { planted: [], advanced: [], resolved: [] },
    timeline: { story_time_elapsed: '', current_story_date: '', events: [], world_state_changes: [] }
  }, { sourceEventId: 'run-2', actor: 'observer' })
  const rows = db.prepare('SELECT valid_from_chapter, source_event_id FROM story_character_state ORDER BY valid_from_chapter').all()
  assert.equal(rows.length, 2)
  assert.equal(rows[0].source_event_id, 'run-1')
  assert.equal(rows[1].valid_from_chapter, 2)
  assert.equal(rows[1].source_event_id, 'run-2')
})

test('P7.3 章摘要账：确定性聚合 + 覆盖重算 + 读取/列表（无 chapters 表容错）', () => {
  const db = new DatabaseSync(':memory:')
  initStoryStateSchema(db)
  const delta = {
    characters_updated: [{ character_id: '林岚', changes: { location: { from: '', to: '城北' } } }],
    relationships_delta: [{
      relationship_id: '林岚-顾川',
      participants: ['林岚', '顾川'],
      status_change: { from: '陌生', to: '合作', pivot_event: '共同脱险' }
    }],
    foreshadowing_delta: {
      planted: [{ id: 'fw-1', type: '暗线', description: '旧信', method: '道具', payoff_chapter: 9 }],
      advanced: [],
      resolved: []
    },
    timeline: { story_time_elapsed: '', current_story_date: 'D1', events: ['抵达城北'], world_state_changes: [] }
  }
  summarizeChapterAfterSettlement(db, 'p', 0, delta, 'run-1')

  const s = readChapterSummary(db, 'p', 0)
  assert.equal(s.title, '') // 无 chapters 表 → 容错空标题
  assert.deepEqual([...s.characters].sort(), ['林岚', '顾川'].sort())
  assert.deepEqual(s.events, ['抵达城北'])
  assert.ok(s.stateChanges.includes('characters'))
  assert.ok(s.stateChanges.includes('relationships'))
  assert.ok(s.stateChanges.includes('foreshadowing'))
  assert.ok(s.stateChanges.includes('timeline'))
  assert.deepEqual(s.hookActivity, { planted: 1, advanced: 0, resolved: 0 })
  assert.equal(s.sourceEventId, 'run-1')

  // 同章重结算 → 摘要覆盖重算
  const delta2 = {
    characters_updated: [], relationships_delta: [],
    foreshadowing_delta: { planted: [], advanced: [], resolved: [] },
    timeline: { story_time_elapsed: '', current_story_date: 'D2', events: ['离城'], world_state_changes: [] }
  }
  summarizeChapterAfterSettlement(db, 'p', 0, delta2, 'run-2')
  const s2 = readChapterSummary(db, 'p', 0)
  assert.deepEqual(s2.events, ['离城'])
  assert.equal(s2.characters.length, 0)
  assert.equal(s2.sourceEventId, 'run-2')

  // 多章列表（章号倒序）
  summarizeChapterAfterSettlement(db, 'p', 1, delta, 'run-3')
  const list = listChapterSummaries(db, 'p', 10)
  assert.equal(list.length, 2)
  assert.equal(list[0].chapterIndex, 1)
  assert.equal(list[1].chapterIndex, 0)
  // 未摘要章 → null
  assert.equal(readChapterSummary(db, 'p', 3), null)
})

test('P7.5 旧库迁移：story_embeddings 补 content_hash / valid_until_chapter 列', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE story_embeddings (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_type TEXT NOT NULL,
      source_id TEXT NOT NULL, chapter_index INTEGER, text_content TEXT NOT NULL,
      embedding BLOB NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
  `)
  initStoryStateSchema(db)
  const cols = db.prepare('PRAGMA table_info(story_embeddings)').all().map((c) => String(c.name))
  assert.ok(cols.includes('content_hash'))
  assert.ok(cols.includes('valid_until_chapter'))
})

test('P7.5 pruneOrphanedStoryEmbeddings：删除来源已不存在的向量残留', () => {
  const db = new DatabaseSync(':memory:')
  initStoryStateSchema(db)
  db.exec(`CREATE TABLE chapters (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL) STRICT;`)
  db.exec(`CREATE TABLE reference_works (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '') STRICT;`)
  db.prepare("INSERT INTO chapters (id, project_id, title, sort_order) VALUES ('c1', 'p', '章1', 0)").run()
  db.prepare("INSERT INTO reference_works (id, project_id, title) VALUES ('r1', 'p', '书A')").run()
  const ins = db.prepare(`INSERT INTO story_embeddings (id, project_id, source_type, source_id, text_content, embedding, created_at) VALUES (?, 'p', ?, ?, 'x', zeroblob(16), 't')`)
  ins.run('e1', 'chapter_segment', 'c1')
  ins.run('e2', 'chapter_segment', 'cGONE')
  ins.run('e3', 'reference_novel', 'r1')
  ins.run('e4', 'reference_novel', 'rGONE')
  const removed = pruneOrphanedStoryEmbeddings(db, 'p')
  assert.equal(removed, 2)
  const left = db.prepare('SELECT id FROM story_embeddings ORDER BY id').all().map((r) => String(r.id))
  assert.deepEqual(left, ['e1', 'e3'])
  // 无引用表（纯 story 内存库）→ 安全跳过
  const db2 = new DatabaseSync(':memory:')
  initStoryStateSchema(db2)
  assert.equal(pruneOrphanedStoryEmbeddings(db2, 'p'), 0)
})

test('P7.6 buildTruthProjectionMarkdown：当前态 + 章摘要账投影', () => {
  const db = new DatabaseSync(':memory:')
  initStoryStateSchema(db)
  const delta = mkDelta('城北', {
    date: 'D1', events: ['抵达城北'],
    planted: [{ id: 'fw-1', type: '暗线', description: '旧信', method: '道具', payoff_chapter: 9 }]
  })
  applyStateDelta(db, 'p', 0, delta)
  summarizeChapterAfterSettlement(db, 'p', 0, delta, 'run-0')

  const md = buildTruthProjectionMarkdown(db, 'p')
  assert.ok(md.includes('# 世界真相投影'))
  assert.ok(md.includes('## 当前世界状态'))
  assert.ok(md.includes('### 角色当前状态'))
  assert.ok(md.includes('## 逐章摘要账'))
  assert.ok(md.includes('第0章'))
  assert.ok(md.includes('run-0'))
  // 只读投影不写回：story 表行数不变（再调一次幂等无副作用）
  const cnt = db.prepare('SELECT COUNT(*) cnt FROM story_character_state').get().cnt
  buildTruthProjectionMarkdown(db, 'p')
  assert.equal(db.prepare('SELECT COUNT(*) cnt FROM story_character_state').get().cnt, cnt)
})

// ---------- B1：关系 closure 生效区间 ----------
function relDelta(rid, participants, statusTo, extra = {}) {
  return {
    characters_updated: [],
    relationships_delta: [{
      relationship_id: rid,
      participants,
      status_change: { from: '', to: statusTo, pivot_event: extra.pivot ?? '' },
      new_tension_points: extra.tension ?? []
    }],
    foreshadowing_delta: { planted: [], advanced: [], resolved: [] },
    timeline: { story_time_elapsed: '', current_story_date: '', events: [], world_state_changes: [] }
  }
}

test('B1 closure：关系跨章关门+插新行；同章重结算不重复当前行', () => {
  const db = new DatabaseSync(':memory:')
  initStoryStateSchema(db)
  applyStateDelta(db, 'p', 1, relDelta('r-AB', ['A', 'B'], '相识', { pivot: '客栈' }))
  applyStateDelta(db, 'p', 4, relDelta('r-AB', ['A', 'B'], '深交', { pivot: '共患难', tension: ['信任'] }))

  const rows = db.prepare('SELECT valid_from_chapter, valid_until_chapter, current_status FROM story_relationships ORDER BY valid_from_chapter').all()
  assert.equal(rows.length, 2)
  assert.equal(rows[0].valid_from_chapter, 1)
  assert.equal(rows[0].valid_until_chapter, 3)
  assert.equal(rows[0].current_status, '相识')
  assert.equal(rows[1].valid_from_chapter, 4)
  assert.equal(rows[1].valid_until_chapter, null)
  assert.equal(rows[1].current_status, '深交')
  assert.equal(getRelationships(db, 'p')[0].currentStatus, '深交')

  // 同章重结算 → 覆盖当前行，仍两行
  applyStateDelta(db, 'p', 4, relDelta('r-AB', ['A', 'B'], '患难之交', { tension: ['信任'] }))
  assert.equal(db.prepare('SELECT COUNT(*) c FROM story_relationships').get().c, 2)
  assert.equal(getRelationships(db, 'p')[0].currentStatus, '患难之交')
})

test('B1 任意章点：getRelationshipsAtChapter 走生效区间；queryStateAtChapter 同语义', () => {
  const db = new DatabaseSync(':memory:')
  initStoryStateSchema(db)
  applyStateDelta(db, 'p', 1, relDelta('r-AB', ['A', 'B'], '相识'))
  applyStateDelta(db, 'p', 3, relDelta('r-AB', ['A', 'B'], '深交'))

  assert.equal(getRelationshipsAtChapter(db, 'p', 0).length, 0)
  assert.equal(getRelationshipsAtChapter(db, 'p', 2)[0].currentStatus, '相识')
  assert.equal(getRelationshipsAtChapter(db, 'p', 3)[0].currentStatus, '深交')
  assert.equal(queryStateAtChapter(db, 'p', 2).relationships[0].currentStatus, '相识')
  assert.equal(queryStateAtChapter(db, 'p', 3).relationships[0].currentStatus, '深交')
})

test('B1 旧库迁移：关系补 closure 列 + 重建当前索引 + valid_from 回填 + 版本升 3', () => {
  const db = new DatabaseSync(':memory:')
  // 模拟 B1 前旧库：story_relationships 无 valid_* 列 + 旧唯一索引（rid 唯一单行）
  db.exec(`
    CREATE TABLE story_relationships (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, relationship_id TEXT NOT NULL,
      participant_a TEXT NOT NULL, participant_b TEXT NOT NULL,
      current_status TEXT NOT NULL, tension_points_json TEXT NOT NULL DEFAULT '[]',
      trajectory TEXT NOT NULL DEFAULT '', last_interaction_chapter INTEGER,
      source_event_id TEXT, actor TEXT NOT NULL DEFAULT 'observer', updated_at TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX idx_relationships_project_rid
      ON story_relationships(project_id, relationship_id);
    INSERT INTO story_relationships
      (id, project_id, relationship_id, participant_a, participant_b, current_status, last_interaction_chapter, updated_at)
      VALUES ('r1', 'p', 'r-AB', 'A', 'B', '相识', 2, 't');
  `)

  // 迁移不应抛错（需先 DROP 旧唯一索引再建「当前行部分唯一」）
  initStoryStateSchema(db)

  const cols = db.prepare('PRAGMA table_info(story_relationships)').all().map((c) => String(c.name))
  assert.ok(cols.includes('valid_from_chapter'))
  assert.ok(cols.includes('valid_until_chapter'))
  const idx = db.prepare('PRAGMA index_list(story_relationships)').all().map((r) => String(r.name))
  assert.ok(idx.includes('idx_relationships_current'))
  assert.ok(!idx.includes('idx_relationships_project_rid'))
  const row = db.prepare("SELECT valid_from_chapter, valid_until_chapter FROM story_relationships WHERE relationship_id = 'r-AB'").get()
  assert.equal(row.valid_from_chapter, 2)
  assert.equal(row.valid_until_chapter, null)
  assert.equal(readLedgerValue(db, 'schema_version'), TRUTH_LEDGER_SCHEMA_VERSION)
  assert.ok(readLedgerValue(db, 'migration').includes('-> 3'))
  // 迁移后可正常 closure 写读
  applyStateDelta(db, 'p', 5, relDelta('r-AB', ['A', 'B'], '深交'))
  assert.equal(getRelationshipsAtChapter(db, 'p', 2)[0].currentStatus, '相识')
  assert.equal(getRelationshipsAtChapter(db, 'p', 5)[0].currentStatus, '深交')
})

test('B1 回退开关：closure=false 关系走单行 UPDATE/INSERT', () => {
  const prev = STORY_STATE_CLOSURE_ENABLED
  setStoryStateClosureEnabled(false)
  try {
    const db = new DatabaseSync(':memory:')
    initStoryStateSchema(db)
    applyStateDelta(db, 'p', 1, relDelta('r-AB', ['A', 'B'], '相识'))
    applyStateDelta(db, 'p', 4, relDelta('r-AB', ['A', 'B'], '深交'))
    assert.equal(db.prepare('SELECT COUNT(*) c FROM story_relationships').get().c, 1)
    assert.equal(getRelationships(db, 'p')[0].currentStatus, '深交')
  } finally {
    setStoryStateClosureEnabled(prev)
  }
})
