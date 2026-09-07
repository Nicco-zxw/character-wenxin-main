import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  applyRollbackPlan,
  applyStateDelta,
  bumpProjectLedger,
  getActiveForeshadowing,
  getLatestCharacterStates,
  getRelationships,
  initStoryStateSchema,
  listChaptersNeedingResettlement,
  planRollbackToChapter,
  queryStateAtChapter,
  readProjectLedger,
  summarizeChapterAfterSettlement
} from '../../story-state-store.ts'
import {
  clearSettlementSnapshots,
  hasSettledContent,
  initSettlementSchema,
  isLatestChapter,
  latestSettlementCreatedAt,
  latestSettledChapterIndex,
  markSettlementRolledBack,
  readSettlementRun,
  recordSettlementRun,
  resolveChapterOrdinal,
  rollbackSettlementState,
  setSettlementRunTrace,
  settlementContentHash,
  snapshotSettlementState
} from './settlement-store.ts'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  initStoryStateSchema(db)
  initSettlementSchema(db)
  return db
}

function charDelta(id, { from, to, knowledge = [] }, foreshadowing = {}) {
  return {
    characters_updated: [{
      character_id: id,
      changes: {
        location: { from, to },
        ...(knowledge.length ? { new_knowledge: knowledge } : {})
      }
    }],
    relationships_delta: [],
    foreshadowing_delta: {
      planted: foreshadowing.planted ?? [],
      advanced: [],
      resolved: foreshadowing.resolved ?? []
    },
    timeline: {
      story_time_elapsed: '',
      current_story_date: '',
      events: [],
      world_state_changes: []
    }
  }
}

test('settlementContentHash 对同一正文稳定、对不同正文不同', () => {
  assert.equal(settlementContentHash('正文A'), settlementContentHash('正文A'))
  assert.notEqual(settlementContentHash('正文A'), settlementContentHash('正文B'))
})

test('结算记录保存基础与提交后账本版本', () => {
  const db = makeDb()
  recordSettlementRun(db, {
    id: 'run-versioned',
    projectId: 'p',
    chapterIndex: 2,
    contentHash: 'hash',
    attempt: 0,
    status: 'settled',
    decision: 'apply',
    issues: [],
    delta: null,
    reason: 'ok',
    baseLedgerVersion: 4,
    committedLedgerVersion: 5
  })
  const run = readSettlementRun(db, 'p', undefined, 2)
  assert.equal(run?.baseLedgerVersion, 4)
  assert.equal(run?.committedLedgerVersion, 5)
})

test('账本：记账 / 幂等命中 / 最新结算章 / 读取', () => {
  const db = makeDb()
  recordSettlementRun(db, {
    projectId: 'p',
    chapterId: 'c0',
    chapterIndex: 0,
    contentHash: 'hash0',
    attempt: 1,
    status: 'settled',
    decision: 'apply',
    issues: [],
    delta: null,
    reason: '通过'
  })
  assert.equal(hasSettledContent(db, 'p', 0, 'hash0'), true)
  assert.equal(hasSettledContent(db, 'p', 0, 'hash1'), false)
  assert.equal(latestSettledChapterIndex(db, 'p'), 0)

  recordSettlementRun(db, {
    projectId: 'p',
    chapterId: 'c1',
    chapterIndex: 1,
    contentHash: 'hashX',
    attempt: 2,
    status: 'settled_with_warning',
    decision: 'apply_with_warning',
    issues: [{ category: 'foreshadow_overdue', severity: 'hint', message: '伏笔过期', ref: '伏笔-1' }],
    delta: null,
    reason: '带警告通过'
  })
  assert.equal(latestSettledChapterIndex(db, 'p'), 1)

  const run = readSettlementRun(db, 'p', 'c1', 1)
  assert.equal(run?.status, 'settled_with_warning')
  assert.equal(run?.decision, 'apply_with_warning')
  assert.equal(run?.issues.length, 1)
  assert.equal(run?.issues[0].category, 'foreshadow_overdue')
  assert.ok(run?.createdAt)
})

