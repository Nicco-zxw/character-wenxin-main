import type {
  AiTaskPayload,
  AiTaskKnowledgeContext,
  AiTaskResponse,
  AiTaskResult,
  AiRunUsage,
  AppSettings,
  AiStreamHandlers,
  ChapterPostGenerationIssuesPayload,
  ChapterPostGenerationTaskPayload,
  ChapterStateWarningsPayload
} from '../shared-types'
import { normalizeSettings, validateSettings, resolveMaxTokens, applyReasoningSafeFloor, shouldOmitMaxTokens, AGENT_TASK_WHITELIST } from '../settings'
import { getTaskHandler } from '../tasks'
import { getStructuredTaskSchema } from '../tasks/object-schemas'
import { resolveTaskSkills } from '../skills'
import { addAiRunUsage, aiGenerateText, aiGenerateTextWithUsage, aiStreamObjectWithUsage, aiStreamTextWithUsage } from '../generate'
import { isToolUseNotSupportedError } from '../provider'
import { buildPromptInput } from './context-builder'
import { enrichTaskContextForGeneration } from './task-context'
import { buildRunMeta, buildResponsePreview } from './run-meta'
import { logPrompt, logResponse, logSelection, logError } from './logging'
import { buildRepairPrompt } from '../prompts/repair'
import { extractJsonObject } from '../tasks/base'
import { runAgentTask } from '../agent'
import { ensureWorkspaceDb } from '../../workspace-store'
import { buildStoryStateContext, formatStoryStateForPrompt, hasStateDeltaContent, normalizeStateDelta } from '../../story-state-store'
import type { StateDelta } from '../../story-state-store'
import { indexChapterSegments } from '../knowledge-retrieval'
import { runLightCheck } from '../audit/light-check'
import { runChapterSettlement } from '../settlement'
import { buildObserverPrompt, buildReconcilePrompt } from '../settlement/llm-prompts'
import { normalizeReconcileIssues } from '../settlement/l1-reconcile'
import { resolveChapterOrdinal, latestSettlementCreatedAt } from '../settlement/settlement-store'
import type { SettlementIssue } from '../settlement/types'
import { formatAiErrorMessage } from '../error-message'
import { createHash, randomUUID } from 'node:crypto'
import { BackgroundTaskCoordinator } from './background-task-coordinator'
import {
  beginChapterProcessing,
  finishChapterProcessing,
  type ChapterProcessingStageStatus
} from './chapter-processing-store'

const postGenerationTasks = new BackgroundTaskCoordinator()

/**
 * P4.2-2：草稿期（post-gen 后处理）是否执行世界状态结算。
 * 定稿即结算（characterarc:settlement:sync，useChapterFirstDraft 收尾自动调用）已接管权威结算；
 * 草稿期结算会重复消耗 Observer+L1 且最终会被 supersede，故默认关闭（仅保留向量索引）。
 * 若存在不经过完整生成流程的 chapter-first-draft 调用方，可临时置回 true。
 */
const SETTLE_ON_DRAFT = false

type PostGenerationPipelineResult = {
  issues: ChapterPostGenerationIssuesPayload['issues']
  stateStatus: ChapterProcessingStageStatus
  indexStatus: ChapterProcessingStageStatus
}

/**
 * 执行一次完整的 AI 任务调用（非流式）。
 * 流程：校验设置 → 选择技能 → 混合检索 → 构建提示词 → 调用模型 → 校验/修复结果 → 触发后处理。
 * @param task - AI 任务载荷，包含任务类型、设置和上下文
 * @param knowledgeContext - 可选的知识检索上下文
 * @param signal - 可选的中止信号
 * @returns 任务执行结果与运行元数据
 */
