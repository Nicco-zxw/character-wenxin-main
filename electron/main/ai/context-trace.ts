/**
 * P7.4 过程审计：context_traces —— 每章记录「这次结算喂了什么」。
 *
 * 原则：只落账、不改生成质量（真正的 protected 预算执行属 P6.4b）。
 * 记录 story 上下文六大来源 + 理由 + protected/compressible 分层 + token 粗估，
 * 并回填 settlement_runs.trace_id，使「账本记录 ↔ 过程 trace」可互相反查。
 *
 * 约束：仅依赖 node 内置模块 + `import type`（被擦除），可直接被 `node --test` 以 `.ts` 后缀导入。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { StoryStateContext } from '../story-state-store'

/** 是否开启结算上下文 trace 落账（默认开；置 false 并重启即整体回退）。 */
export const CONTEXT_TRACE_ON = true

/**
 * P6.4：protected 预算执行开关（默认关 = 仅审计落账，不改结算行为）。
 * 置 true 时，编排层应据 evaluateContextBudget 决策——protected 来源超预算即硬约束超限（不压缩、不静默降级）。
 */
export const CONTEXT_BUDGET_ON = false

/** P6.4：protected 来源（世界规则/活跃伏笔/倒计时）的 token 粗估预算上限（chars/4）。 */
export const PROTECTED_TOKEN_BUDGET = 8000

export type TraceTier = 'protected' | 'compressible'

/** 一条入选来源：来源名 + 为什么选 + 摘录。 */
export interface TraceSource {
  source: string
  reason: string
  excerpt?: string
}

export interface TraceTiers {
  protected: string[]
  compressible: string[]
}

export interface TraceTokens {
  protectedTokens: number
  compressibleTokens: number
  totalSelectedTokens: number
}

export interface ContextTraceRecord {
  id: string
  projectId: string
  chapterIndex: number | null
  runKind: string
  sourceEventId: string | null
  selectedSources: TraceSource[]
  tiers: TraceTiers
  tokens: TraceTokens
  createdAt: string
}

/** P6.4：protected 预算评估结论（protected 来源超上限 = 硬约束超限，不可压缩降级）。 */
export interface ContextBudgetVerdict {
  overBudget: boolean
  protectedTokens: number
  budgetLimit: number
  /** 超出量（<=0 表示未超限）。 */
  exceededBy: number
}

/**
 * P6.4：protected 预算评估（纯函数）。
 * protected 来源（world_rules/active_foreshadowing/countdown_clocks）是硬约束：
 * 超过预算上限即 overBudget=true——语义上不可压缩、应触发编排层硬错误/告警。
 */
export function evaluateContextBudget(
  tokens: Pick<TraceTokens, 'protectedTokens'>,
  opts?: { budgetLimit?: number }
): ContextBudgetVerdict {
  const budgetLimit = opts?.budgetLimit ?? PROTECTED_TOKEN_BUDGET
  const protectedTokens = tokens.protectedTokens
  return {
    overBudget: protectedTokens > budgetLimit,
    protectedTokens,
    budgetLimit,
    exceededBy: Math.max(0, protectedTokens - budgetLimit)
  }
}

/** token 粗估：中文约 1 token ≈ 4 字符（只用于审计量级，非精确计费）。 */
const CHARS_PER_TOKEN = 4

