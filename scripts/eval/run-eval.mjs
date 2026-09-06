/**
 * 结算闭环离线评测（Phase 0 最小可运行基座）。
 *
 * 用法：在 character-arc-main 下执行 `pnpm eval`
 * 产物：scripts/eval/report/<时间戳>.json（指标 + 逐场景明细）+ 控制台汇总。
 *
 * 说明：
 * - 离线、确定性，不依赖 LLM/mock：直接驱动与真实管线相同的确定性组件
 *   （runLightCheck / reconcileForeshadowing / arbitrateSettlement / applyStateDelta /
 *    settlement-store 记账+快照），Observer 产物与 L1 对账结果由语料给定。
 * - 真正的主进程流水线在 electron/main/ai/settlement/index.ts（含自动重观察回调），
 *   因 bundler 相对导入约定无法被 node 直接 import，此处按同样组合逻辑复刻以作评测与回归基线。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { runLightCheck } from '../../electron/main/ai/audit/light-check.ts'
import { extractJsonObject } from '../../electron/main/ai/tasks/base.ts'
import { arbitrateSettlement } from '../../electron/main/ai/settlement/arbiter.ts'
import { reconcileForeshadowing } from '../../electron/main/ai/settlement/foreshadow-reconcile.ts'
import {
  clearSettlementSnapshots,
  hasSettledContent,
  initSettlementSchema,
  recordSettlementRun,
  settlementContentHash,
  snapshotSettlementState
} from '../../electron/main/ai/settlement/settlement-store.ts'
import { DEFAULT_SETTLEMENT_POLICY } from '../../electron/main/ai/settlement/types.ts'
import {
  applyStateDelta,
  buildStoryStateContext,
  getActiveForeshadowing,
  hasStateDeltaContent,
  initStoryStateSchema,
  normalizeStateDelta
} from '../../electron/main/story-state-store.ts'

import { scenarios } from './corpus.mjs'

const PROJECT = 'eval-project'

// ==================== 本地复刻的结算组合逻辑 ====================

function buildIssues(preState, chapterIndex, content, delta, extra = []) {
  const issues = []
  if (delta) {
    const check = runLightCheck(content, preState, delta)
    for (const v of check.violations) {
      issues.push({ category: v.type, severity: v.severity, message: v.message })
    }
    issues.push(...reconcileForeshadowing({
      activeForeshadowing: preState.activeForeshadowing,
      chapterIndex,
      delta
    }))
  }
  issues.push(...extra)
  return issues
}

function scopeFromDelta(delta) {
  if (!delta) return { characterIds: [], foreshadowingIds: [], relationshipIds: [] }
  const f = delta.foreshadowing_delta ?? { planted: [], advanced: [], resolved: [] }
  return {
    characterIds: delta.characters_updated?.map((c) => c.character_id) ?? [],
    foreshadowingIds: [
      ...(f.planted ?? []).map((p) => p.id),
      ...(f.advanced ?? []).map((a) => a.id),
      ...(f.resolved ?? []).map((r) => r.id)
    ],
    relationshipIds: delta.relationships_delta?.map((r) => r.relationship_id) ?? []
  }
}

function record(db, chapterIndex, contentHash, attempt, status, decision, issues, delta, reason) {
  recordSettlementRun(db, {
    projectId: PROJECT,
    chapterId: `ch${chapterIndex}`,
    chapterIndex,
    contentHash,
    attempt,
    status,
    decision,
    issues,
    delta,
    reason
  })
}

async function settleChapter(db, chapter) {
  const preState = buildStoryStateContext(db, PROJECT, [])
  const contentHash = settlementContentHash(chapter.content)
  const base = {
    projectId: PROJECT,
    chapterId: `ch${chapter.index}`,
    chapterIndex: chapter.index,
    contentHash,
    content: chapter.content,
    alreadySettled: false,
    policy: DEFAULT_SETTLEMENT_POLICY
  }

  if (hasSettledContent(db, PROJECT, chapter.index, contentHash)) {
    return { status: 'skipped', decision: 'skip', applied: false, issues: [], reason: '幂等跳过', attemptsUsed: 1 }
  }

  let delta = chapter.delta ?? null
  let observerFailed = false
  if (chapter.observerRaw !== undefined) {
    // P5：用真实 Observer 解析路径（extractJsonObject → normalizeStateDelta → hasContent）
    let parsed = null
    try {
      parsed = extractJsonObject(chapter.observerRaw)
    } catch {
      parsed = null
    }
    delta = parsed ? normalizeStateDelta(parsed) : null
    if (delta && !hasStateDeltaContent(delta)) delta = null
    if (!delta) observerFailed = true
  }
  if (observerFailed) {
    return {
      status: 'skipped', decision: 'skip', applied: false, issues: [], reason: 'Observer 输出无法解析',
      attemptsUsed: 1, detectedError: false, observerFailed: true
    }
  }

  const firstIssues = buildIssues(preState, chapter.index, chapter.content, delta, chapter.extraIssues ?? [])
  let decision = arbitrateSettlement({ ...base, delta, preIssues: firstIssues, observeAttempt: 0 })
  let attemptsUsed = 1
  const detectedError = firstIssues.some((i) => i.severity === 'error')

  if (decision.type === 'retry_observe') {
    record(db, chapter.index, contentHash, 0, 'rejected', 'retry_observe', decision.issues, delta, decision.reason)
    if (chapter.retryDelta) {
      delta = chapter.retryDelta
      const retryIssues = buildIssues(preState, chapter.index, chapter.content, delta)
      decision = arbitrateSettlement({ ...base, delta, preIssues: retryIssues, observeAttempt: 1 })
      attemptsUsed = 2
    } else {
      decision = { type: 'reject', status: 'rejected', issues: decision.issues, reason: '无法自动重观察，拒绝落盘' }
    }
  }

  const status = decision.status
  const issues = decision.issues
  if (decision.type === 'skip' || decision.type === 'reject') {
    record(db, chapter.index, contentHash, attemptsUsed, status, decision.type, issues, delta, decision.reason)
    return { status, decision: decision.type, applied: false, issues, reason: decision.reason, attemptsUsed, detectedError }
  }

  // apply / apply_with_warning
  snapshotSettlementState(db, PROJECT, chapter.index, scopeFromDelta(delta))
  try {
    if (delta) applyStateDelta(db, PROJECT, chapter.index, delta)
    clearSettlementSnapshots(db, PROJECT, chapter.index)
    record(db, chapter.index, contentHash, attemptsUsed, status, decision.type, issues, delta, decision.reason)
    return { status, decision: decision.type, applied: true, issues, reason: decision.reason, attemptsUsed, detectedError }
  } catch (error) {
    record(db, chapter.index, contentHash, attemptsUsed, 'error', 'reject',
      [{ category: 'state_conflict', severity: 'error', message: String(error) }], delta, 'applyStateDelta 异常')
    return { status: 'error', decision: 'reject', applied: false, issues: [], reason: String(error), attemptsUsed, detectedError }
  }
}

// ==================== 指标聚合 ====================

const CONTRADICTION_WARNING_CATEGORIES = new Set([
  'location_mismatch', 'item_not_owned', 'state_conflict', 'timeline_break', 'rule_violation'
])

async function runScenario(scenario) {
  const db = new DatabaseSync(':memory:')
  initStoryStateSchema(db)
  initSettlementSchema(db)

  const chapters = scenario.chapters.map((c) => ({ ...c }))
  const failures = []
  let contradictionSuspect = 0
  let hardContradictionPrevented = 0
  let attempted = 0
  let observerProvided = 0
  let observerFailures = 0

  for (const chapter of chapters) {
    const outcome = await settleChapter(db, chapter)
    const usesObserver = chapter.observerRaw !== undefined
    const observerFailed = !!outcome.observerFailed
    if (usesObserver) {
      observerProvided += 1
      if (observerFailed) observerFailures += 1
    }
    const hasDelta = observerFailed ? false : (usesObserver ? true : chapter.delta != null)
    if (hasDelta) attempted += 1
    if (outcome.issues.some((i) => CONTRADICTION_WARNING_CATEGORIES.has(i.category))) contradictionSuspect += 1
    if (outcome.detectedError && outcome.status === 'rejected') hardContradictionPrevented += 1

    const expected = chapter.expectStatus
    if (expected) {
      if (outcome.status !== expected) {
        failures.push(`第${chapter.index}章：期望 ${expected}，实际 ${outcome.status}（${outcome.reason}）`)
      }
    } else if (hasDelta && !['settled', 'settled_with_warning'].includes(outcome.status)) {
      failures.push(`第${chapter.index}章：期望结算成功，实际 ${outcome.status}（${outcome.reason}）`)
    }

    if (chapter.recordStatus) {
      scenario.metrics = scenario.metrics ?? {}
    }
    chapter.outcome = outcome
  }

  // 伏笔回收（仅在语料声明期望时统计）
  let recovered = null
  let planned = null
  if (scenario.expect?.plannedForeshadowing != null) {
    const hooks = db.prepare('SELECT * FROM story_foreshadowing').all()
    planned = scenario.expect.plannedForeshadowing
    recovered = hooks.filter((h) => h.payoff_chapter != null && h.resolved_chapter != null).length
    if (recovered !== scenario.expect.recoveredForeshadowing) {
      failures.push(`伏笔回收期望 ${scenario.expect.recoveredForeshadowing}，实际 ${recovered}`)
    }
  }

  const settled = chapters.filter((c) => ['settled', 'settled_with_warning'].includes(c.outcome.status)).length
  const rejected = chapters.filter((c) => c.outcome.status === 'rejected').length
  const skipped = chapters.filter((c) => c.outcome.status === 'skipped').length

  return {
    id: scenario.id,
    name: scenario.name,
    chapters: chapters.length,
    attempted,
    settled,
    rejected,
    skipped,
    contradictionSuspect,
    hardContradictionPrevented,
    observerProvided,
    observerFailures,
    foreshadowing: { planned, recovered },
    failures
  }
}

// ==================== P5：生成式语料（200 条口径，确定性） ====================

function genDelta(charId, from, to) {
  return {
    characters_updated: [{ character_id: charId, changes: { location: { from, to } } }],
    relationships_delta: [],
    foreshadowing_delta: { planted: [], advanced: [], resolved: [] },
    timeline: { story_time_elapsed: '', current_story_date: '', events: [], world_state_changes: [] }
  }
}

/** 确定性生成 200 章混合语料（正常/矛盾拒绝/自动修复/伏笔埋设/无变更），独立场景自己的内存库。 */
function buildGeneratedScenario(total = 200) {
  const chars = ['林岚', '顾川', '沈夜']
  const locations = {}
  const chapters = []
  let plantSeq = 0
  const FORES = ['铜钱', '白影', '断剑', '密道']
  for (let i = 0; i < total; i += 1) {
    const charId = chars[i % chars.length]
    const prev = locations[charId] ?? ''
    const next = `地点${(i * 7 + 1) % 23}`
    const recipe = i % 5
    if (recipe === 0) {
      locations[charId] = next
      chapters.push({
        index: i,
        content: `第${i}章：${charId}从${prev || '起点'}前往${next}。`,
        delta: genDelta(charId, prev, next),
        expectStatus: 'settled'
      })
    } else if (recipe === 1) {
      // L1 硬矛盾（无重试修正）→ 拒绝落盘
      chapters.push({
        index: i,
        content: `第${i}章：${charId}（矛盾剧情）。`,
        delta: genDelta(charId, prev, next),
        extraIssues: [{
          category: 'state_conflict', severity: 'error',
          message: `跨章矛盾：${charId}不应出现在此处`, ref: charId
        }],
        expectStatus: 'rejected'
      })
    } else if (recipe === 2) {
      // 首轮 error → 自动重观察修正 → 成功
      locations[charId] = next
      chapters.push({
        index: i,
        content: `第${i}章：${charId}前往${next}。`,
        delta: genDelta(charId, '错误起点', next),
        extraIssues: [{
          category: 'location_mismatch', severity: 'error',
          message: `位置 from 与账本不符：应为 ${prev}`, ref: charId
        }],
        retryDelta: genDelta(charId, prev, next),
        expectStatus: 'settled'
      })
    } else if (recipe === 3) {
      const hook = `伏笔-G${plantSeq}`
      plantSeq += 1
      const payoff = i + 6
      chapters.push({
        index: i,
        content: `第${i}章：埋设线索（${FORES[i % FORES.length]}）。`,
        delta: {
          characters_updated: [],
          relationships_delta: [],
          foreshadowing_delta: {
            planted: [{ id: hook, type: '暗线', description: FORES[i % FORES.length], method: '道具', payoff_chapter: payoff }],
            advanced: [],
            resolved: []
          },
          timeline: { story_time_elapsed: '', current_story_date: '', events: [], world_state_changes: [] }
        }
      })
    } else {
      chapters.push({
        index: i,
        content: `第${i}章：只有景物描写，无状态变更。`,
        delta: null,
        expectStatus: 'skipped'
      })
    }
  }
  return { id: `GEN-${total}-chapters`, name: `生成式 ${total} 章混合语料`, chapters }
}