export async function runAiTask(
  task: AiTaskPayload,
  knowledgeContext?: AiTaskKnowledgeContext,
  signal?: AbortSignal
): Promise<AiTaskResponse> {
  const handler = getTaskHandler(task.task)
  // 白名单内的任务直接尝试走 agent loop，不预判 provider 能力。
  // 如果模型不支持 tool_use，运行时会抛错，在 catch 中降级或提示用户。
  const settingsForRouting = normalizeSettings(task.settings)
  if (AGENT_TASK_WHITELIST.has(task.task)) {
    try {
      return await runAgentTask(task, knowledgeContext)
    } catch (error) {
      if (isToolUseNotSupportedError(error)) {
        if (task.task === 'reference-deep-analyze') {
          throw new Error('深度拆书需要模型支持 tool_use（工具调用）。当前模型不支持此功能，请切换到支持工具调用的模型后重试。')
        }
        // 其余白名单任务：降级到单次调用路径
      } else {
        throw error
      }
    }
  }

  const settings = settingsForRouting
  validateSettings(settings)
  const startedAt = new Date().toISOString()
  const clientKey = task.clientKey

  const { projectId, skills, usedSkillIds } = await resolveTaskSkills(task)
  logSelection(task.task, skills, knowledgeContext?.usedKnowledge ?? [])
  await enrichTaskContextForGeneration(task, settings)

  const input = buildPromptInput(task, skills, knowledgeContext)
  const prompt = handler.buildPrompt(input)
  const maxTokens = shouldOmitMaxTokens(task.task)
    ? undefined
    : applyReasoningSafeFloor(handler.resolveMaxTokens?.(input) ?? resolveMaxTokens(task))
  const structuredSchema = handler.outputType === 'json' ? getStructuredTaskSchema(handler.name) : undefined

  if (handler.outputType === 'json' && !structuredSchema) {
    throw new Error(`任务 ${handler.name} 缺少结构化输出 schema。`)
  }

  logPrompt('REQUEST', settings, prompt, task.task, usedSkillIds)

  const requestStartedAt = Date.now()
  let totalUsage: AiRunUsage | undefined

  try {
    let generation = await aiGenerateTextWithUsage(
      settings,
      prompt,
      maxTokens,
      signal,
      structuredSchema ? { schema: structuredSchema } : undefined
    )
    totalUsage = addAiRunUsage(totalUsage, generation.usage)
    let rawText = generation.text
    logResponse('REQUEST', settings, task.task, rawText, Date.now() - requestStartedAt, { usedSkills: usedSkillIds })
    let result: AiTaskResult
    let normalizeFailed = false
    try {
      result = handler.normalize(rawText, task.context)
    } catch {
      result = {} as AiTaskResult
      normalizeFailed = true
    }
    let repairTriggered = false

    // JSON 修复：最多重试 2 次，每次附上具体校验失败原因
    if (handler.outputType === 'json' && (normalizeFailed || !handler.validate(result))) {
      const MAX_REPAIR_ATTEMPTS = 2
      for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
        const validationErrors = (!normalizeFailed && handler.describeValidationErrors)
          ? handler.describeValidationErrors(result)
          : ['JSON 解析失败或结构不完整']
        const repairPromptPair = buildRepairPrompt(prompt.system, prompt.user, rawText, validationErrors)
        logPrompt(`REPAIR_${attempt}`, settings, repairPromptPair, task.task, usedSkillIds)
        const repairStartedAt = Date.now()
        generation = await aiGenerateTextWithUsage(
          settings,
          repairPromptPair,
          maxTokens,
          signal,
          structuredSchema ? { schema: structuredSchema } : undefined
        )
        totalUsage = addAiRunUsage(totalUsage, generation.usage)
        rawText = generation.text
        logResponse(`REPAIR_${attempt}`, settings, task.task, rawText, Date.now() - repairStartedAt, { usedSkills: usedSkillIds })
        normalizeFailed = false
        try {
          result = handler.normalize(rawText, task.context)
        } catch {
          result = {} as AiTaskResult
          normalizeFailed = true
        }
        repairTriggered = true

        if (!normalizeFailed && handler.validate(result)) {
          break
        }

        if (attempt === MAX_REPAIR_ATTEMPTS) {
          throw new Error('AI 返回的结构化结果经过 2 次修复仍不完整，请稍后重试或调整提示词。')
        }
      }
    }

    // 章节生成后：异步提取状态变更 + 建立向量索引（不阻塞返回）
    if (task.task === 'chapter-first-draft' && projectId && !normalizeFailed) {
      const finalContent = (result as { content?: string }).content ?? ''
      const chapterId = String(task.context.chapterId ?? '').trim()
      const chIdx = Number(task.context.chapterIndex ?? task.context.chapterSortOrder ?? 0)

      if (finalContent.length > 50) {
        schedulePostGenerationPipeline(settings, projectId, chIdx, chapterId, finalContent, task.context)
      }
    }

    const finishedAt = new Date().toISOString()
    return {
      result,
      meta: buildRunMeta(
        task.task,
        projectId,
        String(task.context.chapterId ?? '').trim() || undefined,
        settings,
        'success',
        startedAt,
        finishedAt,
        totalUsage,
        knowledgeContext?.usedKnowledge ?? [],
        usedSkillIds,
        repairTriggered,
        buildResponsePreview(result),
        '',
        clientKey
      )
    }
  } catch (error) {
    const finishedAt = new Date().toISOString()
    const message = formatAiErrorMessage(error, 'AI 调用失败')
    logError('REQUEST', settings, task.task, error, Date.now() - requestStartedAt, { usedSkills: usedSkillIds })
    throw Object.assign(new Error(message), {
      aiRunMeta: buildRunMeta(
        task.task,
        projectId,
        String(task.context.chapterId ?? '').trim() || undefined,
        settings,
        'error',
        startedAt,
        finishedAt,
        totalUsage,
        knowledgeContext?.usedKnowledge ?? [],
        usedSkillIds,
        false,
        '',
        message,
        clientKey
      )
    })
  }
}