const CONTEXT_TRACE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS context_traces (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    chapter_index INTEGER,
    run_kind TEXT NOT NULL DEFAULT 'settle',
    source_event_id TEXT,
    selected_sources_json TEXT NOT NULL DEFAULT '[]',
    tiers_json TEXT NOT NULL DEFAULT '{}',
    token_budget_json TEXT NOT NULL DEFAULT '{}',
    compression_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_context_traces_project
    ON context_traces (project_id, chapter_index, created_at DESC);
`

export function initContextTraceSchema(db: DatabaseSync): void {
  db.exec(CONTEXT_TRACE_SCHEMA)
}

function uid(): string {
  return `ct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function now(): string {
  return new Date().toISOString()
}

function toTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/** 摘录上限字符数。 */
const EXCERPT_MAX = 200

/** 六大 story 上下文来源的元信息 + 轻量渲染（供 excerpt / token 估算）。 */
const SOURCE_META: Array<{
  source: string
  reason: string
  protected: boolean
  render: (ctx: StoryStateContext) => string
}> = [
  {
    source: 'world_rules',
    reason: '世界规则是硬约束，需完整保留（protected）',
    protected: true,
    render: (ctx) => ctx.worldRules.map((r) => r.ruleContent).join('；')
  },
  {
    source: 'active_foreshadowing',
    reason: '活跃伏笔是跨章记忆证据，需保真（protected）',
    protected: true,
    render: (ctx) => ctx.activeForeshadowing.map((f) => `${f.foreshadowingId}[${f.status}]：${f.description}`).join('；')
  },
  {
    source: 'countdown_clocks',
    reason: '倒计时悬念驱动节奏，需保留（protected）',
    protected: true,
    render: (ctx) => ctx.activeClocks.map((c) => `[${c.urgency}]${c.eventDescription}`).join('；')
  },
  {
    source: 'character_states',
    reason: '角色当前状态（数量大，可语义压缩）',
    protected: false,
    render: (ctx) => ctx.characterStates.map((c) => `${c.characterId}@${c.location ?? '未知'}${c.mentalState ? `：${c.mentalState}` : ''}`).join('；')
  },
  {
    source: 'relationships',
    reason: '关系网络（可压缩）',
    protected: false,
    render: (ctx) => ctx.relationships.map((r) => `${r.participantA}↔${r.participantB}：${r.currentStatus}`).join('；')
  },
  {
    source: 'recent_timeline',
    reason: '近期时间线（可压缩）',
    protected: false,
    render: (ctx) => ctx.recentTimeline.map((t) => `第${t.chapterIndex}章${t.storyDate ? `[${t.storyDate}]` : ''}：${t.events.join('; ')}`).join('；')
  }
]

/**
 * 纯构造：把 StoryStateContext 六大 section 转成 trace 输入（来源/分层/token 粗估）。
 * 无内容（空）的 section 不入选 → 天然无重复 source。
 */
export function buildTraceFromStoryContext(
  ctx: StoryStateContext
): { selectedSources: TraceSource[]; tiers: TraceTiers; tokens: TraceTokens } {
  const selectedSources: TraceSource[] = []
  const protectedSources: string[] = []
  const compressibleSources: string[] = []
  let protectedChars = 0
  let compressibleChars = 0

  for (const meta of SOURCE_META) {
    const text = meta.render(ctx).trim()
    if (!text) continue
    selectedSources.push({
      source: meta.source,
      reason: meta.reason,
      excerpt: text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX)}…` : text
    })
    if (meta.protected) {
      protectedSources.push(meta.source)
      protectedChars += text.length
    } else {
      compressibleSources.push(meta.source)
      compressibleChars += text.length
    }
  }

  return {
    selectedSources,
    tiers: { protected: protectedSources, compressible: compressibleSources },
    tokens: {
      protectedTokens: toTokens(protectedChars),
      compressibleTokens: toTokens(compressibleChars),
      totalSelectedTokens: toTokens(protectedChars + compressibleChars)
    }
  }
}

/** 落库一条 trace；selectedSources 按 source 去重（防呆）。返回 traceId。P6.4：可附预算评估与压缩记录。 */
export function createContextTrace(
  db: DatabaseSync,
  input: {
    projectId: string
    chapterIndex?: number | null
    runKind?: string
    sourceEventId?: string | null
    selectedSources: TraceSource[]
    tiers: TraceTiers
    tokens: TraceTokens
    /** P6.4：protected 预算评估（缺省=未评估，仅记 tokens）。 */
    budget?: ContextBudgetVerdict | null
    /** P6.4：本次压缩记录（缺省=未压缩）。 */
    compression?: { applied: string[]; reason: string } | null
  }
): string {
  const id = uid()
  const seen = new Set<string>()
  const deduped = input.selectedSources.filter((s) => {
    const key = s.source
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  // P6.4：token_budget_json 兼容旧内容（tokens）并附预算评估；compression_json 由预留转为实际记录
  const tokensJson = input.budget
    ? JSON.stringify({
        ...input.tokens,
        budgetLimit: input.budget.budgetLimit,
        overBudget: input.budget.overBudget,
        exceededBy: input.budget.exceededBy
      })
    : JSON.stringify(input.tokens)
  const compressionJson = input.compression ? JSON.stringify(input.compression) : '{}'
  db.prepare(`
    INSERT INTO context_traces (
      id, project_id, chapter_index, run_kind, source_event_id,
      selected_sources_json, tiers_json, token_budget_json, compression_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.projectId,
    input.chapterIndex == null ? null : input.chapterIndex,
    input.runKind ?? 'settle',
    input.sourceEventId ?? null,
    JSON.stringify(deduped),
    JSON.stringify(input.tiers),
    tokensJson,
    compressionJson,
    now()
  )
  return id
}
