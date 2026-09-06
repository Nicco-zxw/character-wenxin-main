/**
 * Agent 角色差异化配置（轨道一 · 多 Agent 单章闭环）。
 *
 * 目标：让单章「规划(memo)-写(draft)-审(audit)-改(repair/humanize)-结算」闭环中
 * 每个任务 Agent 可以使用不同的 model / temperature / maxTokens，
 * 从而保障各环节输出质量稳定（参考 inkos `PipelineRunner.modelOverrides`）。
 *
 * 本模块为**纯函数 + 纯数据**（无 electron / node:sqlite / 其他依赖），可被
 *   - 渲染层（`@shared/agent-profiles`）：既有六步流式路径按步套用 settings；
 *   - 主进程（P8.2 `chapter-workflow` 协调器 / 未来项目级配置）：复用同一合并逻辑；
 *   - `node --test` 直接单测。
 *
 * 单一合并逻辑源：渲染层六步路径与主进程协调器共用本模块的
 * `applyAgentProfile / resolveStepSettings`，避免两侧编排语义分叉。
 */

/** 单章闭环中各任务 Agent 的角色（对齐既有渲染层六步 StreamTaskName）。 */
export type ChapterAgentRole =
  | 'memo'
  | 'draft'
  | 'audit'
  | 'repair'
  | 'humanize'
  | 'session-note'

/** 单个任务 Agent 的差异化配置（字段均可选；未设则回退全局 settings）。 */
export interface AgentProfile {
  /**
   * 覆盖模型名（已确认开放，专家项）。
   * 注意：必须与当前 provider/baseUrl 兼容（无法自动校验，提示性）。
   * 内置档位不预设 model——只有显式提供含 model 的 AgentProfile（未来项目级/全局配置）才生效。
   */
  readonly model?: string
  /** 覆盖采样温度（钳制到 [0, 2]）。 */
  readonly temperature?: number
  /** 覆盖单次调用最大输出 token（未设回退任务自身 resolveMaxTokens）。 */
  readonly maxTokens?: number
}

/** 按角色组织的差异化配置表（Partial：缺省角色回退内置档位 → 全局）。 */
export type AgentProfileMap = Partial<Record<ChapterAgentRole, AgentProfile>>

/**
 * 内置角色档位（零 UI 生效，默认只调 temperature，不覆盖 model）。
 * model 覆盖机制已开放（见 applyAgentProfile），仅当显式配置含 model 时才启用。
 */
export const DEFAULT_AGENT_PROFILES: AgentProfileMap = {
  memo: { temperature: 0.6 }, // 结构化规划：克制联想
  draft: { temperature: 0.8 }, // 创作：温度偏高
  audit: { temperature: 0.2 }, // 审查：低随机、严格
  repair: { temperature: 0.3 }, // 修复：最小改动保守
  humanize: { temperature: 0.4 }, // 去 AI 味：克制过度改写
  'session-note': { temperature: 0.5 }
}

/**
 * 该开关控制「既有六步流式路径是否按角色套用差异化 settings」。
 * 默认 false → 行为与现状一致（六步共享全局 settings）；
 * 经 `pnpm dev` 真机验证输出稳定后再置 true（可回退）。
 * 说明：主进程 chapter-workflow 协调器路径（P8.2）不依赖此开关。
 */
export const CHAPTER_AGENT_PROFILES_ENABLED = false

/** Agent 差分合并所需的最小 settings 结构（只触及 model / temperature）。 */
export type AgentSettingsLike = {
  model: string
  temperature?: number
}

/** 六步流式任务名 → 角色（渲染层与主进程共用同一映射）。 */
export const CHAPTER_TASK_ROLES: Readonly<Record<string, ChapterAgentRole>> = {
  'chapter-memo': 'memo',
  'chapter-first-draft': 'draft',
  'chapter-audit': 'audit',
  'chapter-repair': 'repair',
  'chapter-humanize': 'humanize',
  'chapter-session-note': 'session-note'
}

/** 由任务名解析角色；未注册任务返回 undefined（沿用全局设置）。 */
export function chapterRoleForTask(task: string): ChapterAgentRole | undefined {
  return CHAPTER_TASK_ROLES[task]
}

const clampTemperature = (value: number): number => Math.min(2, Math.max(0, value))

/**
 * 把单个 AgentProfile 合并到 settings 上。
 * - 无 profile 或无可覆盖字段 → 返回**原引用**（避免无谓重建）；
 * - 有覆盖 → 浅拷贝后仅改写 model / temperature；
 * - maxTokens 不在 settings 内，需另行透传（见 resolveAgentProfileMaxTokens）。
 */
export function applyAgentProfile<S extends AgentSettingsLike>(
  settings: S,
  profile: AgentProfile | undefined
): S {
  if (!profile) return settings
  let changed = false
  const patch: { model?: string; temperature?: number } = {}
  if (profile.model && profile.model !== settings.model) {
    patch.model = profile.model
    changed = true
  }
  if (profile.temperature != null && profile.temperature !== settings.temperature) {
    patch.temperature = clampTemperature(profile.temperature)
    changed = true
  }
  if (!changed) return settings
  return { ...settings, ...patch }
}

/**
 * 取某角色的最终 profile（优先级：map → 内置档位 → undefined）。
 * 这样「全局(基础 settings) → project map → 内置档位」的合并链只在这里体现一次。
 */
export function resolveRoleProfile(
  map: AgentProfileMap | undefined,
  role: ChapterAgentRole | undefined
): AgentProfile | undefined {
  if (!role) return undefined
  return map?.[role] ?? DEFAULT_AGENT_PROFILES[role]
}

/** 按角色解析最终 settings：`applyAgentProfile(settings, resolveRoleProfile(map, role))`。 */
export function resolveStepSettings<S extends AgentSettingsLike>(
  settings: S,
  map: AgentProfileMap | undefined,
  role: ChapterAgentRole | undefined
): S {
  return applyAgentProfile(settings, resolveRoleProfile(map, role))
}

/**
 * maxTokens 覆盖解析：profile.maxTokens 优先（≥1 取整）；否则用任务默认值。
 * （settings 里没有 maxTokens 字段，需在调用层单独透传。）
 */
export function resolveAgentProfileMaxTokens(
  profile: AgentProfile | undefined,
  taskDefault: number | undefined
): number | undefined {
  if (profile?.maxTokens != null) return Math.max(1, Math.floor(profile.maxTokens))
  return taskDefault
}
