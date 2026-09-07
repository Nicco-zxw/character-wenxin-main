/**
 * 章节结算管线入口（settlement 对编排器的唯一门面）。
 *
 * 组装完整闭环：
 *   Validator(L0: runLightCheck + 伏笔对账) → Arbiter(纯函数裁决)
 *   → 通过则「状态快照 → Reducer(applyStateDelta) → 清快照 → 记账」；
 *   → 拒绝则「不落账、记账、保留正文（可人工重试）」；
 *   → 首轮 error 且策略允许 → 自动重观察一次（回调由编排器注入，携带 feedback）再裁决。
 *
 * 本模块仅供主进程运行路径使用（由 electron-vite 打包），不直接参与 node --test。
 */
import type { DatabaseSync } from 'node:sqlite'
import { runLightCheck } from '../audit/light-check'
import {
  readProjectLedger,
  type StoryStateContext,
  type StateDelta
} from '../../story-state-store'
import { arbitrateSettlement } from './arbiter'
import { reconcileForeshadowing } from './foreshadow-reconcile'
import {
  hasSettledContent,
  newSettlementRunId,
  readSettlementRun,
  recordSettlementRun,
  setSettlementRunTrace,
  settlementContentHash
} from './settlement-store'
import { commitSettlement } from './committer'
import { CONTEXT_TRACE_ON, buildTraceFromStoryContext, createContextTrace, evaluateContextBudget } from '../context-trace'
import { acquireBookLock, heartbeatBookLock, releaseBookLock } from '../locking/book-lock'
import {
  DEFAULT_SETTLEMENT_POLICY,
  type ArbiterDecision,
  type SettlementIssue,
  type SettlementOutcome,
  type SettlementPolicy,
  type SettlementReconcileFn
} from './types'

/** 自动重观察的最大次数（与生成任务的 agent 步数解耦，避免拖死结算） */
const MAX_AUTO_REOBSERVE = 1

export interface SettleChapterParams {
  projectId: string
  chapterId?: string
  chapterIndex: number
  content: string
  contentHash?: string
  /** 结算前状态（由调用方基于正文涉及的字符构建） */
  preState: StoryStateContext
  /** Observer 产出的增量；null = 未提取到变更 */
  delta: StateDelta | null
  policy?: Partial<SettlementPolicy>
  /**
   * 自动重观察回调：attempt 从 1 开始，feedback 为上一轮 error 问题摘要。
   * 返回 null 表示重观察失败。不提供回调时，首轮 error 直接走拒绝。
   */
  observe?: (attempt: number, feedback: string) => Promise<{ delta: StateDelta | null } | null>
  /**
   * L1(LLM 对账) 回调：对给定 delta 返回对账问题（error/warning/hint）。
   * 仅在 `policy.enableLLMReconcile` 且 delta 非空时被调用；回调内部应自行兜底，
   * 失败返回 []（由编排器负责记录 L1 失败告警），这里再做一次保险性捕获。
   */
  reconcile?: SettlementReconcileFn
  /**
   * supersede 基线：本次结算开始前「某章最近一次结算」的 createdAt。
   * 若结算进行期间已有更新的记录落账（例如「定稿同步 settlement:sync」先完成），
   * 本次（如草稿期）结算不再覆盖 → 判 skip。用于防止草稿结算覆盖更新的定稿结算的竞态。
   */
  supersedeBaselineCreatedAt?: string
  /** 触发场景标记（如 'postgen' | 'rerun' | 'sync'），用于 context_traces.run_kind；缺省 'settle' */
  runKind?: string
}

/**
 * 对一章执行完整结算（带 BOOK_BUSY 写锁，P6.1.2）。
 * 同一 project:chapter 的并发结算会互斥：后到者 acquire 失败抛 BookWriteLockError(BOOK_BUSY)。
 * 锁只覆盖结算（含 reconcile/observe 的 LLM 回调，通常 <1 个租约）；离开即释放。
 * 纯确定性部分（Validator/Arbiter/落账/记账/快照）全部收口在 unlocked 实现里。
 */
export async function runChapterSettlement(
  db: DatabaseSync,
  params: SettleChapterParams
): Promise<SettlementOutcome> {
  const scope = `settle:${params.projectId}:${params.chapterIndex}`
  const owner = params.chapterId ? `chapter:${params.chapterId}` : scope
  const token = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  acquireBookLock(db, { scope, owner, token })
  const lockGuard = { scope, owner, token, lost: false }

  // P6.1.3：结算可能跨 reconcile/observe 的 LLM 等待（通常远小于租约，但保守起见）
  // 定时心跳保活，防止长时间任务期间锁过期被并发任务抢占。
  const heartbeatInterval = 25_000
  const heartbeatTimer = setInterval(() => {
    try {
      if (!heartbeatBookLock(db, { scope, owner, token })) lockGuard.lost = true
    } catch {
      lockGuard.lost = true
    }
  }, heartbeatInterval)

  try {
    return await runChapterSettlementUnlocked(db, params, lockGuard)
  } finally {
    clearInterval(heartbeatTimer)
    releaseBookLock(db, { scope, owner, token })
  }
}