/**
 * 以流式方式执行 AI 任务，通过 handlers 回调逐步返回生成内容。
 * 仅支持 chapter-assistant 和 chapter-first-draft 两种任务。
 * @param task - AI 任务载荷
 * @param handlers - 流式输出回调（onChunk / onDone）
 * @param signal - 中止信号
 * @param knowledgeContext - 可选的知识检索上下文
 * @returns 任务执行结果与运行元数据
 */
export async function streamAiTask(
  task: AiTaskPayload,
  handlers: AiStreamHandlers,
  signal: AbortSignal,
  knowledgeContext?: AiTaskKnowledgeContext
): Promise<AiTaskResponse> {
  if (
    task.task !== 'chapter-assistant'
    && task.task !== 'global-assistant'
    && task.task !== 'chapter-first-draft'
    && task.task !== 'chapter-memo'
    && task.task !== 'chapter-audit'
    && task.task !== 'chapter-repair'
    && task.task !== 'chapter-humanize'
    && task.task !== 'chapter-session-note'
  ) {
    throw new Error('当前流式输出仅支持章节创作助理、章节初稿、章节备忘、章节审计和章节修复。')
  }

  const settings = normalizeSettings(task.settings)
  validateSettings(settings)
  const startedAt = new Date().toISOString()
  const clientKey = task.clientKey

  const taskHandler = getTaskHandler(task.task)
  const { projectId, skills, usedSkillIds } = await resolveTaskSkills(task)
  logSelection(task.task, skills, knowledgeContext?.usedKnowledge ?? [])
  await enrichTaskContextForGeneration(task, settings)

  const input = buildPromptInput(task, skills, knowledgeContext)
  const prompt = taskHandler.buildPrompt(input)
  const maxTokens = shouldOmitMaxTokens(task.task)
    ? undefined
    : applyReasoningSafeFloor(taskHandler.resolveMaxTokens?.(input) ?? resolveMaxTokens(task))
  const structuredSchema = taskHandler.outputType === 'json' ? getStructuredTaskSchema(taskHandler.name) : undefined

  if (taskHandler.outputType === 'json' && !structuredSchema) {
    throw new Error(`任务 ${taskHandler.name} 缺少结构化输出 schema。`)
  }

  logPrompt('STREAM', settings, prompt, task.task, usedSkillIds)
  const requestStartedAt = Date.now()
  let totalUsage: AiRunUsage | undefined

  try {
    let generation = structuredSchema
      ? await aiStreamObjectWithUsage(settings, prompt, handlers, signal, structuredSchema, maxTokens)
      : await aiStreamTextWithUsage(settings, prompt, handlers, signal, maxTokens)
    totalUsage = addAiRunUsage(totalUsage, generation.usage)
    let rawText = generation.text
    logResponse('STREAM', settings, task.task, rawText, Date.now() - requestStartedAt, { usedSkills: usedSkillIds })
    let result: AiTaskResult
    let normalizeFailed = false
    try {
      result = taskHandler.normalize(rawText, task.context)
    } catch {
      result = {} as AiTaskResult
      normalizeFailed = true
    }
    let repairTriggered = false

    if (taskHandler.outputType === 'json' && (normalizeFailed || !taskHandler.validate(result))) {
      const validationErrors = (!normalizeFailed && taskHandler.describeValidationErrors)
        ? taskHandler.describeValidationErrors(result)
        : ['JSON 解析失败或结构不完整']
      const repairPromptPair = buildRepairPrompt(prompt.system, prompt.user, rawText, validationErrors)
      logPrompt('STREAM_REPAIR', settings, repairPromptPair, task.task, usedSkillIds)
      const repairStartedAt = Date.now()
      generation = await aiGenerateTextWithUsage(
        settings,
        repairPromptPair,
        maxTokens,
        signal,
        structuredSchema ? { schema: structuredSchema } : undefined
      )
      totalUsage = addAiRunUsage(totalUsage, generation.usage)
      rawText = generation.text
      logResponse('STREAM_REPAIR', settings, task.task, rawText, Date.now() - repairStartedAt, { usedSkills: usedSkillIds })
      result = taskHandler.normalize(rawText, task.context)
      repairTriggered = true

      if (!taskHandler.validate(result)) {
        throw new Error('AI 返回的结构化结果不完整，请稍后重试或调整提示词。')
      }
    }
    const finishedAt = new Date().toISOString()
    const status = signal.aborted ? 'canceled' : 'success'

    // 流式生成完成后也触发异步后处理
    if (task.task === 'chapter-first-draft' && projectId && !signal.aborted) {
      const finalContent = (result as { content?: string }).content ?? ''
      const chapterId = String(task.context.chapterId ?? '').trim()
      const chIdx = Number(task.context.chapterIndex ?? task.context.chapterSortOrder ?? 0)
      if (finalContent.length > 50) {
        schedulePostGenerationPipeline(settings, projectId, chIdx, chapterId, finalContent, task.context)
      }
    }

    return {
      result,
      meta: buildRunMeta(
        task.task,
        projectId,
        String(task.context.chapterId ?? '').trim() || undefined,
        settings,
        status,
        startedAt,
        finishedAt,
        totalUsage,
        knowledgeContext?.usedKnowledge ?? [],
        usedSkillIds,
        repairTriggered,
        buildResponsePreview(result),
        '',
        clientKey
      )
    }
  } catch (error) {
    const finishedAt = new Date().toISOString()
    const status = signal.aborted ? 'canceled' : 'error'
    const message = signal.aborted ? '' : formatAiErrorMessage(error, 'AI 流式调用失败')
    if (!signal.aborted) {
      logError('STREAM', settings, task.task, error, Date.now() - requestStartedAt, { usedSkills: usedSkillIds })
    }
    throw Object.assign(new Error(message || 'AI 流式调用失败'), {
      aiRunMeta: buildRunMeta(
        task.task,
        projectId,
        String(task.context.chapterId ?? '').trim() || undefined,
        settings,
        status,
        startedAt,
        finishedAt,
        totalUsage,
        knowledgeContext?.usedKnowledge ?? [],
        usedSkillIds,
        false,
        '',
        message,
        clientKey
      )
    })
  }
}