test('回滚标记：settled 记录标记 rolled_back 后同正文可再次结算', () => {
  const db = makeDb()
  recordSettlementRun(db, {
    projectId: 'p',
    chapterId: 'c0',
    chapterIndex: 0,
    contentHash: 'hash0',
    attempt: 1,
    status: 'settled',
    decision: 'apply',
    issues: [],
    delta: null,
    reason: '通过'
  })
  assert.equal(hasSettledContent(db, 'p', 0, 'hash0'), true)

  const marked = markSettlementRolledBack(db, 'p', 0)
  assert.equal(marked, 1)
  assert.equal(hasSettledContent(db, 'p', 0, 'hash0'), false)
  assert.equal(latestSettledChapterIndex(db, 'p'), null)
})

test('resolveChapterOrdinal：按 sort_order,rowid 返回 0 基章号', () => {
  const db = makeDb()
  db.exec(`
    CREATE TABLE chapters (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL
    ) STRICT;
  `)
  const insert = db.prepare('INSERT INTO chapters (id, project_id, title, content, sort_order) VALUES (?, ?, ?, ?, ?)')
  // 故意乱序插入，验证按 sort_order 排序
  insert.run('c2', 'p', '章B', '', 2)
  insert.run('c0', 'p', '章0', '', 0)
  insert.run('c1', 'p', '章A', '', 1)
  insert.run('x9', 'other', '别项目', '', 0)

  assert.equal(resolveChapterOrdinal(db, 'p', 'c0'), 0)
  assert.equal(resolveChapterOrdinal(db, 'p', 'c1'), 1)
  assert.equal(resolveChapterOrdinal(db, 'p', 'c2'), 2)
  assert.equal(resolveChapterOrdinal(db, 'p', 'not-exist'), 0)
  assert.equal(resolveChapterOrdinal(db, 'other', 'x9'), 0)
})

test('isLatestChapter / latestSettlementCreatedAt（P4 定稿同步辅助）', () => {
  const db = makeDb()
  db.exec(`
    CREATE TABLE chapters (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL
    ) STRICT;
  `)
  const insert = db.prepare('INSERT INTO chapters (id, project_id, title, content, sort_order) VALUES (?, ?, ?, ?, ?)')
  insert.run('c0', 'p', '章0', '', 0)
  insert.run('c1', 'p', '章1', '', 1)

  assert.equal(isLatestChapter(db, 'p', 1), true)
  assert.equal(isLatestChapter(db, 'p', 0), false)
  assert.equal(isLatestChapter(db, 'p', 2), false)
  assert.equal(isLatestChapter(db, 'other', 0), false)

  // 无记录 → 空串；记录后 → 可拿到 createdAt（供 supersede 基线）
  assert.equal(latestSettlementCreatedAt(db, 'p', 'c0', 0), '')
  recordSettlementRun(db, {
    projectId: 'p',
    chapterId: 'c0',
    chapterIndex: 0,
    contentHash: 'h0',
    attempt: 1,
    status: 'settled',
    decision: 'apply',
    issues: [],
    delta: null,
    reason: 'ok'
  })
  assert.ok(latestSettlementCreatedAt(db, 'p', 'c0', 0).length > 0)
})