async function runChapterSettlementUnlocked(
  db: DatabaseSync,
  params: SettleChapterParams,
  lockGuard: { scope: string; owner: string; token: string; lost: boolean }
): Promise<SettlementOutcome> {
  const policy: SettlementPolicy = { ...DEFAULT_SETTLEMENT_POLICY, ...params.policy }
  const contentHash = params.contentHash ?? settlementContentHash(params.content)
  const baseLedgerVersion = readProjectLedger(db, params.projectId).ledgerVersion

  // 幂等守卫：同一正文已结算且不允许重放 → 跳过（不落账）。
  if (!policy.allowReapply && hasSettledContent(db, params.projectId, params.chapterIndex, contentHash)) {
    return {
      status: 'skipped',
      decision: 'skip',
      applied: false,
      issues: [],
      reason: '相同正文已完成结算，幂等跳过'
    }
  }

  // 首次裁决（L0 + 可选 L1 对账）
  const firstDelta = params.delta
  const firstPreIssues = await buildCombinedIssues(params, firstDelta, 0)
  let decision = arbitrateSettlement({
    projectId: params.projectId,
    chapterId: params.chapterId,
    chapterIndex: params.chapterIndex,
    contentHash,
    content: params.content,
    delta: firstDelta,
    preIssues: firstPreIssues,
    alreadySettled: false,
    observeAttempt: 0,
    policy
  })

  // 自动重观察：仅当首轮为 retry_observe 且提供回调时执行一次。
  let attemptsUsed = 1
  let settledDelta = firstDelta
  if (decision.type === 'retry_observe') {
    // 记录中间裁决，保证「拒绝→重试→再裁决」的审计路径可见。
    recordSettlementRun(db, {
      projectId: params.projectId,
      chapterId: params.chapterId,
      chapterIndex: params.chapterIndex,
      contentHash,
      attempt: 0,
      status: 'rejected',
      decision: 'retry_observe',
      issues: decision.issues,
      delta: firstDelta,
      reason: decision.reason,
      baseLedgerVersion,
      committedLedgerVersion: null
    })

    const feedback = summarizeIssues(decision.issues)
    const rerun = params.observe
      ? await params.observe(1, feedback)
      : null

    if (rerun) {
      const nextDelta = rerun.delta
      // 重观察后再次做 L0 + L1 对账（带上一轮 feedback），再裁决。
      const nextPreIssues = await buildCombinedIssues(params, nextDelta, 1, feedback)
      decision = arbitrateSettlement({
        projectId: params.projectId,
        chapterId: params.chapterId,
        chapterIndex: params.chapterIndex,
        contentHash,
        content: params.content,
        delta: nextDelta,
        preIssues: nextPreIssues,
        alreadySettled: false,
        observeAttempt: 1,
        policy
      })
      settledDelta = nextDelta
      attemptsUsed = 2
    } else {
      // 无法重观察 → 维持拒绝。
      decision = {
        type: 'reject',
        status: 'rejected',
        issues: decision.issues,
        reason: decision.reason
      }
    }
  }

  // supersede 守卫：apply 前若已有更新的记录落账（如定稿同步先完成）→ 不覆盖（防草稿结算竞态）。
  if ((decision.type === 'apply' || decision.type === 'apply_with_warning') && params.supersedeBaselineCreatedAt) {
    const latest = readSettlementRun(db, params.projectId, params.chapterId, params.chapterIndex)
    if (latest && latest.createdAt && latest.createdAt > params.supersedeBaselineCreatedAt) {
      decision = {
        type: 'skip',
        status: 'skipped',
        issues: [],
        reason: '结算进行期间已有更新的记录落账（如定稿同步先完成），本次结算不覆盖（superseded）'
      }
    }
  }

  return finalizeDecision(
    db,
    params,
    contentHash,
    decision,
    attemptsUsed,
    settledDelta,
    baseLedgerVersion,
    lockGuard
  )
}

/**
 * 组装一轮裁决的 preIssues：L0(规则 light-check + 伏笔对账) + 可选 L1(LLM 对账)。
 * L1 仅在策略开启且 delta 非空时执行；异常被兜底为 []（不阻断 L0 结论）。
 */
async function buildCombinedIssues(
  params: SettleChapterParams,
  delta: StateDelta | null,
  attempt: number,
  feedback?: string
): Promise<SettlementIssue[]> {
  const baseIssues = buildPreIssues(params.preState, params.chapterIndex, params.content, delta)
  if (!params.policy?.enableLLMReconcile || !delta || !params.reconcile) {
    return baseIssues
  }
  try {
    const l1Issues = await params.reconcile(attempt, delta, feedback)
    return [...baseIssues, ...(Array.isArray(l1Issues) ? l1Issues : [])]
  } catch {
    // L1 失败不阻断 L0 结论；编排器负责记录 L1 失败告警。
    return baseIssues
  }
}