/** 汇总基准（用于跨版本回归门禁比较）。 */
function summaryMetrics(results) {
  const attempted = results.reduce((s, r) => s + r.attempted, 0)
  const settled = results.reduce((s, r) => s + r.settled, 0)
  const rejected = results.reduce((s, r) => s + r.rejected, 0)
  const skipped = results.reduce((s, r) => s + r.skipped, 0)
  const contradictionSuspect = results.reduce((s, r) => s + r.contradictionSuspect, 0)
  const prevented = results.reduce((s, r) => s + r.hardContradictionPrevented, 0)
  const planned = results.reduce((s, r) => s + (r.foreshadowing.planned ?? 0), 0)
  const recovered = results.reduce((s, r) => s + (r.foreshadowing.recovered ?? 0), 0)
  const observerProvided = results.reduce((s, r) => s + r.observerProvided, 0)
  const observerFailures = results.reduce((s, r) => s + r.observerFailures, 0)
  return {
    settlementSuccessRate: attempted ? +(settled / attempted).toFixed(4) : null,
    attemptedChapters: attempted,
    settledChapters: settled,
    rejectedChapters: rejected,
    skippedChapters: skipped,
    contradictionSuspectRate: attempted ? +(contradictionSuspect / attempted).toFixed(4) : null,
    contradictionSuspect,
    hardContradictionPrevented: prevented,
    observerProvided,
    observerFailures,
    observerRecoveryRate: observerProvided ? +((observerProvided - observerFailures) / observerProvided).toFixed(4) : null,
    foreshadowRecoveryRate: planned ? +(recovered / planned).toFixed(4) : null,
    foreshadowPlanned: planned,
    foreshadowRecovered: recovered
  }
}