test('快照回滚：角色位置与伏笔状态可恢复', () => {
  const db = makeDb()
  // 第 0 章：林岚进入 A，埋设伏笔-1
  applyStateDelta(db, 'p', 0, charDelta('林岚', { from: '', to: 'A', knowledge: ['旧信'] }, {
    planted: [{ id: '伏笔-1', type: '暗线', description: '旧信藏谜', method: '道具', payoff_chapter: 9 }]
  }))
  assert.equal(getLatestCharacterStates(db, 'p', ['林岚'])[0].location, 'A')
  assert.equal(getActiveForeshadowing(db, 'p', 999)[0].status, 'active')

  // 第 1 章结算前快照 → 结算：林岚去 B，回收伏笔-1
  snapshotSettlementState(db, 'p', 1, {
    characterIds: ['林岚'],
    foreshadowingIds: ['伏笔-1'],
    relationshipIds: []
  })
  applyStateDelta(db, 'p', 1, charDelta('林岚', { from: 'A', to: 'B' }, {
    resolved: [{ id: '伏笔-1', method: '揭示', impact: '旧信作者是顾川' }]
  }))
  assert.equal(getLatestCharacterStates(db, 'p', ['林岚'])[0].location, 'B')
  assert.equal(getActiveForeshadowing(db, 'p', 999).length, 0)

  // 回滚第 1 章结算 → 恢复
  rollbackSettlementState(db, 'p', 1)
  const restored = getLatestCharacterStates(db, 'p', ['林岚'])[0]
  assert.equal(restored.location, 'A')
  assert.deepEqual(restored.knowledge, ['旧信'])
  const hooks = getActiveForeshadowing(db, 'p', 999)
  assert.equal(hooks.length, 1)
  assert.equal(hooks[0].status, 'active')
  assert.equal(hooks[0].resolvedChapter, null)
})

test('快照回滚：结算前不存在的实体（本章新埋/新出现）也会被移除', () => {
  const db = makeDb()
  // 第 1 章结算：新埋伏笔-2，林岚首次出现（结算前账本里都没有）
  snapshotSettlementState(db, 'p', 1, { characterIds: ['林岚'], foreshadowingIds: ['伏笔-2'], relationshipIds: [] })
  applyStateDelta(db, 'p', 1, charDelta('林岚', { from: '', to: 'C' }, {
    planted: [{ id: '伏笔-2', type: '暗线', description: '新伏笔', method: '对话', payoff_chapter: 5 }]
  }))
  assert.equal(getActiveForeshadowing(db, 'p', 999).length, 1)

  rollbackSettlementState(db, 'p', 1)
  assert.equal(getActiveForeshadowing(db, 'p', 999).length, 0)
  // 角色：快照时林岚不存在（null）→ 回滚应删除结算章写入的行
  assert.equal(getLatestCharacterStates(db, 'p', ['林岚']).length, 0)
})

test('结算成功后清理快照不影响账本', () => {
  const db = makeDb()
  snapshotSettlementState(db, 'p', 1, { characterIds: ['林岚'], foreshadowingIds: [], relationshipIds: [] })
  clearSettlementSnapshots(db, 'p', 1)
  // 清理后再回滚是空操作，不抛错
  assert.doesNotThrow(() => rollbackSettlementState(db, 'p', 1))
})

test('P7.0 审计列：actor 默认 observer、traceId 缺省 null', () => {
  const db = makeDb()
  recordSettlementRun(db, {
    projectId: 'p', chapterIndex: 0, contentHash: 'h0', attempt: 0,
    status: 'settled', decision: 'apply', issues: [], delta: null, reason: 'ok'
  })
  const rec = readSettlementRun(db, 'p', undefined, 0)
  assert.equal(rec.actor, 'observer')
  assert.equal(rec.traceId, null)
})

test('P7.0 审计列：显式 actor + traceId 落库读回', () => {
  const db = makeDb()
  recordSettlementRun(db, {
    projectId: 'p', chapterIndex: 0, contentHash: 'h0', attempt: 0,
    status: 'settled', decision: 'apply', issues: [], delta: null, reason: 'ok',
    actor: 'human', traceId: 'tr-1'
  })
  const rec = readSettlementRun(db, 'p', undefined, 0)
  assert.equal(rec.actor, 'human')
  assert.equal(rec.traceId, 'tr-1')
})

