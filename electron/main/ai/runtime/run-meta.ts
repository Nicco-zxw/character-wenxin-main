import type { AiRunMeta, AiRunKnowledgeItem, AiRunUsage, AiTaskName, AppSettings, AiTaskResult } from '../shared-types'

/**
 * 构建 AI 运行元数据对象，记录一次 AI 调用的关键信息
 * @param task - 任务名称
 * @param projectId - 项目 ID
 * @param chapterId - 章节 ID（可选）
 * @param settings - 应用设置
 * @param status - 运行状态（success / error / canceled）
 * @param startedAt - 开始时间 ISO 字符串
 * @param finishedAt - 结束时间 ISO 字符串
 * @param usage - 本次运行累计 token 用量
 * @param usedKnowledge - 本次使用的知识条目
 * @param usedSkills - 本次使用的技能 ID 列表
 * @param repairTriggered - 是否触发了 JSON 修复
 * @param responsePreview - 响应预览文本
 * @param error - 错误信息（成功时为空字符串）
 * @param clientKey - 可选的客户端标识
 * @returns AI 运行元数据
 */
export function buildRunMeta(
  task: AiTaskName,
  projectId: string,
  chapterId: string | undefined,
  settings: AppSettings,
  status: AiRunMeta['status'],
  startedAt: string,
  finishedAt: string,
  usage: AiRunUsage | undefined,
  usedKnowledge: AiRunKnowledgeItem[],
  usedSkills: string[],
  repairTriggered: boolean,
  responsePreview: string,
  error: string,
  clientKey?: string
): AiRunMeta {
  const startedAtMs = new Date(startedAt).getTime()
  const finishedAtMs = new Date(finishedAt).getTime()
  const durationMs = Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs)
    ? Math.max(0, finishedAtMs - startedAtMs)
    : undefined

  return {
    task,
    projectId,
    chapterId,
    clientKey,
    provider: settings.provider,
    model: settings.model,
    status,
    startedAt,
    finishedAt,
    durationMs,
    usage,
    usedKnowledge: usedKnowledge.slice(0, 5),
    usedSkills,
    repairTriggered,
    error,
    responsePreview: responsePreview.trim().slice(0, 240)
  }
}

/**
 * 从任务结果中提取响应预览文本（截取前 240 字符）
 * @param result - AI 任务结果
 * @returns 截断后的预览字符串
 */
export function buildResponsePreview(result: AiTaskResult): string {
  if ('content' in result && typeof result.content === 'string') {
    return result.content.trim().slice(0, 240)
  }
  try {
    return JSON.stringify(result).slice(0, 240)
  } catch {
    return ''
  }
}
