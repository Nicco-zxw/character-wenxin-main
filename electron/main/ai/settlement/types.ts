/**
 * 章节结算闭环（Settlement Loop）的公共类型与默认策略。
 *
 * 设计：本章节只定义类型与常量，不依赖任何运行时相对模块（仅 `import type`），
 * 因此可直接被 `node --test` 以 `.ts` 后缀导入做单测。
 * 参考架构语义：Observer(提取) → Reducer(落账) → Validator(规则+对账) → Arbiter(裁决)。
 */
import type { StateDelta } from '../../story-state-store'

/**
 * 结算终态。写入 settlement_runs.status。
 */
export type SettlementStatus =
  /** 无状态变更 / 相同正文已结算，无需落账 */
  | 'skipped'
  /** 通过并落账 */
  | 'settled'
  /** 通过并落账，但存在 warning 级问题 */
  | 'settled_with_warning'
  /** 校验失败，拒绝写入状态库（正文保留，可人工重试结算） */
  | 'rejected'
  /** 结算过程抛出异常，未落账 */
  | 'error'

export type SettlementIssueSeverity = 'error' | 'warning' | 'hint'

export type SettlementIssueCategory =
  | 'location_mismatch'
  | 'item_not_owned'
  | 'timeline_break'
  | 'rule_violation'
  | 'state_conflict'
  | 'foreshadow_unplanted_resolve'
  | 'foreshadow_duplicate_resolve'
  | 'foreshadow_overdue'
  | 'foreshadow_duplicate_plant'
  | 'foreshadow_id_drift'

/** 结算环节暴露给账本/UI/评测的单一问题记录 */
export interface SettlementIssue {
  category: SettlementIssueCategory
  severity: SettlementIssueSeverity
  message: string
  /** 相关角色 id / 伏笔 id 等，便于定位 */
  ref?: string
}

/**
 * 结算策略。默认值可在编排器/渲染层按需覆盖。
 */
export interface SettlementPolicy {
  /** 首轮校验出现 error 级问题时，是否允许自动重跑一次观察（Observer） */
  allowAutoReobserve: boolean
  /** 相同正文 contentHash 是否允许重放（用于修复场景），默认 false = 幂等 */
  allowReapply: boolean
  /**
   * 是否启用 L1(LLM 对账) 作为 error/warning 级问题生产者。
   * 默认 false（确定性 L0 已够用且零成本）；由编排器按预算/需要开启。
   */
  enableLLMReconcile: boolean
}

export const DEFAULT_SETTLEMENT_POLICY: SettlementPolicy = {
  allowAutoReobserve: true,
  allowReapply: false,
  enableLLMReconcile: false
}

/**
 * L1(LLM 对账) 回调签名。由编排器注入（内部自己处理 LLM 异常，失败应返回 []）。
 * @param attempt   当前观察/对账轮次（0 = 首次，>=1 = 自动重观察后）
 * @param delta     本轮 Observer 产出的增量
 * @param feedback  上一轮 error 问题摘要（attempt>=1 时提供，便于对账聚焦）
 */
export type SettlementReconcileFn = (
  attempt: number,
  delta: StateDelta | null,
  feedback?: string
) => Promise<SettlementIssue[]>

/**
 * Arbiter 裁决输入。`alreadySettled` 由编排器在读取结算账本后预计算后传入，
 * 保证 arbiter 本身是无副作用纯函数。
 */
export interface ArbitrationInput {
  projectId: string
  chapterId?: string
  chapterIndex: number
  contentHash: string
  content: string
  /** Observer 产出的状态增量；null 表示未提取到变更 */
  delta: StateDelta | null
  /** Validator(L0 规则 + 伏笔对账) 汇总的问题 */
  preIssues: SettlementIssue[]
  /** 同一正文是否已在账本中以 settled* 终态记录过 */
  alreadySettled: boolean
  /** 当前观察尝试编号：0 = 首次，>=1 = 自动重试后 */
  observeAttempt: number
  policy: SettlementPolicy
}

export type ArbiterDecisionType =
  | 'apply'
  | 'apply_with_warning'
  | 'reject'
  | 'retry_observe'
  | 'skip'

export interface ArbiterDecision {
  type: ArbiterDecisionType
  /** 最终/中间结算终态（retry_observe 时为 rejected，编排器重试后重新裁决） */
  status: SettlementStatus
  /** 需要随账本记录的问题（裁决补充或透传） */
  issues: SettlementIssue[]
  reason: string
}

/**
 * 触发结算的角色/来源（用于审计归因）。
 */
export type SettlementActor = 'observer' | 'human' | 'backfill' | 'manual_rerun'

/**
 * 结算账本的一条记录（settlement_runs 行）。
 */
export interface SettlementRunRecord {
  projectId: string
  chapterId?: string
  chapterIndex: number
  contentHash: string
  attempt: number
  status: SettlementStatus
  decision: ArbiterDecisionType
  issues: SettlementIssue[]
  /** 观察产出的原始增量（用于审计/回放） */
  delta?: StateDelta | null
  reason: string
  /** 触发方（observer/human/backfill/manual_rerun），默认 observer */
  actor?: SettlementActor
  /** 关联的上下文 trace（P7.4 启用后填充），可空 */
  traceId?: string | null
  createdAt: string
}

/** 结算管线对外的汇总结果（供 orchestrator/评测消费） */
export interface SettlementOutcome {
  status: SettlementStatus
  decision: ArbiterDecisionType
  issues: SettlementIssue[]
  applied: boolean
  reason: string
}