/**
 * 测试 AI 连接是否可用，发送一条简单探测提示并验证返回
 * @param rawSettings - 原始应用设置
 * @returns 成功时返回当前 provider 和 model 名称
 */
export async function testAiConnection(rawSettings: AppSettings): Promise<{ provider: string; model: string }> {
  const settings = normalizeSettings(rawSettings)
  validateSettings(settings)
  const probePrompt = {
    system: 'You are a connectivity probe. Reply with CONNECTED only.',
    user: 'Return CONNECTED'
  }
  logPrompt('TEST', settings, probePrompt, 'test-connection')
  const text = await aiGenerateText(settings, probePrompt)
  if (!text.trim()) {
    throw new Error('模型连接成功，但没有返回可读内容。')
  }
  return { provider: settings.provider, model: settings.model }
}

let chapterWarningsEmitter: ((payload: ChapterStateWarningsPayload) => void) | null = null
let chapterPostGenerationIssuesEmitter: ((payload: ChapterPostGenerationIssuesPayload) => void) | null = null
let chapterPostGenerationTaskEmitter: ((payload: ChapterPostGenerationTaskPayload) => void) | null = null

/**
 * IPC 层注入一个广播回调：章节轻检发现违规时，把告警推到前端。
 * 不注入时默默丢弃（只保留日志），避免测试/无 BrowserWindow 环境报错。
 */
