/**
 * A2 真实 LLM 评测标定（小样本）。
 *
 * 用法：
 *   1. cp scripts/eval/llm-settings.example.json scripts/eval/llm-settings.json 并填入真实端点
 *   2. pnpm eval:llm
 *
 * 流程（与真实管线同源）：
 *   真实正文 → 真实 LLM Observer（buildObserverPrompt，与 orchestrator 同源）→ 提取失败重试 1 次
 *   → L1 真实 LLM 对账（buildReconcilePrompt）→ L0 确定性 runLightCheck + 伏笔对账
 *   → 确定性 Arbiter → apply/record。产出 eval-llm-*.json，供人工比对真实 LLM 口径的矛盾/回收/成功率。
 *
 * 说明：conflict 章节不 hard-fail（模型行为不可控），仅记录是否被拦供观察。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { runLightCheck } from '../../electron/main/ai/audit/light-check.ts'
import { extractJsonObject } from '../../electron/main/ai/tasks/base.ts'
import { arbitrateSettlement } from '../../electron/main/ai/settlement/arbiter.ts'
import { reconcileForeshadowing } from '../../electron/main/ai/settlement/foreshadow-reconcile.ts'
import { normalizeReconcileIssues } from '../../electron/main/ai/settlement/l1-reconcile.ts'
import { buildObserverPrompt, buildReconcilePrompt } from '../../electron/main/ai/settlement/llm-prompts.ts'
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
  formatStoryStateForPrompt,
  hasStateDeltaContent,
  initStoryStateSchema,
  normalizeStateDelta
} from '../../electron/main/story-state-store.ts'

import { FORESHADOW_MARKERS, LLM_PROJECT, llmChapters } from './llm-corpus.mjs'

const DIR = join(import.meta.dirname ?? fileURLToPath(new URL('.', import.meta.url)))

// ==================== 配置 ====================

async function loadSettings() {
  const path = join(DIR, 'llm-settings.json')
  try {
    return JSON.parse(await readFile(path, 'utf-8'))
  } catch {
    console.error('[eval:llm] 缺少 scripts/eval/llm-settings.json。请先：')
    console.error('  cp scripts/eval/llm-settings.example.json scripts/eval/llm-settings.json')
    console.error('  并填入你的 baseUrl / apiKey / model。')
    process.exit(1)
  }
}

async function chat(settings, prompt, maxTokens) {
  const resp = await fetch(`${settings.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({
      model: settings.model,
      messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
      temperature: 0,
      max_tokens: maxTokens ?? settings.maxTokens ?? 1500
    })
  })
  if (!resp.ok) {
    throw new Error(`LLM HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
  }
  const data = await resp.json()
  const text = data?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || !text.trim()) throw new Error('LLM 返回为空')
  return text
}

// ==================== Observer / L1（真实 LLM，prompt 与 orchestrator 同源） ====================

async function observeDelta(settings, preState, content) {
  const snapshot = formatStoryStateForPrompt(preState)
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = buildObserverPrompt({
      stateSnapshot: snapshot,
      chapterContent: content,
      feedback: attempt === 1 ? '上一轮输出无法解析为合法的状态变更 JSON，请只输出纯 JSON（不要解释/围栏）。' : undefined
    })
    const raw = await chat(settings, prompt, 1500)
    let parsed = null
    try { parsed = extractJsonObject(raw) } catch { parsed = null }
    const delta = parsed ? normalizeStateDelta(parsed) : null
    if (delta && hasStateDeltaContent(delta)) return { delta, raw }
  }
  return { delta: null, raw: null }
}

async function reconcileL1(settings, preState, content, delta) {
  const snapshot = formatStoryStateForPrompt(preState)
  const prompt = buildReconcilePrompt({
    stateSnapshot: snapshot,
    chapterContent: content,
    deltaJson: JSON.stringify(delta)
  })
  const raw = await chat(settings, prompt, 1200)
  let parsed = null
  try { parsed = extractJsonObject(raw) } catch { parsed = null }
  return { issues: normalizeReconcileIssues(parsed), raw }
}

// ==================== 组合（同 run-eval 确定性组合） ====================

function buildIssues(preState, chapterIndex, content, delta, l1Issues = []) {
  const issues = []
  if (delta) {
    const check = runLightCheck(content, preState, delta)
    for (const v of check.violations) {
      issues.push({ category: v.type, severity: v.severity, message: v.message })
    }
    issues.push(...reconcileForeshadowing({ activeForeshadowing: preState.activeForeshadowing, chapterIndex, delta }))
  }
  issues.push(...l1Issues)
  return issues
}

/** R2 诊断：把 JSON/delta 压成可读摘要（超长截断）。 */
function summarizeJson(value) {
  if (value == null) return null
  const s = JSON.stringify(value)
  return s.length > 2500 ? `${s.slice(0, 2500)}…[截断]` : s
}

