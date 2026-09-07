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
  snapshotSettlementStateInTransaction,
  type SettlementSnapshotScope
} from './settlement-store.ts'
import type { SettlementActor, SettlementIssue } from './types.ts'

export interface CommitSettlementInput {
  runId: string
  projectId: string
  chapterId?: string
  chapterIndex: number
  contentHash: string
  baseLedgerVersion: number
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

    const committedLedgerVersion = bumpProjectLedger(db, input.projectId, {
      settledThroughChapter: input.chapterIndex
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