export function setChapterWarningsEmitter(emit: (payload: ChapterStateWarningsPayload) => void): void {
  chapterWarningsEmitter = emit
}

export function setChapterPostGenerationIssuesEmitter(emit: (payload: ChapterPostGenerationIssuesPayload) => void): void {
  chapterPostGenerationIssuesEmitter = emit
}

export function setChapterPostGenerationTaskEmitter(emit: (payload: ChapterPostGenerationTaskPayload) => void): void {
  chapterPostGenerationTaskEmitter = emit
}

function buildIssueDetail(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error ?? '').trim()
  return message || undefined
}

function emitPostGenerationIssues(
  projectId: string,
  chapterId: string,
  chapterIndex: number,
  generatedAt: string,
  issues: ChapterPostGenerationIssuesPayload['issues']
): void {
  if (!chapterPostGenerationIssuesEmitter || !chapterId) {
    return
  }

  chapterPostGenerationIssuesEmitter({
    projectId,
    chapterId,
    chapterIndex,
    generatedAt,
    issues
  })
}

function extractInvolvedCharacterIds(context: Record<string, unknown>): string[] {
  const ids: string[] = []
  const characters = context.characters
  if (!Array.isArray(characters)) {
    return ids
  }

  for (const char of characters) {
    if (char && typeof char === 'object' && 'id' in char) {
      ids.push(String((char as { id: string }).id))
    }
  }

  return ids
}