function finalizeDecision(
  db: DatabaseSync,
  params: SettleChapterParams,
  contentHash: string,
  decision: ArbiterDecision,
  attemptsUsed: number,
  originalDelta: StateDelta | null,
  baseLedgerVersion: number,
  lockGuard: { scope: string; owner: string; token: string; lost: boolean }
): SettlementOutcome {
  if (decision.type === 'skip' || decision.type === 'reject') {
    recordSettlementRun(db, {
      projectId: params.projectId,
      chapterId: params.chapterId,
      chapterIndex: params.chapterIndex,
      contentHash,
      attempt: attemptsUsed,
      status: decision.status,
      decision: decision.type,
      issues: decision.issues,
      delta: originalDelta,
      reason: decision.reason,
      baseLedgerVersion,
      committedLedgerVersion: null
    })
    return {
      status: decision.status,
      decision: decision.type,
      applied: false,
      issues: decision.issues,
      reason: decision.reason
    }
  }

  // apply / apply_with_warning：快照、Reducer、摘要、版本推进和成功记账原子提交。
  // 成功后保留该章快照，供后续按章回滚恢复到结算前状态。
  const runId = newSettlementRunId()

  try {
    if (decision.type !== 'apply' && decision.type !== 'apply_with_warning') {
      throw new Error(`UNRESOLVED_SETTLEMENT_DECISION: ${decision.type}`)
    }
    if (!originalDelta) {
      throw new Error('结算裁决允许提交，但缺少状态增量')
    }
    commitSettlement(db, {
      runId,
      projectId: params.projectId,
      chapterId: params.chapterId,
      chapterIndex: params.chapterIndex,
      contentHash,
      baseLedgerVersion,
      lock: {
        scope: lockGuard.scope,
        owner: lockGuard.owner,
        token: lockGuard.token
      },
      lockLost: lockGuard.lost,
      actor: 'observer',
      attempt: attemptsUsed,
      status: decision.type === 'apply' ? 'settled' : 'settled_with_warning',
      decision: decision.type,
      issues: decision.issues,
      delta: originalDelta,
      reason: decision.reason
    })
    // P7.4/P6.4：结算上下文过程审计落账——记喂了什么 + 分层/token 粗估 + protected 预算评估 + 压缩记录（可回放；失败不阻断）并回填 trace_id
    if (CONTEXT_TRACE_ON && params.preState) {
      try {
        const trace = buildTraceFromStoryContext(params.preState)
        const budget = evaluateContextBudget(trace.tokens)
        const traceId = createContextTrace(db, {
          projectId: params.projectId,
          chapterIndex: params.chapterIndex,
          runKind: params.runKind ?? 'settle',
          sourceEventId: runId,
          ...trace,
          budget,
          compression: {
            applied: [],
            reason: budget.overBudget
              ? `protected 超预算 ${budget.exceededBy} tok（上限 ${budget.budgetLimit}，未压缩——protected 不可降级）`
              : 'settlement-observer-full-context-no-compression'
          }
        })
        setSettlementRunTrace(db, runId, traceId)
      } catch {
        // 忽略：trace 失败不影响结算
      }
    }
    return {
      status: decision.status,
      decision: decision.type,
      applied: true,
      issues: decision.issues,
      reason: decision.reason
    }
  } catch (error) {
    recordSettlementRun(db, {
      id: runId,
      projectId: params.projectId,
      chapterId: params.chapterId,
      chapterIndex: params.chapterIndex,
      contentHash,
      attempt: attemptsUsed,
      status: 'error',
      decision: 'reject',
      issues: [{
        category: 'state_conflict',
        severity: 'error',
        message: `状态落账失败：${error instanceof Error ? error.message : String(error)}`
      }],
      delta: originalDelta,
      reason: '原子结算提交失败，事务已回滚',
      baseLedgerVersion,
      committedLedgerVersion: null
    })
    return {
      status: 'error',
      decision: 'reject',
      applied: false,
      issues: [{
        category: 'state_conflict',
        severity: 'error',
        message: `状态落账失败：${error instanceof Error ? error.message : String(error)}`
      }],
      reason: '状态落账失败'
    }
  }
}

/** Validator(L0) 汇总：light-check 规则 + 伏笔账本↔delta 对账。 */
function buildPreIssues(
  preState: StoryStateContext,
  chapterIndex: number,
  content: string,
  delta: StateDelta | null
): SettlementIssue[] {
  const issues: SettlementIssue[] = []
  if (delta) {
    const check = runLightCheck(content, preState, delta)
    for (const violation of check.violations) {
      issues.push({
        category: violation.type as SettlementIssue['category'],
        severity: violation.severity,
        message: violation.message
      })
    }
    issues.push(...reconcileForeshadowing({
      activeForeshadowing: preState.activeForeshadowing,
      chapterIndex,
      delta
    }))
  }
  return issues
}

function summarizeIssues(issues: SettlementIssue[]): string {
  return issues
    .slice(0, 5)
    .map((i) => `[${i.severity}] ${i.message}`)
    .join('\n')
}