async function main() {
  const acceptBaseline = process.argv.includes('--accept')
  const results = []
  const totalFailures = []

  // P5：既有手工语料 + 200 条生成式语料（确定性）
  const scenarioList = [...scenarios, buildGeneratedScenario(200)]
  for (const scenario of scenarioList) {
    const result = await runScenario(scenario)
    results.push(result)
    for (const f of result.failures) totalFailures.push(`[${scenario.id}] ${f}`)
  }

  const metrics = summaryMetrics(results)
  const report = {
    generatedAt: new Date().toISOString(),
    mode: acceptBaseline ? 'baseline-accept' : 'gate',
    metrics,
    scenarios: results,
    failures: totalFailures
  }

  const reportDir = new URL('./report/', import.meta.url)
  await mkdir(fileURLToPath(reportDir), { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(fileURLToPath(reportDir), `eval-${stamp}.json`)
  await writeFile(target, JSON.stringify(report, null, 2), 'utf8')

  // P5：基线门禁（对比 eval-baseline.json；--accept 时用本次结果更新基线）
  const baselinePath = join(fileURLToPath(reportDir), 'eval-baseline.json')
  const gateFailures = []
  if (acceptBaseline) {
    await writeFile(baselinePath, JSON.stringify(metrics, null, 2), 'utf8')
  } else {
    try {
      const base = JSON.parse(await readFile(baselinePath, 'utf8'))
      const guard = (key, dir, tol, label) => {
        const cur = metrics[key]
        const prev = base[key]
        if (cur == null || prev == null) return
        const diff = cur - prev
        const regressed = dir === 'down' ? diff < -tol : diff > tol
        if (regressed) gateFailures.push(`${label}：${prev} → ${cur}（${diff >= 0 ? '+' : ''}${diff.toFixed(4)}）`)
      }
      guard('settlementSuccessRate', 'down', 0.03, '结算成功率回退')
      guard('foreshadowRecoveryRate', 'down', 0.03, '伏笔回收率回退')
      guard('observerRecoveryRate', 'down', 0.05, 'Observer 恢复率回退')
      guard('contradictionSuspectRate', 'up', 0.05, '矛盾疑点率上升')
    } catch {
      gateFailures.push('无基线文件，请先运行 `pnpm eval:accept` 建档')
    }
  }

  // console summary
  console.log('=== 结算闭环离线评测（含生成式 200 条） ===')
  console.log(`结算成功率: ${(metrics.settlementSuccessRate * 100).toFixed(1)}% (${metrics.settledChapters}/${metrics.attemptedChapters})`)
  console.log(`矛盾疑点率(L0 warning 级): ${(metrics.contradictionSuspectRate * 100).toFixed(1)}% (${metrics.contradictionSuspect}/${metrics.attemptedChapters})`)
  console.log(`硬矛盾被拦截数(rejected): ${metrics.hardContradictionPrevented}，拒绝: ${metrics.rejectedChapters}，跳过: ${metrics.skippedChapters}`)
  console.log(`伏笔回收率: ${metrics.foreshadowRecoveryRate != null ? (metrics.foreshadowRecoveryRate * 100).toFixed(1) + '%' : 'n/a'} (${metrics.foreshadowRecovered}/${metrics.foreshadowPlanned})`)
  if (metrics.observerProvided > 0) {
    console.log(`Observer 故障注入: 恢复率 ${(metrics.observerRecoveryRate * 100).toFixed(1)}% (${metrics.observerProvided - metrics.observerFailures}/${metrics.observerProvided})`)
  }
  for (const r of results) {
    const mark = r.failures.length ? '✗' : '✓'
    console.log(`  ${mark} ${r.id} ${r.name} (settled=${r.settled} rejected=${r.rejected} skipped=${r.skipped})`)
  }
  if (totalFailures.length) {
    console.log('断言失败明细:')
    for (const f of totalFailures) console.log(`  - ${f}`)
  }
  if (gateFailures.length) {
    console.log('基线门禁:')
    for (const g of gateFailures) console.log(`  - ${g}`)
  }
  console.log(`报告: ${target}`)
  console.log(`基线: ${acceptBaseline ? '已用本次结果更新 ' + baselinePath : baselinePath}`)

  if (totalFailures.length || gateFailures.length) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
