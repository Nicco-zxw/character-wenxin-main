import { BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import type { AiTaskPayload, AppSettings, ChapterPostGenerationIssuesPayload, ChapterPostGenerationTaskPayload, ChapterStateWarningsPayload } from './shared-types'
import { runAiTask, streamAiTask, testAiConnection, fetchModels, fetchImageModels, generateImage } from './runtime'
import { runStreamingAgentTask } from './agent/streaming-orchestrator'
import { isToolUseNotSupportedError } from './provider'
import { setChapterPostGenerationIssuesEmitter, setChapterPostGenerationTaskEmitter, setChapterWarningsEmitter } from './runtime/orchestrator'
import { retrieveKnowledgeContext } from './knowledge-retrieval'
import { buildRunMeta } from './runtime/run-meta'
import { backfillProjectStateFromChapters, getProjectBackfillChapterStatuses } from './state-backfill'
import type { BackfillTaskSnapshot } from './state-backfill'
import type { BackfillSelection } from './state-backfill'
import { BackfillTaskPauseController } from './state-backfill-task-controller'
import { buildStoryStateContext } from '../story-state-store'
import { ensureWorkspaceDb } from '../workspace-store'
import {
  clearSettlementSnapshots,
  hasSettledContent,
  isLatestChapter,
  markSettlementRolledBack,
  readSettlementRun,
  resolveChapterOrdinal,
  rollbackSettlementState,
  settlementContentHash
} from './settlement/settlement-store'
import { runChapterSettlement } from './settlement'
import { extractStateDeltaViaLLMWithDiagnostics, reconcileDeltaViaLLMWithDiagnostics } from './runtime/orchestrator'
import {
  adoptForecastBranchWithMemo,
  createForecastRecord,
  expireForecastsOlderThan,
  FORECAST_ADOPT_ON,
  getForecast,
  listForecasts,
  selectForecastBranch
} from './forecast/store'
import { buildAdoptionMemoFromBranch, formatAdoptionMemoText } from './forecast/adoption'
import { generateForecastBranchesViaLLM } from './forecast/agent'
import { runReflectiveOutlineBatch } from './reflection/outline-reflector'
import { runReflectiveRewrite } from './reflection/rewrite-reflector'
import { readProjectAgentSettings, writeProjectAgentSettings } from './agent-profile-store'
import { runSpiralBootstrap } from './spiral'
import type { SpiralBootstrapInput } from './spiral'
import { formatAiErrorMessage } from './error-message'

/**
 * AI IPC 模块的外部依赖注入接口。
 * 由主进程初始化时提供，用于获取工作区快照和广播事件。
 */
type AiIpcDeps = {
  /** 获取最新工作区快照（知识文档、AI 运行记录等） */
  getLatestWorkspaceSnapshot: () => { knowledgeDocuments?: unknown[]; workspaces?: Record<string, { aiRuns?: unknown[] }> } | null
  /** 向 renderer 广播 AI 运行事件 */
  emitAiRunEvent: (payload: { projectId: string; meta: Record<string, unknown> }) => void
  /** 向 renderer 广播章节状态告警事件 */
  emitChapterStateWarnings: (payload: ChapterStateWarningsPayload) => void
  /** 向 renderer 广播章节生成后处理问题事件 */
  emitChapterPostGenerationIssues: (payload: ChapterPostGenerationIssuesPayload) => void
  /** 向 renderer 广播章节生成后处理任务生命周期 */
  emitChapterPostGenerationTask: (payload: ChapterPostGenerationTaskPayload) => void
}

/** 注入的外部依赖，registerAiIpcHandlers 调用时初始化 */
let deps: AiIpcDeps | null = null

/** 流式任务的 AbortController（按 streamId 索引） */
const activeAiStreams = new Map<string, AbortController>()

/**
 * 非流式任务的 AbortController（按 clientTaskId 索引）。
 * 前端 `runTrackedAiTask` 发起请求时带上 `clientTaskId`，
 * 超时或用户手动取消时通过 `characterarc:ai-cancel` 通道 abort。
 */
const activeAiTasks = new Map<string, AbortController>()
type BackfillTaskRecord = {
  controller: BackfillTaskPauseController
  snapshot: BackfillTaskSnapshot
}
const backfillTasks = new Map<string, BackfillTaskRecord>()

function isActiveBackfillTask(snapshot: BackfillTaskSnapshot): boolean {
  return snapshot.status === 'running' || snapshot.status === 'pausing' || snapshot.status === 'paused'
}

function broadcastBackfillTask(snapshot: BackfillTaskSnapshot): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('characterarc:ai-backfill-state-progress', snapshot)
    }
  }
}

function updateBackfillTask(
  record: BackfillTaskRecord,
  patch: Partial<BackfillTaskSnapshot>
): BackfillTaskSnapshot {
  record.snapshot = {
    ...record.snapshot,
    ...patch,
    updatedAt: new Date().toISOString()
  }
  broadcastBackfillTask(record.snapshot)
  return record.snapshot
}

/**
 * 注册所有 AI 相关的 IPC handler。
 * 包括非流式生成、流式生成、Agent 生成、连接测试、模型列表、图片生成、
 * 世界状态读取、章节版本读取、螺旋生成、状态补录等。
 *
 * @param injectedDeps - 外部依赖注入
 */
