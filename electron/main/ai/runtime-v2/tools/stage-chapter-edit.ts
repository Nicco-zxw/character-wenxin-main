/**
 * stage_chapter_edit · 章节正文变更暂存工具（Runtime v2 版）
 *
 * 取代旧 `edit_chapter` 的 diff-review 模式：不直接写库，只把 diff 塞进
 * StagedChangesStore 交给用户审阅确认。commit 阶段由 committer 调
 * `commitChapterEdit` 完成真正写回。
 *
 * 工厂函数：AgentLoop 在 Turn 创建后调用，闭包捕获 sessionId/turnId。
 */

import type { Tool } from '../../agent/tools/types'
import {
  computeChapterEdit,
  listProjectChapters,
  readChapterFromDb
} from '../../agent/tools/chapter-data-access'
import {
  makeStageChapterEditToolCore,
  type StageChapterEditToolDeps as CoreDeps
} from './stage-chapter-edit-core'

export type StageChapterEditToolDeps = Omit<CoreDeps, 'dataAccess'>

export function makeStageChapterEditTool(deps: StageChapterEditToolDeps): Tool {
  return makeStageChapterEditToolCore({
    ...deps,
    dataAccess: {
      computeChapterEdit,
      listProjectChapters,
      readChapterFromDb
    }
  })
}