/** R2 诊断：issue 明细（category/severity/message/ref），供 report 追溯每条拒/放行依据。 */
function summarizeIssues(list) {
  return (list ?? []).map((i) => ({ category: i.category, severity: i.severity, message: i.message, ref: i.ref }))
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
    projectId: LLM_PROJECT, chapterId: `ch${chapterIndex}`, chapterIndex, contentHash,
    attempt, status, decision, issues, delta, reason
  })
}

/** A2b：Wilson 置信区间（小样本比例）。返回 { rate, ciLow, ciHigh, n } 或 null。 */
function wilsonInterval(success, total, z = 1.96) {
  if (!total) return null
  const p = success / total
  const z2 = z * z
  const denom = 1 + z2 / total
  const center = (p + z2 / (2 * total)) / denom
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total) / denom
  return {
    rate: Number(p.toFixed(3)),
    ciLow: Number(Math.max(0, center - margin).toFixed(3)),
    ciHigh: Number(Math.min(1, center + margin).toFixed(3)),
    n: total
  }
}

// ==================== 主流程 ====================

async function main() {
  const settings = await loadSettings()
  console.log(`[eval:llm] baseUrl=${settings.baseUrl} model=${settings.model} 章节=${llmChapters.length}`)

  const db = new DatabaseSync(':memory:')
  initStoryStateSchema(db)
  initSettlementSchema(db)

  const rows = []
  let observerFailures = 0

  for (const chapter of llmChapters) {
    const base = {
      projectId: LLM_PROJECT, chapterId: `ch${chapter.index}`, chapterIndex: chapter.index,
      content: chapter.content,
      policy: DEFAULT_SETTLEMENT_POLICY
    }
    const contentHash = settlementContentHash(chapter.content)
    const row = { index: chapter.index, tag: chapter.tag, conflictType: chapter.conflictType ?? null, status: '?', decision: '?', l1: 0, l0: 0, note: chapter.note, issues: [], reason: '', deltaJson: null, l1Raw: '' }
    try {
      const preState = buildStoryStateContext(db, LLM_PROJECT, [])
      const obs = await observeDelta(settings, preState, chapter.content)
      const delta = obs.delta
      row.deltaJson = summarizeJson(delta)
      if (!delta) {
        observerFailures += 1
        row.l1Raw = String(obs.raw ?? '').slice(0, 800)
        record(db, chapter.index, contentHash, 1, 'skipped', 'skip', [], null, 'Observer 真实提取失败/无状态变更')
        row.status = 'skipped(observer_fail)'
        row.reason = 'Observer 真实提取失败/无状态变更'
        rows.push(row)
        continue
      }
      // L1 真实对账（模拟生产 enableLLMReconcile）
      const l1 = await reconcileL1(settings, preState, chapter.content, delta)
      row.l1Raw = String(l1.raw ?? '').slice(0, 800)
      const preIssues = buildIssues(preState, chapter.index, chapter.content, delta, l1.issues)
      let decision = arbitrateSettlement({ ...base, contentHash, delta, preIssues, alreadySettled: false, observeAttempt: 0 })
      if (decision.type === 'retry_observe') {
        // 无自动重观察（已尽力一次）→ 拒绝
        decision = { type: 'reject', status: 'rejected', issues: decision.issues, reason: '真实 Observer/L1 判定矛盾且无法自动修正，拒绝落盘' }
      }
      const attemptsUsed = 1
      // R2：apply/apply_with_warning 记录完整 preIssues（含 warning/hint），skip/reject 记录裁决所依据的 issues
      row.issues = summarizeIssues(decision.type === 'apply' || decision.type === 'apply_with_warning' ? preIssues : decision.issues)
      row.reason = decision.reason ?? ''
      if (decision.type === 'skip' || decision.type === 'reject') {
        record(db, chapter.index, contentHash, attemptsUsed, decision.status, decision.type, decision.issues, delta, decision.reason)
        row.status = decision.status
        row.decision = decision.type
        row.l1 = l1.issues.filter((i) => i.severity === 'error').length
        row.l0 = preIssues.filter((i) => i.severity === 'error' && !l1.issues.includes(i)).length
        rows.push(row)
        continue
      }
      snapshotSettlementState(db, LLM_PROJECT, chapter.index, scopeFromDelta(delta))
      applyStateDelta(db, LLM_PROJECT, chapter.index, delta)
      clearSettlementSnapshots(db, LLM_PROJECT, chapter.index)
      record(db, chapter.index, contentHash, attemptsUsed, decision.status, decision.type, decision.issues, delta, decision.reason)
      row.status = decision.status
      row.decision = decision.type
      row.l1 = l1.issues.filter((i) => i.severity === 'error').length
      row.l0 = preIssues.filter((i) => i.severity === 'error' && !l1.issues.includes(i)).length
      rows.push(row)
    } catch (error) {
      row.status = 'error'
      row.note = `${row.note ?? ''} | ${error instanceof Error ? error.message : String(error)}`
      rows.push(row)
    }
  }

  // ==================== 指标 ====================
  const settled = rows.filter((r) => ['settled', 'settled_with_warning'].includes(r.status)).length
  const rejected = rows.filter((r) => r.status === 'rejected').length

  // A2b：矛盾注入分型拦截统计（按 conflictType 分别看拦截率）
  const conflictRows = rows.filter((r) => r.tag === 'conflict')
  const conflictByType = {}
  for (const r of conflictRows) {
    const t = r.conflictType ?? 'unknown'
    conflictByType[t] ??= { injected: 0, rejected: 0 }
    conflictByType[t].injected += 1
    if (r.status === 'rejected') conflictByType[t].rejected += 1
  }
  const conflictRejected = conflictRows.filter((r) => r.status === 'rejected').length

  // A2b：正常叙事章误拒（normal 被 reject = 误伤；conflict 章被拦是预期不算）
  const normalRows = rows.filter((r) => r.tag === 'normal')
  const normalSettled = normalRows.filter((r) => ['settled', 'settled_with_warning'].includes(r.status)).length
  const normalRejected = normalRows.filter((r) => r.status === 'rejected').length

  // 伏笔回收（按 marker 匹配 description；R2：分母=曾埋设 marker，避免 plant+resolve 双计）
  const fs = db.prepare('SELECT description, status FROM story_foreshadowing').all()
  const markers = FORESHADOW_MARKERS.filter((m) => fs.some((f) => String(f.description).includes(m)))
  const resolved = FORESHADOW_MARKERS.filter((m) => fs.some((f) => String(f.description).includes(m) && f.status === 'resolved'))
  const recoveryRate = markers.length > 0 ? resolved.length / markers.length : null
  // R5 诊断：语料期望埋设/回收的 marker vs 实际落账（Observer 是否填 foreshadowing_delta）
  const expectedMarkers = [...new Set(llmChapters.flatMap((c) => c.markers ?? []))]
  const missedMarkers = expectedMarkers.filter((m) => !markers.includes(m))

  // A2b：各比例带 Wilson 95% 置信区间
  const summary = {
    chapters: rows.length,
    settled,
    rejected,
    observerFailures,
    settleSuccessRate: wilsonInterval(settled, rows.length),
    conflictInjected: conflictRows.length,
    conflictRejected,
    conflictInterceptRate: wilsonInterval(conflictRejected, conflictRows.length),
    conflictByType: Object.fromEntries(Object.entries(conflictByType).map(([k, v]) => [
      k, { injected: v.injected, rejected: v.rejected, interceptRate: wilsonInterval(v.rejected, v.injected) }
    ])),
    normalPassRate: wilsonInterval(normalSettled, normalRows.length),
    normalRejected,
    foreshadowExpected: expectedMarkers,
    foreshadowMissed: missedMarkers,
    foreshadowPlanted: markers,
    foreshadowResolved: resolved,
    foreshadowRecoveryRate: recoveryRate,
    foreshadowRecoveryInterval: wilsonInterval(resolved.length, markers.length)
  }

  console.table(rows.map(({ index, tag, status, decision, l1, note }) => ({ 章: index, 类: tag, 终态: status, 裁决: decision, L1错误: l1, 说明: note })))
  console.log('[eval:llm] 汇总', JSON.stringify(summary, null, 2))

  await mkdir(join(DIR, 'report'), { recursive: true })
  const reportPath = join(DIR, 'report', `eval-llm-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  await writeFile(reportPath, JSON.stringify({ summary, rows }, null, 2), 'utf-8')
  console.log('报告: ', reportPath)
}

main().catch((error) => {
  console.error('[eval:llm] 失败:', error)
  process.exit(1)
})