export function registerAiIpcHandlers(injectedDeps: AiIpcDeps): void {
  deps = injectedDeps
  setChapterWarningsEmitter((payload) => deps?.emitChapterStateWarnings(payload))
  setChapterPostGenerationIssuesEmitter((payload) => deps?.emitChapterPostGenerationIssues(payload))
  setChapterPostGenerationTaskEmitter((payload) => deps?.emitChapterPostGenerationTask(payload))

  // ── 非流式 AI 生成（支持 abort） ──
  ipcMain.handle('characterarc:ai-generate', async (_event, payload: AiTaskPayload) => {
    const clientTaskId = payload.clientTaskId || ''
    const controller = new AbortController()
    if (clientTaskId) {
      activeAiTasks.set(clientTaskId, controller)
    }

    const knowledgeContext = retrieveKnowledgeContext(payload, deps!.getLatestWorkspaceSnapshot() as Parameters<typeof retrieveKnowledgeContext>[1])
    try {
      if (controller.signal.aborted) {
        throw new Error('任务已被取消。')
      }

      const response = await runAiTask(payload, knowledgeContext, controller.signal)

      deps!.emitAiRunEvent({ projectId: response.meta.projectId ?? '', meta: { id: randomUUID(), ...response.meta } })
      return { success: true, result: response.result }
    } catch (error) {
      const aiRunMeta = error && typeof error === 'object' && 'aiRunMeta' in error
        ? (error as { aiRunMeta?: Record<string, unknown> }).aiRunMeta : undefined
      if (aiRunMeta) {
        deps!.emitAiRunEvent({ projectId: String((aiRunMeta as { projectId?: string }).projectId ?? ''), meta: { id: randomUUID(), ...aiRunMeta } })
      }
      return { success: false, error: formatAiErrorMessage(error, 'AI 调用失败') }
    } finally {
      if (clientTaskId) {
        activeAiTasks.delete(clientTaskId)
      }
    }
  })

  // ── 取消非流式任务 ──
  ipcMain.handle('characterarc:ai-cancel', async (_event, clientTaskId: unknown) => {
    const key = typeof clientTaskId === 'string' ? clientTaskId : ''
    const controller = activeAiTasks.get(key)
    if (!controller) return { success: false, error: '未找到对应的运行中任务' }
    controller.abort()
    return { success: true }
  })

  // ── 流式 AI 生成（支持自动升级到 Agent 路径） ──
  ipcMain.handle('characterarc:ai-stream-start', async (event, payload: AiTaskPayload) => {
    try {
      const streamId = `stream-${randomUUID()}`
      const controller = new AbortController()
      const knowledgeContext = retrieveKnowledgeContext(payload, deps!.getLatestWorkspaceSnapshot() as Parameters<typeof retrieveKnowledgeContext>[1])
      activeAiStreams.set(streamId, controller)

      const shouldTryAgent = payload.task === 'chapter-first-draft' || payload.task === 'global-assistant'

      let streamedContent = ''
      void (async () => {
        try {
          if (shouldTryAgent) {
            try {
              const result = await runStreamingAgentTask(
                payload,
                {
                  onTextDelta: (delta) => {
                    streamedContent += delta
                    if (!event.sender.isDestroyed()) {
                      event.sender.send('characterarc:ai-stream-event', { streamId, type: 'chunk', delta, charCount: streamedContent.length })
                    }
                  },
                  onReasoningDelta: (delta) => {
                    if (!event.sender.isDestroyed()) {
                      event.sender.send('characterarc:ai-stream-event', { streamId, type: 'reasoning', delta })
                    }
                  },
                  onToolUseStart: (toolUseId, toolName, args) => {
                    if (!event.sender.isDestroyed()) {
                      event.sender.send('characterarc:ai-stream-event', { streamId, type: 'tool_use_start', toolUseId, toolName, args })
                    }
                  },
                  onToolResult: (toolUseId, toolName, content, isError, durationMs) => {
                    if (!event.sender.isDestroyed()) {
                      event.sender.send('characterarc:ai-stream-event', { streamId, type: 'tool_result', toolUseId, toolName, content, isError, durationMs })
                    }
                  },
                  onAgentStatus: (message, iteration, maxIterations) => {
                    if (!event.sender.isDestroyed()) {
                      event.sender.send('characterarc:ai-stream-event', { streamId, type: 'agent_status', message, iteration, maxIterations })
                    }
                  },
                  onEditApplied: (chapterId, editType, preview, versionId) => {
                    if (!event.sender.isDestroyed()) {
                      event.sender.send('characterarc:ai-stream-event', { streamId, type: 'edit_applied', chapterId, editType, preview, versionId })
                    }
                  },
                  onEditProposed: (chapterId, proposalId, editType, preview, oldContent, newContent) => {
                    if (!event.sender.isDestroyed()) {
                      event.sender.send('characterarc:ai-stream-event', { streamId, type: 'edit_proposed', chapterId, proposalId, editType, preview, oldContent, newContent })
                    }
                  }
                },
                controller.signal,
                knowledgeContext
              )
              if (result.meta.projectId) {
                deps!.emitAiRunEvent({ projectId: result.meta.projectId, meta: { id: randomUUID(), ...result.meta } })
              }
              if (!event.sender.isDestroyed()) {
                event.sender.send('characterarc:ai-stream-event', {
                  streamId,
                  type: 'done',
                  content: (result.result as { content?: string }).content ?? streamedContent,
                  result: result.result
                })
              }
              return
            } catch (agentError) {
              if (!isToolUseNotSupportedError(agentError)) throw agentError
              streamedContent = ''
            }
          }

          const result = await streamAiTask(
            payload,
            {
              onTextDelta: (delta: string) => {
                streamedContent += delta
                if (!event.sender.isDestroyed()) {
                  event.sender.send('characterarc:ai-stream-event', { streamId, type: 'chunk', delta, charCount: streamedContent.length })
                }
              },
              onReasoningDelta: (delta: string) => {
                if (!event.sender.isDestroyed()) {
                  event.sender.send('characterarc:ai-stream-event', { streamId, type: 'reasoning', delta })
                }
              }
            },
            controller.signal,
            knowledgeContext
          )
          if (result.meta.projectId) {
            deps!.emitAiRunEvent({ projectId: result.meta.projectId, meta: { id: randomUUID(), ...result.meta } })
          }
          if (!event.sender.isDestroyed()) {
            event.sender.send('characterarc:ai-stream-event', {
              streamId,
              type: 'done',
              content: (result.result as { content?: string }).content ?? streamedContent,
              result: result.result
            })
          }
        } catch (error) {
          const aiRunMeta = error && typeof error === 'object' && 'aiRunMeta' in error
            ? (error as { aiRunMeta?: Record<string, unknown> }).aiRunMeta : undefined
          if (aiRunMeta && (aiRunMeta as { projectId?: string }).projectId) {
            deps!.emitAiRunEvent({ projectId: String((aiRunMeta as { projectId?: string }).projectId), meta: { id: randomUUID(), ...aiRunMeta } })
          }
          if (!event.sender.isDestroyed()) {
            event.sender.send('characterarc:ai-stream-event', controller.signal.aborted
              ? { streamId, type: 'canceled', content: streamedContent }
              : { streamId, type: 'error', error: formatAiErrorMessage(error, 'AI 流式调用失败') }
            )
          }
        } finally {
          activeAiStreams.delete(streamId)
        }
      })()

      return { success: true, result: { streamId } }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, 'AI 流式调用启动失败') }
    }
  })

  // ── 停止流式任务 ──
  ipcMain.handle('characterarc:ai-stream-stop', async (event, streamId: unknown) => {
    const key = typeof streamId === 'string' ? streamId : ''
    const controller = activeAiStreams.get(key)
    if (!controller) return { success: false, error: '当前没有可停止的生成任务' }
    controller.abort()

    // 发送 canceled 事件给前端，确保用户看到停止反馈
    if (!event.sender.isDestroyed()) {
      event.sender.send('characterarc:ai-stream-event', { streamId: key, type: 'canceled', content: '' })
    }

    return { success: true }
  })

  // ── Agent 流式生成（带工具调用） ──
  ipcMain.handle('characterarc:ai-agent-stream-start', async (event, payload: AiTaskPayload) => {
    try {
      const streamId = `agent-${randomUUID()}`
      const controller = new AbortController()
      const knowledgeContext = retrieveKnowledgeContext(payload, deps!.getLatestWorkspaceSnapshot() as Parameters<typeof retrieveKnowledgeContext>[1])
      activeAiStreams.set(streamId, controller)

      let streamedContent = ''
      void (async () => {
        try {
          try {
            const result = await runStreamingAgentTask(
              payload,
              {
                onTextDelta: (delta) => {
                  streamedContent += delta
                  if (!event.sender.isDestroyed()) {
                    event.sender.send('characterarc:ai-stream-event', { streamId, type: 'chunk', delta, charCount: streamedContent.length })
                  }
                },
                onReasoningDelta: (delta) => {
                  if (!event.sender.isDestroyed()) {
                    event.sender.send('characterarc:ai-stream-event', { streamId, type: 'reasoning', delta })
                  }
                },
                onToolUseStart: (toolUseId, toolName, args) => {
                  if (!event.sender.isDestroyed()) {
                    event.sender.send('characterarc:ai-stream-event', { streamId, type: 'tool_use_start', toolUseId, toolName, args })
                  }
                },
                onToolResult: (toolUseId, toolName, content, isError, durationMs) => {
                  if (!event.sender.isDestroyed()) {
                    event.sender.send('characterarc:ai-stream-event', { streamId, type: 'tool_result', toolUseId, toolName, content, isError, durationMs })
                  }
                },
                onAgentStatus: (message, iteration, maxIterations) => {
                  if (!event.sender.isDestroyed()) {
                    event.sender.send('characterarc:ai-stream-event', { streamId, type: 'agent_status', message, iteration, maxIterations })
                  }
                },
                onEditApplied: (chapterId, editType, preview, versionId) => {
                  if (!event.sender.isDestroyed()) {
                    event.sender.send('characterarc:ai-stream-event', { streamId, type: 'edit_applied', chapterId, editType, preview, versionId })
                  }
                },
                onEditProposed: (chapterId, proposalId, editType, preview, oldContent, newContent) => {
                  if (!event.sender.isDestroyed()) {
                    event.sender.send('characterarc:ai-stream-event', { streamId, type: 'edit_proposed', chapterId, proposalId, editType, preview, oldContent, newContent })
                  }
                }
              },
              controller.signal,
              knowledgeContext
            )
            if (result.meta.projectId) {
              deps!.emitAiRunEvent({ projectId: result.meta.projectId, meta: { id: randomUUID(), ...result.meta } })
            }
            if (!event.sender.isDestroyed()) {
              event.sender.send('characterarc:ai-stream-event', { streamId, type: 'done', content: streamedContent, result: result.result })
            }
            return
          } catch (agentError) {
            if (!isToolUseNotSupportedError(agentError)) throw agentError
            streamedContent = ''
          }

          const result = await streamAiTask(
            payload,
            {
              onTextDelta: (delta: string) => {
                streamedContent += delta
                if (!event.sender.isDestroyed()) {
                  event.sender.send('characterarc:ai-stream-event', { streamId, type: 'chunk', delta, charCount: streamedContent.length })
                }
              },
              onReasoningDelta: (delta: string) => {
                if (!event.sender.isDestroyed()) {
                  event.sender.send('characterarc:ai-stream-event', { streamId, type: 'reasoning', delta })
                }
              }
            },
            controller.signal,
            knowledgeContext
          )
          if (result.meta.projectId) {
            deps!.emitAiRunEvent({ projectId: result.meta.projectId, meta: { id: randomUUID(), ...result.meta } })
          }
          if (!event.sender.isDestroyed()) {
            event.sender.send('characterarc:ai-stream-event', {
              streamId,
              type: 'done',
              content: (result.result as { content?: string }).content ?? streamedContent,
              result: result.result
            })
          }
        } catch (error) {
          if (!event.sender.isDestroyed()) {
            event.sender.send('characterarc:ai-stream-event', controller.signal.aborted
              ? { streamId, type: 'canceled', content: streamedContent }
              : { streamId, type: 'error', error: formatAiErrorMessage(error, 'AI Agent 调用失败') }
            )
          }
        } finally {
          activeAiStreams.delete(streamId)
        }
      })()

      return { success: true, result: { streamId } }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, 'AI Agent 启动失败') }
    }
  })

  // ── 连接测试 ──
  ipcMain.handle('characterarc:ai-test-connection', async (_event, settings: unknown) => {
    try {
      const result = await testAiConnection(settings as AppSettings)
      return { success: true, result }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, 'AI 连接测试失败') }
    }
  })

  // ── 模型列表 ──
  ipcMain.handle('characterarc:ai-fetch-models', async (_event, settings: unknown) => {
    try {
      const result = await fetchModels(settings as AppSettings)
      return { success: true, result }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, '获取模型列表失败') }
    }
  })

  ipcMain.handle('characterarc:ai-fetch-image-models', async (_event, settings: unknown) => {
    try {
      const result = await fetchImageModels(settings as AppSettings)
      return { success: true, result }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, '获取图片模型列表失败') }
    }
  })

  // ── 图片生成 ──
  ipcMain.handle('characterarc:ai-generate-image', async (_event, payload: unknown) => {
    const request = payload as { settings?: AppSettings; prompt?: string; projectId?: string }
    const projectId = String(request?.projectId ?? '').trim()
    const settings = request?.settings as AppSettings
    const startedAt = new Date().toISOString()
    // 运行记录里展示图片模型（封面专用模型与文本模型分开配置）。
    const metaSettings = { ...settings, model: settings?.imageModel?.trim() || settings?.model } as AppSettings
    try {
      const prompt = String(request?.prompt ?? '').trim()
      if (!prompt) {
        throw new Error('图片生成提示词不能为空。')
      }
      const result = await generateImage(settings, prompt)

      if (projectId) {
        const meta = buildRunMeta(
          'cover-generate', projectId, undefined, metaSettings, 'success',
          startedAt, new Date().toISOString(),
          result.usage,
          [], [],
          false, result.revisedPrompt ?? '封面图片已生成', ''
        )
        deps!.emitAiRunEvent({ projectId, meta: { id: randomUUID(), ...meta } })
      }
      return { success: true, result }
    } catch (error) {
      const message = formatAiErrorMessage(error, '图片生成失败')
      if (projectId) {
        const meta = buildRunMeta(
          'cover-generate', projectId, undefined, metaSettings, 'error',
          startedAt, new Date().toISOString(),
          undefined,
          [], [],
          false, '', message
        )
        deps!.emitAiRunEvent({ projectId, meta: { id: randomUUID(), ...meta } })
      }
      return { success: false, error: message }
    }
  })

  // ── 读取当前项目的结构化世界状态（供前端状态面板展示） ──
  ipcMain.handle('characterarc:ai-read-story-state', async (_event, projectId: unknown) => {
    try {
      const id = String(projectId ?? '').trim()
      if (!id) throw new Error('缺少 projectId。')
      const db = await ensureWorkspaceDb()
      const context = buildStoryStateContext(db, id, [])
      return { success: true, result: context }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, '读取世界状态失败') }
    }
  })

  // ── 读取某章最近一次结算记录（供结算状态展示/手工干预） ──
  ipcMain.handle('characterarc:settlement:status', async (_event, payload: unknown) => {
    try {
      const req = payload as { projectId?: string; chapterId?: string; chapterIndex?: number }
      const projectId = String(req?.projectId ?? '').trim()
      if (!projectId) throw new Error('缺少 projectId。')
      const chapterId = String(req?.chapterId ?? '').trim()
      const chapterIndex = Number(req?.chapterIndex ?? 0)
      const db = await ensureWorkspaceDb()
      const run = readSettlementRun(db, projectId, chapterId || undefined, Number.isFinite(chapterIndex) ? chapterIndex : 0)
      if (!run) return { success: true, result: null }
      return {
        success: true,
        result: {
          status: run.status,
          decision: run.decision,
          attempt: run.attempt,
          reason: run.reason,
          issues: run.issues,
          createdAt: run.createdAt
        }
      }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, '读取结算状态失败') }
    }
  })

  // ── 按章回滚状态结算（基于结算快照；建议仅对最新章节执行） ──
  ipcMain.handle('characterarc:settlement:rollback', async (_event, payload: unknown) => {
    try {
      const req = payload as { projectId?: string; chapterIndex?: number }
      const projectId = String(req?.projectId ?? '').trim()
      const chapterIndex = Number(req?.chapterIndex)
      if (!projectId || !Number.isFinite(chapterIndex)) throw new Error('缺少 projectId 或 chapterIndex。')
      const db = await ensureWorkspaceDb()
      const restored = rollbackSettlementState(db, projectId, chapterIndex)
      // 使该章同正文可再次结算：把已 settled 的记录标记为 rolled_back
      markSettlementRolledBack(db, projectId, chapterIndex)
      clearSettlementSnapshots(db, projectId, chapterIndex)
      return { success: true, restored }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, '回滚结算失败') }
    }
  })

  // ── 手工重试结算：对给定正文重新走 Observer(L0+L1) → Arbiter → 落账/拒绝 ──
  ipcMain.handle('characterarc:settlement:rerun', async (_event, payload: unknown) => {
    try {
      const req = payload as { projectId?: string; chapterId?: string; content?: string; settings?: unknown }
      const projectId = String(req?.projectId ?? '').trim()
      const chapterId = String(req?.chapterId ?? '').trim()
      const content = String(req?.content ?? '')
      if (!projectId || !chapterId || !content.trim()) throw new Error('缺少 projectId / chapterId / content。')
      const db = await ensureWorkspaceDb()
      const chapterIndex = resolveChapterOrdinal(db, projectId, chapterId)
      const preState = buildStoryStateContext(db, projectId, [])
      const settings = req.settings as AppSettings

      const deltaResult = await extractStateDeltaViaLLMWithDiagnostics(settings, content, preState)
      if (!deltaResult.delta) {
        return {
          success: false,
          error: deltaResult.issue?.message ?? '未从本章正文提取到状态变更，无法结算。'
        }
      }

      const outcome = await runChapterSettlement(db, {
        projectId,
        chapterId,
        chapterIndex,
        content,
        preState,
        delta: deltaResult.delta,
        runKind: 'rerun',
        policy: { enableLLMReconcile: true },
        // A1b：error 首轮自动重观察一次（feedback 带问题回炉），Observer 自愈后再裁决
        observe: async (attempt, feedback) => {
          const rerun = await extractStateDeltaViaLLMWithDiagnostics(settings, content, preState, undefined, feedback)
          return { delta: rerun.delta }
        },
        reconcile: async (attempt, delta, feedback) => {
          if (!delta) return []
          const result = await reconcileDeltaViaLLMWithDiagnostics(settings, content, preState, delta, undefined, feedback)
          return result.issues
        }
      })

      return {
        success: true,
        result: {
          status: outcome.status,
          decision: outcome.decision,
          applied: outcome.applied,
          reason: outcome.reason,
          issues: outcome.issues,
          chapterIndex
        }
      }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, '重试结算失败') }
    }
  })

  // ── 定稿同步结算（P4）：章节正文定稿后调用，作为权威结算；幂等、仅最新章节 ──
  // 语义：正文未变 → up-to-date；该章先前已落账且正文已变 → 先按快照回滚本章影响（恢复前 N 章状态）
  // → 再以最终正文重新 Observer+L1+Arbiter。尚未接入渲染层（P4.2 启用门禁）。
  ipcMain.handle('characterarc:settlement:sync', async (_event, payload: unknown) => {
    try {
      const req = payload as { projectId?: string; chapterId?: string; content?: string; settings?: unknown }
      const projectId = String(req?.projectId ?? '').trim()
      const chapterId = String(req?.chapterId ?? '').trim()
      const content = String(req?.content ?? '')
      if (!projectId || !chapterId || !content.trim()) throw new Error('缺少 projectId / chapterId / content。')
      const db = await ensureWorkspaceDb()
      const chapterIndex = resolveChapterOrdinal(db, projectId, chapterId)
      const contentHash = settlementContentHash(content)

      // 只允许对最新章节做自动定稿同步，避免污染其后章节状态
      if (!isLatestChapter(db, projectId, chapterIndex)) {
        return { success: true, action: 'deferred', reason: '非最新章节，请用编辑器「重试结算」。' }
      }

      // 幂等：该正文已结算（settled*）→ 无需重复
      if (hasSettledContent(db, projectId, chapterIndex, contentHash)) {
        return { success: true, action: 'up-to-date' }
      }

      // 该章先前已落账（正文不同）→ 先回滚本章自身影响，使结算前置状态回到“前 N 章”
      const latest = readSettlementRun(db, projectId, chapterId, chapterIndex)
      if (latest && (latest.status === 'settled' || latest.status === 'settled_with_warning')) {
        rollbackSettlementState(db, projectId, chapterIndex)
        markSettlementRolledBack(db, projectId, chapterIndex)
      }
      clearSettlementSnapshots(db, projectId, chapterIndex)

      const preState = buildStoryStateContext(db, projectId, [])
      const settings = req.settings as AppSettings
      const deltaResult = await extractStateDeltaViaLLMWithDiagnostics(settings, content, preState)
      if (!deltaResult.delta) {
        return {
          success: false,
          action: 'error',
          error: deltaResult.issue?.message ?? '未从定稿正文提取到状态变更，无法结算。'
        }
      }

      const outcome = await runChapterSettlement(db, {
        projectId,
        chapterId,
        chapterIndex,
        content,
        preState,
        delta: deltaResult.delta,
        runKind: 'sync',
        policy: { enableLLMReconcile: true },
        // A1b：error 首轮自动重观察一次（feedback 带问题回炉），Observer 自愈后再裁决
        observe: async (attempt, feedback) => {
          const rerun = await extractStateDeltaViaLLMWithDiagnostics(settings, content, preState, undefined, feedback)
          return { delta: rerun.delta }
        },
        reconcile: async (attempt, delta, feedback) => {
          if (!delta) return []
          const result = await reconcileDeltaViaLLMWithDiagnostics(settings, content, preState, delta, undefined, feedback)
          return result.issues
        }
      })

      // 定稿同步若有 error/warning，走既有 post-gen 事件链路，让编辑器结算标签/告警自动刷新
      if (deps?.emitChapterPostGenerationIssues) {
        const settleIssues = outcome.issues
          .filter((i) => i.severity !== 'hint')
          .map((i) => ({
            stage: 'settlement' as const,
            severity: i.severity === 'error' ? 'error' as const : 'warning' as const,
            message: i.message
          }))
        if (settleIssues.length > 0) {
          deps.emitChapterPostGenerationIssues({
            projectId,
            chapterId,
            chapterIndex,
            generatedAt: new Date().toISOString(),
            issues: settleIssues
          })
        }
      }

      return {
        success: true,
        action: 'settled',
        result: {
          status: outcome.status,
          decision: outcome.decision,
          applied: outcome.applied,
          reason: outcome.reason,
          issues: outcome.issues,
          chapterIndex
        }
      }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, '定稿同步结算失败') }
    }
  })

  // ── 剧情多线推演（P6.2，隔离：只写 narrative_forecasts，绝不碰正史/结算表） ──

  // 创建：基于当前章正文生成 2-5 条隔离候选未来；更早的 forecast 自动过期
  ipcMain.handle('characterarc:narrative-forecast:create', async (_event, payload: unknown) => {
    try {
      const req = payload as { projectId?: string; chapterId?: string; content?: string; branchCount?: number; settings?: unknown }
      const projectId = String(req?.projectId ?? '').trim()
      const content = String(req?.content ?? '')
      if (!projectId || !content.trim()) throw new Error('缺少 projectId / content。')
      const db = await ensureWorkspaceDb()
      const chapterId = String(req?.chapterId ?? '').trim()
      const chapterIndex = chapterId ? resolveChapterOrdinal(db, projectId, chapterId) : 0
      const preState = buildStoryStateContext(db, projectId, [])
      const settings = req.settings as AppSettings
      const { title, branches, summary } = await generateForecastBranchesViaLLM(
        settings,
        content,
        preState,
        Number(req?.branchCount ?? 3)
      )
      const created = createForecastRecord(db, {
        projectId,
        baseChapterIndex: chapterIndex,
        baseContentHash: settlementContentHash(content),
        title,
        branches,
        summary
      })
      // 新推演基于当前章 → 把正史推进前的旧 forecast 标记过期（不删除，可审计）
      expireForecastsOlderThan(db, projectId, chapterIndex)
      const record = getForecast(db, projectId, created.id)
      return { success: true, result: record }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, '剧情推演失败') }
    }
  })

  // 列出项目的全部 forecast（倒序，含已过期/已采用，供审计）
  ipcMain.handle('characterarc:narrative-forecast:list', async (_event, payload: unknown) => {
    try {
      const projectId = String((payload as { projectId?: string } | undefined)?.projectId ?? '').trim()
      if (!projectId) throw new Error('缺少 projectId。')
      const db = await ensureWorkspaceDb()
      return { success: true, result: listForecasts(db, projectId) }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, '读取推演列表失败') }
    }
  })

  // 读取单个 forecast
  ipcMain.handle('characterarc:narrative-forecast:get', async (_event, payload: unknown) => {
    try {
      const req = payload as { projectId?: string; id?: string }
      const projectId = String(req?.projectId ?? '').trim()
      const id = String(req?.id ?? '').trim()
      if (!projectId || !id) throw new Error('缺少 projectId / id。')
      const db = await ensureWorkspaceDb()
      const record = getForecast(db, projectId, id)
      if (!record) throw new Error('推演不存在')
      return { success: true, result: record }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, '读取推演失败') }
    }
  })

  // 采用某个分支：只更新 forecast 记录，不写正文/设定/状态（隔离承诺）
  ipcMain.handle('characterarc:narrative-forecast:select', async (_event, payload: unknown) => {
    try {
      const req = payload as { projectId?: string; id?: string; branchId?: string }
      const projectId = String(req?.projectId ?? '').trim()
      const id = String(req?.id ?? '').trim()
      const branchId = String(req?.branchId ?? '').trim()
      if (!projectId || !id || !branchId) throw new Error('缺少 projectId / id / branchId。')
      const db = await ensureWorkspaceDb()
      const res = selectForecastBranch(db, projectId, id, branchId)
      if (!res.ok) throw new Error(res.error ?? '采用分支失败')
      return { success: true, result: getForecast(db, projectId, id) }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, '采用分支失败') }
    }
  })

  // P8.5 采用分支并生成「下一章建议 memo」（只写 forecast 域，隔离承诺不变）
  ipcMain.handle('characterarc:narrative-forecast:adopt-memo', async (_event, payload: unknown) => {
    try {
      const req = payload as { projectId?: string; id?: string; branchId?: string }
      const projectId = String(req?.projectId ?? '').trim()
      const id = String(req?.id ?? '').trim()
      const branchId = String(req?.branchId ?? '').trim()
      if (!projectId || !id || !branchId) throw new Error('缺少 projectId / id / branchId。')
      const db = await ensureWorkspaceDb()
      const record = getForecast(db, projectId, id)
      if (!record) throw new Error('推演不存在')
      const branch = record.branches.find((b) => b.id === branchId)
      if (!branch) throw new Error('分支不存在')
      const memo = buildAdoptionMemoFromBranch(branch)
      const text = formatAdoptionMemoText(memo)
      if (!FORECAST_ADOPT_ON) {
        // 回退：仅返回建议 memo，不持久化（仍不写正史）
        return { success: true, result: { record, memo, text } }
      }
      const res = adoptForecastBranchWithMemo(db, projectId, id, branchId, memo)
      if (!res.ok) throw new Error(res.error ?? '采用分支失败')
      return { success: true, result: { record: res.record ?? record, memo, text } }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, '采用分支并生成 memo 失败') }
    }
  })

  // ── 反思式章纲生成（P6.3.2：outline-batch + 反思回路） ──
  ipcMain.handle('characterarc:reflective-outline:generate', async (_event, payload: unknown) => {
    try {
      const req = payload as { settings?: unknown; context?: Record<string, unknown>; maxIterations?: number; passScore?: number }
      if (!req?.context) throw new Error('缺少 context。')
      const result = await runReflectiveOutlineBatch({
        settings: req.settings as AppSettings,
        context: req.context,
        maxIterations: Number(req.maxIterations ?? 3),
        passScore: Number(req.passScore ?? 75)
      })
      return { success: true, result }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, '反思式章纲生成失败') }
    }
  })

  // ── 反思式局部改写（P8.3：自评重做；只返回文本，选区替换由渲染层作者在环确认） ──
  ipcMain.handle('characterarc:reflective-rewrite:run', async (_event, payload: unknown) => {
    try {
      const req = payload as { settings?: unknown; sourceText?: string; instruction?: string; maxIterations?: number; passScore?: number }
      const sourceText = String(req?.sourceText ?? '').trim()
      if (!sourceText) throw new Error('缺少 sourceText。')
      const result = await runReflectiveRewrite({
        settings: req.settings as AppSettings,
        sourceText,
        instruction: req.instruction,
        maxIterations: Number(req.maxIterations ?? 2),
        passScore: Number(req.passScore ?? 80)
      })
      return { success: true, result }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, '反思式改写失败') }
    }
  })

  // ── 项目级 Agent 差异化配置（P8.7：project_agent_profiles 独立表，enabled+六角色配置） ──
  ipcMain.handle('characterarc:agent-profiles:get', async (_event, payload: unknown) => {
    try {
      const projectId = String((payload as { projectId?: string } | undefined)?.projectId ?? '').trim()
      if (!projectId) throw new Error('缺少 projectId。')
      const db = await ensureWorkspaceDb()
      return { success: true, result: readProjectAgentSettings(db, projectId) }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, '读取项目 Agent 配置失败') }
    }
  })

  ipcMain.handle('characterarc:agent-profiles:set', async (_event, payload: unknown) => {
    try {
      const req = payload as { projectId?: string; enabled?: unknown; profiles?: unknown }
      const projectId = String(req?.projectId ?? '').trim()
      if (!projectId) throw new Error('缺少 projectId。')
      const db = await ensureWorkspaceDb()
      const clean = writeProjectAgentSettings(db, projectId, {
        enabled: req.enabled === true,
        profiles: req.profiles
      })
      return { success: true, result: clean }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, '保存项目 Agent 配置失败') }
    }
  })

  // ── 读取章节版本（供 agent 编辑撤销） ──
  ipcMain.handle('characterarc:ai-read-chapter-version', async (_event, payload: unknown) => {
    try {
      const req = payload as { projectId?: string; versionId?: string }
      const projectId = String(req?.projectId ?? '').trim()
      const versionId = String(req?.versionId ?? '').trim()
      if (!projectId || !versionId) throw new Error('缺少 projectId 或 versionId。')
      const db = await ensureWorkspaceDb()
      const row = db.prepare(
        'SELECT id, chapter_id, title, summary, status, word_target, content, created_at FROM chapter_versions WHERE id = ? AND project_id = ?'
      ).get(versionId, projectId) as Record<string, unknown> | undefined
      if (!row) throw new Error('版本不存在')
      return { success: true, result: { id: row.id, chapterId: row.chapter_id, title: row.title, summary: row.summary, status: row.status, wordTarget: row.word_target, content: row.content, createdAt: row.created_at } }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, '读取版本失败') }
    }
  })

  // ── 读取单个章节内容（供 agent 编辑后前端刷新） ──
  ipcMain.handle('characterarc:ai-read-chapter', async (_event, payload: unknown) => {
    try {
      const req = payload as { projectId?: string; chapterId?: string }
      const projectId = String(req?.projectId ?? '').trim()
      const chapterId = String(req?.chapterId ?? '').trim()
      if (!projectId || !chapterId) throw new Error('缺少 projectId 或 chapterId。')
      const db = await ensureWorkspaceDb()
      const row = db.prepare(
        'SELECT id, title, summary, status, word_target, content FROM chapters WHERE id = ? AND project_id = ?'
      ).get(chapterId, projectId) as Record<string, unknown> | undefined
      if (!row) throw new Error('章节不存在')
      return { success: true, result: { id: row.id, title: row.title, summary: row.summary, status: row.status, wordTarget: row.word_target, content: row.content } }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, '读取章节失败') }
    }
  })

  // ── 螺旋式深度生成 ──
  /** 当前进行中的螺旋生成任务的 AbortController */
  let activeSpiralController: AbortController | null = null

  ipcMain.handle('characterarc:ai-spiral-bootstrap', async (event, payload: unknown) => {
    const controller = new AbortController()
    activeSpiralController = controller
    try {
      const request = payload as Partial<SpiralBootstrapInput>
      if (!request.settings) throw new Error('缺少 AI 设置。')
      if (!request.projectPremise?.trim()) throw new Error('缺少小说简介。')

      const input: SpiralBootstrapInput = {
        settings: request.settings,
        projectTitle: request.projectTitle ?? '',
        projectGenre: request.projectGenre ?? '',
        projectNovelLength: request.projectNovelLength === 'short' ? 'short' : 'long',
        projectPremise: request.projectPremise,
        projectId: request.projectId,
        projectSkills: request.projectSkills
      }

      const result = await runSpiralBootstrap(input, (progressEvent) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('characterarc:ai-spiral-progress', progressEvent)
        }
      }, controller.signal)

      return { success: true, result }
    } catch (error) {
      if (controller.signal.aborted) {
        return { success: false, error: '螺旋生成已取消' }
      }
      return { success: false, error: formatAiErrorMessage(error, '螺旋生成失败') }
    } finally {
      activeSpiralController = null
    }
  })

  ipcMain.handle('characterarc:ai-spiral-cancel', async () => {
    if (!activeSpiralController) return { success: false, error: '没有正在进行的螺旋生成任务' }
    activeSpiralController.abort()
    return { success: true }
  })

  // ── 已有章节状态补录 ──
  ipcMain.handle('characterarc:ai-backfill-state-status', async (_event, projectId: unknown) => {
    try {
      const normalizedProjectId = String(projectId ?? '').trim()
      if (!normalizedProjectId) throw new Error('缺少 projectId。')
      return { success: true, result: await getProjectBackfillChapterStatuses(normalizedProjectId) }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, '读取状态补录进度失败') }
    }
  })

  ipcMain.handle('characterarc:ai-backfill-task-status', (_event, projectId: unknown) => {
    try {
      const normalizedProjectId = String(projectId ?? '').trim()
      if (!normalizedProjectId) throw new Error('缺少 projectId。')
      return { success: true, result: backfillTasks.get(normalizedProjectId)?.snapshot ?? null }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, '读取状态补录任务失败') }
    }
  })

  ipcMain.handle('characterarc:ai-backfill-state-pause', (_event, projectId: unknown) => {
    try {
      const normalizedProjectId = String(projectId ?? '').trim()
      const record = backfillTasks.get(normalizedProjectId)
      if (!record || !isActiveBackfillTask(record.snapshot)) {
        throw new Error('该项目没有正在进行的状态补录任务。')
      }
      const status = record.controller.requestPause()
      return {
        success: true,
        result: updateBackfillTask(record, {
          status,
          message: status === 'paused' ? '任务已暂停。' : '将在当前章节处理完成后暂停。'
        })
      }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, '暂停状态补录失败') }
    }
  })

  ipcMain.handle('characterarc:ai-backfill-state-resume', (_event, projectId: unknown) => {
    try {
      const normalizedProjectId = String(projectId ?? '').trim()
      const record = backfillTasks.get(normalizedProjectId)
      if (!record || !isActiveBackfillTask(record.snapshot)) {
        throw new Error('该项目没有可继续的状态补录任务。')
      }
      const status = record.controller.resume()
      return {
        success: true,
        result: updateBackfillTask(record, { status, message: '任务已继续。' })
      }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, '继续状态补录失败') }
    }
  })

  ipcMain.handle('characterarc:ai-backfill-state', (_event, payload: unknown) => {
    try {
      const request = payload as { settings?: AppSettings; projectId?: string; selection?: BackfillSelection }
      const projectId = String(request?.projectId ?? '').trim()
      if (!projectId) throw new Error('缺少 projectId。')
      if (!request?.settings) throw new Error('缺少 AI 设置。')
      const existing = backfillTasks.get(projectId)
      if (existing && isActiveBackfillTask(existing.snapshot)) {
        throw new Error('该项目已有状态补录任务正在进行。')
      }

      const now = new Date().toISOString()
      const record: BackfillTaskRecord = {
        controller: new BackfillTaskPauseController(),
        snapshot: {
          taskId: randomUUID(),
          projectId,
          status: 'running',
          current: 0,
          total: 0,
          chapterTitle: '',
          phase: 'starting',
          message: '正在准备补录队列...',
          startedAt: now,
          updatedAt: now
        }
      }
      backfillTasks.set(projectId, record)
      broadcastBackfillTask(record.snapshot)

      void backfillProjectStateFromChapters(
        request.settings,
        projectId,
        (progress) => {
          updateBackfillTask(record, {
            current: progress.current,
            total: progress.total,
            chapterTitle: progress.chapterTitle,
            phase: progress.phase,
            message: progress.message
          })
        },
        {
          selection: request.selection,
          waitIfPaused: async (progress) => {
            await record.controller.waitIfPaused((status) => {
              updateBackfillTask(record, {
                ...progress,
                status,
                message: status === 'paused' ? '任务已暂停。' : '任务已继续。'
              })
            })
          },
          onChapterRun: (run) => {
            const meta = buildRunMeta(
              'state-backfill',
              run.projectId,
              run.chapterId,
              run.settings,
              run.status,
              run.startedAt,
              run.finishedAt,
              run.usage,
              [],
              [],
              false,
              run.responsePreview || `状态补录：${run.chapterTitle}`,
              run.error
            )
            deps!.emitAiRunEvent({ projectId: run.projectId, meta: { id: randomUUID(), ...meta } })
          }
        }
      )
        .then((result) => {
          updateBackfillTask(record, {
            status: 'completed',
            phase: 'done',
            current: result.totalChapters,
            total: result.totalChapters,
            chapterTitle: '',
            message: result.failed > 0 ? '状态补录已完成，部分章节失败。' : '状态补录已完成。',
            result,
            error: undefined
          })
        })
        .catch((error) => {
          updateBackfillTask(record, {
            status: 'failed',
            message: formatAiErrorMessage(error, '状态补录失败'),
            error: formatAiErrorMessage(error, '状态补录失败')
          })
        })

      return { success: true, result: record.snapshot }
    } catch (error) {
      return { success: false, error: formatAiErrorMessage(error, '状态补录失败') }
    }
  })
}