/** 章节初稿生成后的异步后处理管线：提取状态变更 → 轻量审计 → 写入状态库 → 建立向量索引 */
function schedulePostGenerationPipeline(
  settings: AppSettings,
  projectId: string,
  chapterIndex: number,
  chapterId: string,
  chapterContent: string,
  context: Record<string, unknown>
): void {
  const key = `${projectId}:${chapterId || chapterIndex}`
  const fingerprint = createHash('sha256').update(chapterContent).digest('hex')
  const taskKey = `chapter-post-process:${key}`
  const runId = randomUUID()
  const chapterTitle = String(context.chapterTitle ?? '').trim() || `第 ${chapterIndex + 1} 章`
  void postGenerationTasks.runLatest(
    key,
    fingerprint,
    async (signal) => {
      const startedAt = Date.now()
      if (signal.aborted) return
      if (chapterId) {
        try {
          const db = await ensureWorkspaceDb()
          if (signal.aborted) return
          beginChapterProcessing(db, {
            projectId,
            chapterId,
            chapterIndex,
            contentHash: fingerprint,
            startedAt: new Date(startedAt).toISOString()
          })
        } catch (error) {
          if (signal.aborted) return
          logError('POST_GENERATION_STATE_BEGIN', settings, 'chapter-first-draft', error, 0)
        }
      }
      if (signal.aborted) return
      chapterPostGenerationTaskEmitter?.({
        taskKey,
        runId,
        projectId,
        chapterId,
        chapterIndex,
        chapterTitle,
        stage: 'running',
        startedAt
      })
      try {
        const pipelineResult = await runPostGenerationPipeline(
          settings,
          projectId,
          chapterIndex,
          chapterId,
          chapterContent,
          context,
          signal
        )
        const failedIssue = pipelineResult.issues.find((issue) => issue.severity === 'error')
        const status = signal.aborted ? 'canceled' : failedIssue ? 'error' : 'done'
        const finishedAt = Date.now()
        if (chapterId) {
          try {
            const db = await ensureWorkspaceDb()
            finishChapterProcessing(db, {
              projectId,
              chapterId,
              contentHash: fingerprint,
              status,
              stateStatus: pipelineResult.stateStatus,
              indexStatus: pipelineResult.indexStatus,
              issues: pipelineResult.issues,
              finishedAt: new Date(finishedAt).toISOString()
            })
          } catch (error) {
            logError('POST_GENERATION_STATE_FINISH', settings, 'chapter-first-draft', error, 0)
          }
        }
        chapterPostGenerationTaskEmitter?.({
          taskKey,
          runId,
          projectId,
          chapterId,
          chapterIndex,
          chapterTitle,
          stage: status,
          startedAt,
          finishedAt,
          ...(failedIssue ? { error: failedIssue.message } : {})
        })
      } catch (error) {
        const finishedAt = Date.now()
        if (chapterId) {
          try {
            const db = await ensureWorkspaceDb()
            finishChapterProcessing(db, {
              projectId,
              chapterId,
              contentHash: fingerprint,
              status: signal.aborted ? 'canceled' : 'error',
              stateStatus: 'error',
              indexStatus: 'pending',
              issues: signal.aborted ? [] : [{
                stage: 'pipeline',
                severity: 'error',
                message: '章节后处理执行失败。',
                detail: buildIssueDetail(error)
              }],
              finishedAt: new Date(finishedAt).toISOString()
            })
          } catch (persistError) {
            logError('POST_GENERATION_STATE_FINISH', settings, 'chapter-first-draft', persistError, 0)
          }
        }
        chapterPostGenerationTaskEmitter?.({
          taskKey,
          runId,
          projectId,
          chapterId,
          chapterIndex,
          chapterTitle,
          stage: signal.aborted ? 'canceled' : 'error',
          startedAt,
          finishedAt,
          ...(signal.aborted ? {} : { error: buildIssueDetail(error) })
        })
      }
    }
  ).catch((error) => {
    logError('POST_GENERATION_SCHEDULE', settings, 'chapter-first-draft', error, 0)
  })
}

