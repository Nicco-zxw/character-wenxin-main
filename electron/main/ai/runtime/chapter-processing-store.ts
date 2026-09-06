import type { DatabaseSync } from 'node:sqlite'
import type { ChapterPostGenerationIssuesPayload } from '../shared-types'

export type ChapterProcessingStatus = 'running' | 'done' | 'error' | 'canceled'
export type ChapterProcessingStageStatus =
  | 'pending'
  | 'done'
  | 'warning'
  | 'error'
  | 'skipped'

export type ChapterProcessingRecord = {
  projectId: string
  chapterId: string
  chapterIndex: number
  contentHash: string
  status: ChapterProcessingStatus
  stateStatus: ChapterProcessingStageStatus
  indexStatus: ChapterProcessingStageStatus
  issues: ChapterPostGenerationIssuesPayload['issues']
  startedAt: string
  finishedAt: string
  updatedAt: string
}

type ChapterProcessingRow = {
  project_id: string
  chapter_id: string
  chapter_index: number
  content_hash: string
  status: ChapterProcessingStatus
  state_status: ChapterProcessingStageStatus
  index_status: ChapterProcessingStageStatus
  issues_json: string
  started_at: string
  finished_at: string
  updated_at: string
}

export function initChapterProcessingSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chapter_processing_state (
      chapter_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      chapter_index INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      state_status TEXT NOT NULL,
      index_status TEXT NOT NULL,
      issues_json TEXT NOT NULL DEFAULT '[]',
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE,
      FOREIGN KEY (chapter_id) REFERENCES chapters (id) ON DELETE CASCADE
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_chapter_processing_project
      ON chapter_processing_state (project_id, status, updated_at DESC);
  `)
}

export function beginChapterProcessing(
  db: DatabaseSync,
  input: {
    projectId: string
    chapterId: string
    chapterIndex: number
    contentHash: string
    startedAt: string
  }
): void {
  db.prepare(`
    INSERT INTO chapter_processing_state (
      chapter_id, project_id, chapter_index, content_hash, status, state_status,
      index_status, issues_json, started_at, finished_at, updated_at
    ) VALUES (?, ?, ?, ?, 'running', 'pending', 'pending', '[]', ?, '', ?)
    ON CONFLICT(chapter_id) DO UPDATE SET
      project_id = excluded.project_id,
      chapter_index = excluded.chapter_index,
      content_hash = excluded.content_hash,
      status = 'running',
      state_status = 'pending',
      index_status = 'pending',
      issues_json = '[]',
      started_at = excluded.started_at,
      finished_at = '',
      updated_at = excluded.updated_at
  `).run(
    input.chapterId,
    input.projectId,
    input.chapterIndex,
    input.contentHash,
    input.startedAt,
    input.startedAt
  )
}

/** 仅当前 contentHash 仍匹配时收敛终态，防止旧任务覆盖新正文记录。 */
export function finishChapterProcessing(
  db: DatabaseSync,
  input: {
    projectId: string
    chapterId: string
    contentHash: string
    status: Exclude<ChapterProcessingStatus, 'running'>
    stateStatus: ChapterProcessingStageStatus
    indexStatus: ChapterProcessingStageStatus
    issues: ChapterPostGenerationIssuesPayload['issues']
    finishedAt: string
  }
): boolean {
  const result = db.prepare(`
    UPDATE chapter_processing_state
    SET status = ?, state_status = ?, index_status = ?, issues_json = ?,
        finished_at = ?, updated_at = ?
    WHERE project_id = ? AND chapter_id = ? AND content_hash = ?
  `).run(
    input.status,
    input.stateStatus,
    input.indexStatus,
    JSON.stringify(input.issues),
    input.finishedAt,
    input.finishedAt,
    input.projectId,
    input.chapterId,
    input.contentHash
  )
  return result.changes > 0
}

export function readChapterProcessing(
  db: DatabaseSync,
  projectId: string,
  chapterId: string
): ChapterProcessingRecord | null {
  const row = db.prepare(`
    SELECT project_id, chapter_id, chapter_index, content_hash, status, state_status,
           index_status, issues_json, started_at, finished_at, updated_at
    FROM chapter_processing_state
    WHERE project_id = ? AND chapter_id = ?
  `).get(projectId, chapterId) as ChapterProcessingRow | undefined
  if (!row) return null

  let issues: ChapterPostGenerationIssuesPayload['issues'] = []
  try {
    const parsed = JSON.parse(row.issues_json)
    if (Array.isArray(parsed)) issues = parsed
  } catch {
    // 损坏的诊断信息不影响状态读取。
  }

  return {
    projectId: row.project_id,
    chapterId: row.chapter_id,
    chapterIndex: row.chapter_index,
    contentHash: row.content_hash,
    status: row.status,
    stateStatus: row.state_status,
    indexStatus: row.index_status,
    issues,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at
  }
}
