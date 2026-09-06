/**
 * P6.2.2 forecast LLM 生成（隔离式多分支推演）。
 * 基于当前正史的最后章节 + 故事状态，让模型产出 N(2-5) 条隔离候选未来；
 * 输出经 `sanitizeForecastRoot` 净化后再交给 store 落库（forecast 只写自己的表）。
 * 实现风格对齐 Observer 提取（orchestrator 内直连 LLM），不注册为 TaskHandler。
 */
import type { AppSettings } from '../shared-types'
import type { StoryStateContext } from '../../story-state-store'
import { formatStoryStateForPrompt } from '../../story-state-store'
import { aiGenerateTextWithUsage } from '../generate'
import { extractJsonObject } from '../tasks/base'
import { clampBranchCount, sanitizeForecastRoot } from './normalize'
import type { ForecastBranchMeta } from './store'

export interface ForecastGenerationResult {
  title: string
  branches: ForecastBranchMeta[]
  summary: Record<string, unknown>
}

export async function generateForecastBranchesViaLLM(
  settings: AppSettings,
  content: string,
  preState: StoryStateContext,
  branchCount: number,
  signal?: AbortSignal
): Promise<ForecastGenerationResult> {
  const want = clampBranchCount(branchCount)
  const stateSnapshot = formatStoryStateForPrompt(preState)
  const prompt = {
    system: `你是剧情多线推演员。基于当前正史的最后章节与故事状态，推演 ${want} 条彼此隔离、互斥的候选未来。
每条候选需给出：章节节拍、主角关键决定、预计的世界变化、主要风险、与作者意图/当前伏笔的匹配说明。
只输出纯JSON，不要解释。JSON结构：
{
  "title": "推演标题",
  "branches": [
    { "id": "b1", "title": "分支标题", "beats": ["节拍1", "节拍2"], "decision": "主角关键决定", "changes": ["世界变化"], "risks": ["风险"], "fit": "与作者意图的匹配说明" }
  ]
}
要求：id 从 b1 开始连续；各分支必须互斥，不得是同一剧情的换说法。`,
    user: `当前故事状态：
${stateSnapshot || '（空）'}

当前最后章节正文（节选，最多 3000 字）：
${content.slice(-3000)}

请输出 ${want} 条隔离候选未来的JSON。`
  }

  try {
    const generation = await aiGenerateTextWithUsage(settings, prompt, 2000, signal, { disableReasoning: true })
    const parsed = extractJsonObject(generation.text)
    return sanitizeForecastRoot(parsed, want)
  } catch (error) {
    signal?.throwIfAborted()
    throw error
  }
}