async function runPostGenerationPipeline(
  settings: AppSettings,
  projectId: string,
  chapterIndex: number,
  chapterId: string,
  chapterContent: string,
  context: Record<string, unknown>,
  signal: AbortSignal
): Promise<PostGenerationPipelineResult> {
  const generatedAt = new Date().toISOString()
  const issues: ChapterPostGenerationIssuesPayload['issues'] = []
  let stateStatus: ChapterProcessingStageStatus = 'pending'
  let indexStatus: ChapterProcessingStageStatus = chapterId ? 'pending' : 'skipped'

  try {
    const db = await ensureWorkspaceDb()

    // P4.2-2：草稿期是否结算由 SETTLE_ON_DRAFT 决定；默认关闭（仅向量索引，结算交给定稿同步）。
    if (SETTLE_ON_DRAFT) {
    const involvedCharIds = extractInvolvedCharacterIds(context)
    const preState = buildStoryStateContext(db, projectId, involvedCharIds)

    // 章号权威化：渲染层任务 context 长期不含 chapterIndex，按章节顺序解析真实 0 基章号，
    // 保证 settlement_runs/snapshots 的 chapter_index 与正文顺序一致（P3.0）。
    let effectiveChapterIndex = chapterIndex
    if (chapterId) {
      try {
        effectiveChapterIndex = resolveChapterOrdinal(db, projectId, chapterId)
      } catch {
        // 解析失败时保持入参兜底
      }
    }

    // supersede 基线：记录结算开始前的最新记录，防止本结算（草稿期）覆盖期间先完成的定稿同步（P4）。
    const settleBaseline = chapterId
      ? latestSettlementCreatedAt(db, projectId, chapterId, effectiveChapterIndex)
      : ''

    const deltaResult = await extractStateDeltaViaLLMWithDiagnostics(
      settings,
      chapterContent,
      preState,
      signal
    )
    signal.throwIfAborted()
    if (deltaResult.issue) {
      issues.push(deltaResult.issue)
      stateStatus = 'warning'
    }

    // 结算闭环：Validator(L0 规则 + L1 LLM 对账) → Arbiter 裁决 →
    // 通过则快照+落账+记账；失败则自动重观察一次，仍失败则拒绝落盘（正文保留）。
    const outcome = await runChapterSettlement(db, {
      projectId,
      chapterId,
      chapterIndex: effectiveChapterIndex,
      content: chapterContent,
      preState,
      delta: deltaResult.delta,
      policy: { enableLLMReconcile: true },
      supersedeBaselineCreatedAt: settleBaseline || undefined,
      observe: async (attempt, feedback) => {
        const rerun = await extractStateDeltaViaLLMWithDiagnostics(
          settings,
          chapterContent,
          preState,
          signal,
          feedback
        )
        signal.throwIfAborted()
        if (rerun.issue) {
          issues.push(rerun.issue)
        }
        return { delta: rerun.delta }
      },
      reconcile: async (attempt, delta, feedback) => {
        if (!delta) return []
        const result = await reconcileDeltaViaLLMWithDiagnostics(
          settings,
          chapterContent,
          preState,
          delta,
          signal,
          feedback
        )
        signal.throwIfAborted()
        if (result.issue) {
          issues.push(result.issue)
        }
        return result.issues
      }
    })
    signal.throwIfAborted()

    // 保留原有 light-check 前台告警（含 warning 级），用于渲染层展示。
    if (deltaResult.delta) {
      const checkResult = runLightCheck(chapterContent, preState, deltaResult.delta)
      if (!checkResult.passed) {
        logResponse('LIGHT_CHECK', settings, 'chapter-first-draft',
          checkResult.violations.map((v) => `[${v.severity}] ${v.message}`).join('\n'), 0, {})
        if (chapterWarningsEmitter && chapterId) {
          chapterWarningsEmitter({
            projectId,
            chapterId,
            chapterIndex,
            generatedAt,
            violations: checkResult.violations
          })
        }
      }
    }

    if (outcome.applied) {
      if (stateStatus === 'pending') stateStatus = 'done'
    } else if (outcome.status === 'skipped') {
      if (stateStatus === 'pending') stateStatus = 'skipped'
    } else {
      // rejected / error：拒绝落盘或落账异常，正文保留，状态未写入，可修复后重试结算。
      stateStatus = 'error'
      const detail = outcome.issues.map((i) => `[${i.category}] ${i.message}`).join('\n')
      issues.push({
        stage: 'settlement',
        severity: 'error',
        message: '本章正文已生成，但世界状态结算未通过，未写入状态库（正文保留，可修复后手动重试结算）。',
        detail: detail || outcome.reason
      })
    }
    } else {
      // 草稿期不做状态结算：状态写入交给「定稿即结算」settlement:sync（幂等、仅最新章节）
      stateStatus = 'skipped'
    }

    if (chapterId) {
      try {
        const indexResult = await indexChapterSegments(
          settings,
          projectId,
          chapterIndex,
          chapterContent,
          chapterId,
          signal
        )
        indexStatus = indexResult === 'indexed' ? 'done' : 'skipped'
      } catch (error) {
        signal.throwIfAborted()
        indexStatus = 'warning'
        logError('POST_GENERATION_INDEX', settings, 'chapter-first-draft', error, 0)
        issues.push({
          stage: 'vector-index',
          severity: 'warning',
          message: '本章正文已生成，但语义索引更新失败，相关片段可能暂时检索不到。',
          detail: buildIssueDetail(error)
        })
      }
    }
  } catch (error) {
    if (signal.aborted) return { issues, stateStatus, indexStatus }
    if (stateStatus === 'pending') stateStatus = 'error'
    logError('POST_GENERATION_PIPELINE', settings, 'chapter-first-draft', error, 0)
    issues.push({
      stage: 'pipeline',
      severity: 'error',
      message: '本章正文已生成，但后处理流水线执行失败，世界状态和语义索引可能没有更新。',
      detail: buildIssueDetail(error)
    })
  }

  if (signal.aborted) return { issues, stateStatus, indexStatus }
  emitPostGenerationIssues(projectId, chapterId, chapterIndex, generatedAt, issues)
  return { issues, stateStatus, indexStatus }
}