test('P7.0 快照行 source_event_id 落库读回', () => {
  const db = makeDb()
  snapshotSettlementState(db, 'p', 0, { characterIds: [], foreshadowingIds: [], relationshipIds: [] }, 'run-9')
  const row = db.prepare('SELECT source_event_id FROM settlement_snapshots WHERE project_id = ? AND chapter_index = 0').get('p')
  assert.equal(row.source_event_id, 'run-9')
})

test('P7.0 旧库迁移：缺列时 initSettlementSchema 幂等补列并兼容写入', () => {
  const db = new DatabaseSync(':memory:')
  initStoryStateSchema(db)
  // 模拟旧版库：settlement 表尚无 P7.0 新增列
  db.exec(`
    CREATE TABLE settlement_runs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, chapter_id TEXT,
      chapter_index INTEGER NOT NULL, content_hash TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, decision TEXT NOT NULL,
      issues_json TEXT NOT NULL DEFAULT '[]', delta_json TEXT,
      reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE settlement_snapshots (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, chapter_index INTEGER NOT NULL,
      entity TEXT NOT NULL, entity_id TEXT NOT NULL, row_json TEXT, created_at TEXT NOT NULL
    ) STRICT;
  `)
  // 应补列而非报错
  initSettlementSchema(db)
  const runCols = db.prepare('PRAGMA table_info(settlement_runs)').all().map((c) => String(c.name))
  const snapCols = db.prepare('PRAGMA table_info(settlement_snapshots)').all().map((c) => String(c.name))
  assert.ok(runCols.includes('actor'))
  assert.ok(runCols.includes('trace_id'))
  assert.ok(runCols.includes('base_ledger_version'))
  assert.ok(runCols.includes('committed_ledger_version'))
  assert.ok(runCols.includes('invalidated_at'))
  assert.ok(runCols.includes('invalidated_by_run_id'))
  assert.ok(snapCols.includes('source_event_id'))
  // 幂等：再跑一次不抛错、列仍在
  initSettlementSchema(db)
  // 迁移后带新列写入/读回正常
  recordSettlementRun(db, {
    projectId: 'p', chapterIndex: 0, contentHash: 'h0', attempt: 0,
    status: 'settled', decision: 'apply', issues: [], delta: null, reason: 'ok',
    actor: 'backfill', traceId: 'tr-x'
  })
  const rec = readSettlementRun(db, 'p', undefined, 0)
  assert.equal(rec.actor, 'backfill')
  assert.equal(rec.traceId, 'tr-x')
  assert.equal(rec.baseLedgerVersion, 0)
  assert.equal(rec.committedLedgerVersion, null)
})

function makeRollbackDb() {
  const db = makeDb()
  db.exec(`
    CREATE TABLE chapters (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE chapter_versions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, chapter_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT ''
    ) STRICT;
  `)
  for (let chapterIndex = 0; chapterIndex < 3; chapterIndex += 1) {
    const chapterId = `c${chapterIndex}`
    db.prepare('INSERT INTO chapters (id, project_id, title, content, sort_order) VALUES (?, ?, ?, ?, ?)')
      .run(chapterId, 'p', `第${chapterIndex + 1}章`, `正文${chapterIndex}`, chapterIndex)
    db.prepare('INSERT INTO chapter_versions (id, project_id, chapter_id, content) VALUES (?, ?, ?, ?)')
      .run(`v${chapterIndex}`, 'p', chapterId, `旧正文${chapterIndex}`)
    const delta = charDelta('林岚', {
      from: chapterIndex === 0 ? '' : String.fromCharCode(64 + chapterIndex),
      to: String.fromCharCode(65 + chapterIndex)
    })
    applyStateDelta(db, 'p', chapterIndex, delta)
    summarizeChapterAfterSettlement(db, 'p', chapterIndex, delta, `run-${chapterIndex}`)
    const baseLedgerVersion = readProjectLedger(db, 'p').ledgerVersion
    const committedLedgerVersion = bumpProjectLedger(db, 'p', { settledThroughChapter: chapterIndex })
    recordSettlementRun(db, {
      id: `run-${chapterIndex}`, projectId: 'p', chapterId, chapterIndex,
      contentHash: `hash-${chapterIndex}`, attempt: 0, status: 'settled', decision: 'apply',
      issues: [], delta, reason: 'ok', baseLedgerVersion, committedLedgerVersion
    })
  }
  return db
}

