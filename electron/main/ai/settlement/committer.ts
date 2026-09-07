import type { DatabaseSync } from 'node:sqlite'
import {
  applyStateDeltaInTransaction,
  bumpProjectLedger,
  readProjectLedger,
  summarizeChapterAfterSettlement,
  type StateDelta
} from '../../story-state-store.ts'
import {
  recordSettlementRun,
  settlementContentHash,
  snapshotSettlementStateInTransaction,
  type SettlementSnapshotScope
} from './settlement-store.ts'
import type { SettlementActor, SettlementIssue } from './types.ts'
import { assertBookLockOwned } from '../locking/book-lock.ts'

export interface CommitSettlementInput {
  runId: string
  projectId: string
  chapterId?: string
  chapterIndex: number
  contentHash: string
  baseLedgerVersion: number
  lock: { scope: string; owner: string; token: string }
  lockLost?: boolean
  actor: SettlementActor
  delta: StateDelta
  issues: SettlementIssue[]
  status: 'settled' | 'settled_with_warning'
  decision: 'apply' | 'apply_with_warning'
  reason: string
  attempt?: number
}

export interface SettlementCommitHooks {
  afterReducer?(): void
  afterSummary?(): void
  afterForecastInvalidation?(): void
}

/** 从状态增量唯一地推导快照范围，供编排与提交路径共同复用。 */
export function touchedEntities(delta: StateDelta): SettlementSnapshotScope {
  const foreshadowing = delta.foreshadowing_delta ?? { planted: [], advanced: [], resolved: [] }
  return {
    characterIds: [...new Set(delta.characters_updated.map((item) => item.character_id))],
    foreshadowingIds: [...new Set([
      ...foreshadowing.planted.map((item) => item.id),
      ...foreshadowing.advanced.map((item) => item.id),
      ...foreshadowing.resolved.map((item) => item.id)
    ])],
    relationshipIds: [...new Set(delta.relationships_delta.map((item) => item.relationship_id))]
  }
}

/** 原子提交一次已通过裁决的章节结算。 */
export function commitSettlement(
  db: DatabaseSync,
  input: CommitSettlementInput,
  hooks: SettlementCommitHooks = {}
): { runId: string; committedLedgerVersion: number } {
  db.exec('BEGIN IMMEDIATE')
  try {
    const current = readProjectLedger(db, input.projectId)
    if (current.ledgerVersion !== input.baseLedgerVersion) {
      throw new Error(
        `STALE_BASE_VERSION: expected ${input.baseLedgerVersion}, received ${current.ledgerVersion}`
      )
    }

    const chapter = db.prepare(`
      SELECT id, content FROM chapters
      WHERE project_id = ?
      ORDER BY sort_order ASC, rowid ASC
      LIMIT 1 OFFSET ?
    `).get(input.projectId, input.chapterIndex) as { id: string; content: string } | undefined
    if (!chapter || (input.chapterId && chapter.id !== input.chapterId)) {
      throw new Error('CHAPTER_SCOPE_MISMATCH: 章节不属于项目或章序不一致')
    }
    if (settlementContentHash(chapter.content) !== input.contentHash) {
      throw new Error('STALE_CHAPTER_CONTENT: Observer 使用的正文已变化')
    }

    if (input.lockLost) throw new Error('BOOK_BUSY: write lock heartbeat was lost')
    const expectedScope = `settle:${input.projectId}:${input.chapterIndex}`
    const expectedOwner = `chapter:${chapter.id}`
    if (input.lock.scope !== expectedScope || input.lock.owner !== expectedOwner) {
      throw new Error(`BOOK_BUSY: lock scope mismatch (${input.lock.scope})`)
    }
    assertBookLockOwned(db, input.lock)

    const earliestPending = db.prepare(`
      SELECT chapter_id, chapter_index FROM chapter_resettlement_queue
      WHERE project_id = ? AND resolved_at IS NULL
      ORDER BY chapter_index ASC LIMIT 1
    `).get(input.projectId) as { chapter_id: string; chapter_index: number } | undefined
    if (earliestPending
      && (earliestPending.chapter_id !== chapter.id
        || Number(earliestPending.chapter_index) !== input.chapterIndex)) {
      throw new Error(
        `RESETTLEMENT_ORDER_VIOLATION: expected chapter ${earliestPending.chapter_index}`
      )
    }
    if (input.chapterIndex > current.settledThroughChapter + 1) {
      throw new Error(
        `NON_CONTIGUOUS_SETTLEMENT: expected at most ${current.settledThroughChapter + 1}`
      )
    }

    snapshotSettlementStateInTransaction(
      db,
      input.projectId,
      input.chapterIndex,
      touchedEntities(input.delta),
      input.runId
    )
    applyStateDeltaInTransaction(db, input.projectId, input.chapterIndex, input.delta, {
      sourceEventId: input.runId,
      actor: input.actor
    })
    hooks.afterReducer?.()

    summarizeChapterAfterSettlement(
      db,
      input.projectId,
      input.chapterIndex,
      input.delta,
      input.runId
    )
    hooks.afterSummary?.()

    if (input.chapterId) {
      db.prepare(`
        UPDATE chapter_resettlement_queue SET resolved_at = ?
        WHERE project_id = ? AND chapter_id = ? AND resolved_at IS NULL
      `).run(new Date().toISOString(), input.projectId, input.chapterId)
    }

    const forecastTable = db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'narrative_forecasts'
    `).get()
    if (forecastTable) {
      db.prepare(`
        UPDATE narrative_forecasts SET status = 'expired', updated_at = ?
        WHERE project_id = ? AND base_chapter_index < ? AND status IN ('active', 'selected')
      `).run(new Date().toISOString(), input.projectId, input.chapterIndex)
    }
    hooks.afterForecastInvalidation?.()

    const committedLedgerVersion = bumpProjectLedger(db, input.projectId, {
      settledThroughChapter: Math.max(current.settledThroughChapter, input.chapterIndex)
    })
    recordSettlementRun(db, {
      id: input.runId,
      projectId: input.projectId,
      chapterId: input.chapterId,
      chapterIndex: input.chapterIndex,
      contentHash: input.contentHash,
      attempt: input.attempt ?? 0,
      status: input.status,
      decision: input.decision,
      issues: input.issues,
      delta: input.delta,
      reason: input.reason,
      actor: input.actor,
      baseLedgerVersion: input.baseLedgerVersion,
      committedLedgerVersion
    })
    db.exec('COMMIT')
    return { runId: input.runId, committedLedgerVersion }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
