import type { WorkflowDocument, WorkflowDocumentKey } from '@/types/app'
import type { NovelWorkflowStageId } from '@/types/app'

const workflowDocumentDefinitions: Array<{
  key: WorkflowDocumentKey
  title: string
  defaultContent: string
}> = [
  {
    key: 'task_plan',
    title: '创作计划',
    defaultContent: '# 创作计划\n\n- 待 AI 生成本项目的创作计划。\n'
  },
  {
    key: 'findings',
    title: '灵感与发现',
    defaultContent: '# 灵感与发现\n\n- 待 AI 生成本项目的关键发现与灵感记录。\n'
  },
  {
    key: 'progress',
    title: '写作进度',
    defaultContent: '# 写作进度\n\n- 待 AI 生成本项目的写作进度。\n'
  },
  {
    key: 'current_status',
    title: '项目概况',
    defaultContent: '# 项目概况\n\n- 待 AI 生成本项目的整体概况。\n'
  },
  {
    key: 'novel_setting',
    title: '世界与设定',
    defaultContent: '# 世界与设定\n\n- 待 AI 生成本项目的世界观与核心设定。\n'
  },
  {
    key: 'character_relationships',
    title: '人物关系',
    defaultContent: '# 人物关系\n\n- 待 AI 生成本项目的人物关系。\n'
  },
  {
    key: 'pending_hooks',
    title: '伏笔悬念',
    defaultContent: '# 伏笔悬念\n\n- 待 AI 生成本项目的伏笔与悬念记录。\n'
  },
  {
    key: 'resource_ledger',
    title: '素材清单',
    defaultContent: '# 素材清单\n\n- 待 AI 生成本项目的素材清单。\n'
  }
]

export function createDefaultWorkflowDocuments(): WorkflowDocument[] {
  const now = new Date().toISOString()
  return workflowDocumentDefinitions.map((definition) => ({
    key: definition.key,
    title: definition.title,
    content: definition.defaultContent,
    updatedAt: now
  }))
}

export function normalizeWorkflowDocuments(documents?: WorkflowDocument[] | null): WorkflowDocument[] {
  const sourceMap = new Map((documents ?? []).map((document) => [document.key, document]))
  return workflowDocumentDefinitions.map((definition) => {
    const document = sourceMap.get(definition.key)
    return {
      key: definition.key,
      title: definition.title,
      content: document?.content?.trim() ? document.content : definition.defaultContent,
      updatedAt: document?.updatedAt || new Date().toISOString()
    }
  })
}

export const workflowStageDocumentMap: Record<NovelWorkflowStageId, WorkflowDocumentKey[]> = {
  reference: ['task_plan', 'findings'],
  premise: ['current_status', 'novel_setting'],
  setting: ['novel_setting', 'character_relationships', 'findings'],
  outline: ['task_plan', 'pending_hooks'],
  draft: ['progress', 'resource_ledger']
}