test('回到任意章点会失效下游派生状态并保留正文与版本', () => {
  const db = makeRollbackDb()
  const plan = planRollbackToChapter(db, 'p', 1)
  assert.deepEqual(plan.invalidatedChapters, [2])
  assert.deepEqual(plan.retainedChapterIds, ['c2'])

  const result = applyRollbackPlan(db, plan)
  assert.deepEqual(result.invalidatedChapters, [2])
  assert.equal(queryStateAtChapter(db, 'p', 1).characterStates[0].location, 'B')
  assert.equal(getLatestCharacterStates(db, 'p', ['林岚'])[0].location, 'B')
  assert.equal(readProjectLedger(db, 'p').settledThroughChapter, 1)
  assert.equal(listChaptersNeedingResettlement(db, 'p')[0].chapterId, 'c2')
  assert.equal(db.prepare("SELECT COUNT(*) count FROM chapters WHERE project_id='p'").get().count, 3)
  assert.equal(db.prepare("SELECT COUNT(*) count FROM chapter_versions WHERE project_id='p'").get().count, 3)
  assert.ok(db.prepare("SELECT invalidated_at FROM settlement_runs WHERE id='run-2'").get().invalidated_at)
  assert.equal(db.prepare("SELECT valid FROM chapter_summaries WHERE project_id='p' AND chapter_index=2").get().valid, 0)
})

test('回溯阶段故障会回滚状态、失效标记、队列和账本版本', () => {
  const db = makeRollbackDb()
  const plan = planRollbackToChapter(db, 'p', 1)

  assert.throws(
    () => applyRollbackPlan(db, plan, { afterState: () => { throw new Error('rollback-injected') } }),
    /rollback-injected/
  )
  assert.equal(getLatestCharacterStates(db, 'p', ['林岚'])[0].location, 'C')
  assert.equal(readProjectLedger(db, 'p').ledgerVersion, 3)
  assert.equal(db.prepare('SELECT COUNT(*) count FROM chapter_resettlement_queue').get().count, 0)
  assert.equal(db.prepare('SELECT invalidated_at FROM settlement_runs WHERE id = ?').get('run-2').invalidated_at, null)
})

test('过期回溯计划在写入前被 CAS 拒绝', () => {
  const db = makeRollbackDb()
  const plan = planRollbackToChapter(db, 'p', 1)
  bumpProjectLedger(db, 'p', { settledThroughChapter: 2 })

  assert.throws(() => applyRollbackPlan(db, plan), /STALE_BASE_VERSION/)
  assert.equal(getLatestCharacterStates(db, 'p', ['林岚'])[0].location, 'C')
})

test('P7.1 快照回滚 closure：跨章关门后回滚恢复当前行', () => {
  const db = makeDb()
  // 第0章：林岚 A
  applyStateDelta(db, 'p', 0, charDelta('林岚', { from: '', to: 'A' }))
  // 第1章结算前快照 → 结算（跨章）：林岚 B → 旧行被关门 until=0
  snapshotSettlementState(db, 'p', 1, { characterIds: ['林岚'], foreshadowingIds: [], relationshipIds: [] })
  applyStateDelta(db, 'p', 1, charDelta('林岚', { from: 'A', to: 'B' }))
  assert.equal(getLatestCharacterStates(db, 'p', ['林岚'])[0].location, 'B')
  assert.equal(db.prepare('SELECT COUNT(*) cnt FROM story_character_state').get().cnt, 2)
  // 回滚 → 只剩第0章行且重新生效（until=NULL），位置 A
  rollbackSettlementState(db, 'p', 1)
  assert.equal(getLatestCharacterStates(db, 'p', ['林岚'])[0].location, 'A')
  const rows = db.prepare('SELECT valid_from_chapter, valid_until_chapter FROM story_character_state').all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].valid_from_chapter, 0)
  assert.equal(rows[0].valid_until_chapter, null)
})

