/**
 * Arbiter —— 结算裁决器（纯函数）。
 *
 * 对齐参考架构的 Arbiter 语义：在 Reducer 落账前，把 Observer 产出的增量、
 * Validator 汇总的问题与当前账本状态放在一起做最终裁决，决定
 * 「落账 / 带警告落账 / 拒绝落账 / 自动重观察一次 / 幂等跳过」。
 *
 * 本模块无副作用、无运行时相对依赖，可直接被 `node --test` 以 `.ts` 导入。
 */
import type { ArbitrationInput, ArbiterDecision } from './types'

/**
 * 依据决策表裁决一次结算。
 *
 * 决策表：
 * - 相同 contentHash 已结算（且不允许重放）→ `skip` / `duplicate`
 * - 无状态增量 → `skip` / `skipped`
 * - 存在 error 级问题：
 *     - 首次（observeAttempt === 0）且策略允许 → `retry_observe`（编排器重试一次观察后再次裁决）
 *     - 重试后仍有 error / 不允许重试 → `reject`（拒绝写入状态库）
 * - 仅 warning/hint → `apply_with_warning`
 * - 无问题 → `apply`
 */
export function arbitrateSettlement(input: ArbitrationInput): ArbiterDecision {
  const errors = input.preIssues.filter((i) => i.severity === 'error')
  const warnings = input.preIssues.filter((i) => i.severity === 'warning')

  // 幂等守卫：同一正文已完成结算且不允许重放 → 跳过，避免重复写入造成数组字段累积。
  if (input.alreadySettled && !input.policy.allowReapply) {
    return {
      type: 'skip',
      status: 'skipped',
      issues: [],
      reason: '相同正文已完成结算（contentHash 命中），幂等跳过'
    }
  }

  // 无状态变更（Observer 未提取到 delta）→ 无账可结。
  if (!input.delta) {
    return {
      type: 'skip',
      status: 'skipped',
      issues: [],
      reason: '未检测到状态变更增量'
    }
  }

  if (errors.length > 0) {
    // 首轮失败且允许自动重观察：让编排器带 feedback 重跑一次 Observer。
    if (input.observeAttempt === 0 && input.policy.allowAutoReobserve) {
      return {
        type: 'retry_observe',
        status: 'rejected',
        issues: errors,
        reason: '结算校验发现 error 级问题，自动重试观察一次后再裁决'
      }
    }
    return {
      type: 'reject',
      status: 'rejected',
      issues: errors,
      reason: '结算校验未通过，拒绝写入状态库（正文保留，可人工修复后重试结算）'
    }
  }

  if (warnings.length > 0) {
    return {
      type: 'apply_with_warning',
      status: 'settled_with_warning',
      issues: warnings,
      reason: '结算通过，但存在 warning 级问题（已随账本记录）'
    }
  }

  return {
    type: 'apply',
    status: 'settled',
    issues: [],
    reason: '结算通过'
  }
}