/**
 * 调用 LLM 从章节正文中提取状态变更增量（角色、关系、伏笔、时间线）
 * @param settings - 应用设置
 * @param chapterContent - 章节正文内容
 * @param preState - 生成前的世界状态快照
 * @returns 提取到的状态变更增量，失败时返回 null
 */
export async function extractStateDeltaViaLLM(
  settings: AppSettings,
  chapterContent: string,
  preState: ReturnType<typeof buildStoryStateContext>
): Promise<StateDelta | null> {
  const result = await extractStateDeltaViaLLMWithDiagnostics(settings, chapterContent, preState)
  return result.delta
}

export async function extractStateDeltaViaLLMWithDiagnostics(
  settings: AppSettings,
  chapterContent: string,
  preState: ReturnType<typeof buildStoryStateContext>,
  signal?: AbortSignal,
  feedback?: string
): Promise<{
  delta: StateDelta | null
  rawText?: string
  usage?: AiRunUsage
  issue?: ChapterPostGenerationIssuesPayload['issues'][number]
}> {
  const stateSnapshot = formatStoryStateForPrompt(preState)
  const prompt = buildObserverPrompt({ stateSnapshot, chapterContent, feedback })

  try {
    const generation = await aiGenerateTextWithUsage(settings, prompt, 1500, signal, { disableReasoning: true })
    const raw = generation.text
    const parsed = extractJsonObject(raw)
    const delta = normalizeStateDelta(parsed)
    return { delta: hasStateDeltaContent(delta) ? delta : null, rawText: raw, usage: generation.usage }
  } catch (error) {
    signal?.throwIfAborted()
    logError('STATE_DELTA_EXTRACT', settings, 'chapter-first-draft', error, 0)
    return {
      delta: null,
      issue: {
        stage: 'state-delta',
        severity: 'warning',
        message: '本章正文已生成，但世界状态增量提取失败，角色状态和伏笔进度可能未同步。',
        detail: buildIssueDetail(error)
      }
    }
  }
}

/**
 * L1(LLM) 跨章一致性对账 —— 确定性 L0 抓不到的语义矛盾生产者。
 * 输入：结算前世界状态 + 本章正文 + Observer 增量(JSON) + 可选上一轮 feedback。
 * 输出：error/warning/hint 级问题，交给 Arbiter 裁决（error → 拒绝/自动重观察）。
 * 失败时返回空 issues 并附 issue 告警（不阻断结算，仅降级到 L0）。
 */
export async function reconcileDeltaViaLLMWithDiagnostics(
  settings: AppSettings,
  chapterContent: string,
  preState: ReturnType<typeof buildStoryStateContext>,
  delta: StateDelta | null,
  signal?: AbortSignal,
  feedback?: string
): Promise<{
  issues: SettlementIssue[]
  issue?: ChapterPostGenerationIssuesPayload['issues'][number]
}> {
  if (!delta) return { issues: [] }
  const stateSnapshot = formatStoryStateForPrompt(preState)
  const deltaJson = JSON.stringify(delta)
  const prompt = buildReconcilePrompt({ stateSnapshot, chapterContent, deltaJson, feedback })

  try {
    const generation = await aiGenerateTextWithUsage(settings, prompt, 1200, signal, { disableReasoning: true })
    const parsed = extractJsonObject(generation.text)
    return { issues: normalizeReconcileIssues(parsed) }
  } catch (error) {
    signal?.throwIfAborted()
    logError('SETTLEMENT_RECONCILE', settings, 'chapter-first-draft', error, 0)
    return {
      issues: [],
      issue: {
        stage: 'settlement',
        severity: 'warning',
        message: 'L1 跨章一致性对账失败（已跳过对账，仅按确定性规则结算）。',
        detail: buildIssueDetail(error)
      }
    }
  }
}