test('B1 快照回滚 closure：关系跨章关门后可恢复到结算前关系态', () => {
  const db = makeDb()
  const rel = (to) => ({
    characters_updated: [],
    relationships_delta: [{
      relationship_id: 'r-AB', participants: ['A', 'B'],
      status_change: { from: '', to, pivot_event: 'x' }
    }],
    foreshadowing_delta: { planted: [], advanced: [], resolved: [] },
    timeline: { story_time_elapsed: '', current_story_date: '', events: [], world_state_changes: [] }
  })
  // 第0章：r-AB 相识
  applyStateDelta(db, 'p', 0, rel('相识'))
  // 第1章快照（含关系）→ 结算（跨章）：r-AB → 深交（旧行关门 until=0）
  snapshotSettlementState(db, 'p', 1, { characterIds: [], foreshadowingIds: [], relationshipIds: ['r-AB'] })
  applyStateDelta(db, 'p', 1, rel('深交'))
  assert.equal(getRelationships(db, 'p')[0].currentStatus, '深交')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM story_relationships').get().c, 2)
  // 回滚 → 关系恢复第0章态（删除本章新行 + 快照行 REPLACE 重开 until=NULL）
  rollbackSettlementState(db, 'p', 1)
  assert.equal(getRelationships(db, 'p')[0].currentStatus, '相识')
  const rows = db.prepare('SELECT valid_from_chapter, valid_until_chapter FROM story_relationships').all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].valid_from_chapter, 0)
  assert.equal(rows[0].valid_until_chapter, null)
})

test('P7.2 recordSettlementRun 返回实际 id（自动唯一 / 自定义同源）', () => {
  const db = makeDb()
  const auto1 = recordSettlementRun(db, { projectId: 'p', chapterIndex: 0, contentHash: 'h0', attempt: 0, status: 'settled', decision: 'apply', issues: [], delta: null, reason: 'ok' })
  const auto2 = recordSettlementRun(db, { projectId: 'p', chapterIndex: 0, contentHash: 'h1', attempt: 0, status: 'settled', decision: 'apply', issues: [], delta: null, reason: 'ok' })
  assert.equal(typeof auto1, 'string')
  assert.ok(auto1.length > 0)
  assert.notEqual(auto1, auto2)
  const custom = recordSettlementRun(db, { id: 'run-xyz', projectId: 'p', chapterIndex: 0, contentHash: 'h2', attempt: 0, status: 'settled', decision: 'apply', issues: [], delta: null, reason: 'ok' })
  assert.equal(custom, 'run-xyz')
})

test('P7.4 setSettlementRunTrace 回填账本 trace_id（可清除）', () => {
  const db = makeDb()
  const runId = recordSettlementRun(db, { id: 'run-t', projectId: 'p', chapterIndex: 0, contentHash: 'h0', attempt: 0, status: 'settled', decision: 'apply', issues: [], delta: null, reason: 'ok' })
  assert.equal(runId, 'run-t')
  assert.equal(readSettlementRun(db, 'p', undefined, 0).traceId, null)
  setSettlementRunTrace(db, 'run-t', 'ct-1')
  assert.equal(readSettlementRun(db, 'p', undefined, 0).traceId, 'ct-1')
  setSettlementRunTrace(db, 'run-t', null)
  assert.equal(readSettlementRun(db, 'p', undefined, 0).traceId, null)
})
