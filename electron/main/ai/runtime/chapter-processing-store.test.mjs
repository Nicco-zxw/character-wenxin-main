import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  beginChapterProcessing,
  finishChapterProcessing,
  initChapterProcessingSchema,
  readChapterProcessing
} from './chapter-processing-store.ts'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE chapters (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
    ) STRICT;
    INSERT INTO projects (id) VALUES ('project-1');
    INSERT INTO chapters (id, project_id) VALUES ('chapter-1', 'project-1');
  `)
  initChapterProcessingSchema(db)
  return db
}

test('章节后处理状态可从 running 持久化到完成', () => {
  const db = makeDb()
  beginChapterProcessing(db, {
    projectId: 'project-1',
    chapterId: 'chapter-1',
    chapterIndex: 0,
    contentHash: 'hash-a',
    startedAt: '2026-07-26T10:00:00.000Z'
  })

  assert.equal(readChapterProcessing(db, 'project-1', 'chapter-1')?.status, 'running')
  assert.equal(finishChapterProcessing(db, {
    projectId: 'project-1',
    chapterId: 'chapter-1',
    contentHash: 'hash-a',
    status: 'done',
    stateStatus: 'done',
    indexStatus: 'warning',
    issues: [{
      stage: 'vector-index',
      severity: 'warning',
      message: '索引暂不可用'
    }],
    finishedAt: '2026-07-26T10:01:00.000Z'
  }), true)

  const record = readChapterProcessing(db, 'project-1', 'chapter-1')
  assert.equal(record.status, 'done')
  assert.equal(record.stateStatus, 'done')
  assert.equal(record.indexStatus, 'warning')
  assert.equal(record.issues[0].message, '索引暂不可用')
  assert.equal(record.finishedAt, '2026-07-26T10:01:00.000Z')
})

test('旧正文任务不能覆盖新正文的运行状态', () => {
  const db = makeDb()
  beginChapterProcessing(db, {
    projectId: 'project-1',
    chapterId: 'chapter-1',
    chapterIndex: 0,
    contentHash: 'hash-a',
    startedAt: '2026-07-26T10:00:00.000Z'
  })
  beginChapterProcessing(db, {
    projectId: 'project-1',
    chapterId: 'chapter-1',
    chapterIndex: 0,
    contentHash: 'hash-b',
    startedAt: '2026-07-26T10:00:10.000Z'
  })

  assert.equal(finishChapterProcessing(db, {
    projectId: 'project-1',
    chapterId: 'chapter-1',
    contentHash: 'hash-a',
    status: 'canceled',
    stateStatus: 'pending',
    indexStatus: 'pending',
    issues: [],
    finishedAt: '2026-07-26T10:00:20.000Z'
  }), false)

  const record = readChapterProcessing(db, 'project-1', 'chapter-1')
  assert.equal(record.contentHash, 'hash-b')
  assert.equal(record.status, 'running')
})

test('失败记录可由相同正文的重试覆盖', () => {
  const db = makeDb()
  beginChapterProcessing(db, {
    projectId: 'project-1',
    chapterId: 'chapter-1',
    chapterIndex: 0,
    contentHash: 'hash-a',
    startedAt: '2026-07-26T10:00:00.000Z'
  })
  finishChapterProcessing(db, {
    projectId: 'project-1',
    chapterId: 'chapter-1',
    contentHash: 'hash-a',
    status: 'error',
    stateStatus: 'error',
    indexStatus: 'pending',
    issues: [],
    finishedAt: '2026-07-26T10:00:30.000Z'
  })

  beginChapterProcessing(db, {
    projectId: 'project-1',
    chapterId: 'chapter-1',
    chapterIndex: 0,
    contentHash: 'hash-a',
    startedAt: '2026-07-26T10:01:00.000Z'
  })

  const record = readChapterProcessing(db, 'project-1', 'chapter-1')
  assert.equal(record.status, 'running')
  assert.equal(record.stateStatus, 'pending')
  assert.equal(record.issues.length, 0)
  assert.equal(record.finishedAt, '')
})
