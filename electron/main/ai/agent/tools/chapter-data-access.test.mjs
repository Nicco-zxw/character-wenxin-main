import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { commitChapterEditInDb } from './chapter-commit.ts'

const db = new DatabaseSync(':memory:')
const prepare = (sql) => db.prepare?.(sql) ?? db.prepareSync(sql)

db.exec(`
  CREATE TABLE chapters (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    volume_id TEXT NOT NULL,
    outline_item_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL,
    word_target TEXT NOT NULL,
    content TEXT NOT NULL,
    sort_order INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE chapter_versions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    chapter_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL,
    word_target TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
`)

// 测试前插入一条章节数据
function seedChapter(projectId, chapterId, content) {
  prepare(`
    INSERT INTO chapters (
      id, project_id, volume_id, outline_item_id, title, summary, status,
      word_target, content, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    chapterId,
    projectId,
    `${projectId}-volume`,
    '',
    '第一章',
    '测试章节',
    'draft',
    '预估 3000字',
    content,
    0
  )
}

// 用于读取章节当前正文，以验证提交后内容是否正确
function readChapterContent(chapterId) {
  return prepare('SELECT content FROM chapters WHERE id = ?').get(chapterId).content
}

// 统计指定章节有多少条历史版本
function countVersions(chapterId) {
  return prepare('SELECT COUNT(*) AS value FROM chapter_versions WHERE chapter_id = ?')
    .get(chapterId).value
}

// 测试1：正常提交
test('提交章节正文时会保存旧版本并写入新正文', async () => {
  seedChapter('project-commit-ok', 'chapter-commit-ok', '<p>旧正文</p>')

  const result = commitChapterEditInDb(
    db,
    'project-commit-ok',
    'chapter-commit-ok',
    '<p>旧正文</p>',
    '<p>新正文</p>'
  )

  assert.match(result.versionId, /[0-9a-f-]{36}/i)
  assert.equal(readChapterContent('chapter-commit-ok'), '<p>新正文</p>')
  assert.equal(countVersions('chapter-commit-ok'), 1)
})

// 测试2：拒绝覆盖新内容
test('章节正文在暂存后变化时拒绝写回，避免覆盖用户新内容', async () => {
  seedChapter('project-stale', 'chapter-stale', '<p>暂存时正文</p>')
  prepare('UPDATE chapters SET content = ? WHERE id = ?')
    .run('<p>用户后来改过的正文</p>', 'chapter-stale')

  assert.throws(
    () => commitChapterEditInDb(
      db,
      'project-stale',
      'chapter-stale',
      '<p>暂存时正文</p>',
      '<p>Agent 生成的新正文</p>'
    ),
    /暂存后已发生变化/
  )
  assert.equal(readChapterContent('chapter-stale'), '<p>用户后来改过的正文</p>')
  assert.equal(countVersions('chapter-stale'), 0)
})
