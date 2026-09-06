import { randomUUID } from 'node:crypto'
import type { DatabaseSync, StatementSync } from 'node:sqlite'

/**
 * 提交章节编辑到数据库
 * @param db - SQLite 数据库实例
 * @param projectId - 项目 ID
 * @param chapterId - 章节 ID
 * @param oldContent - 旧的章节内容
 * @param newContent - 新的章节内容
 * @returns 提交后的版本 ID
 * @throws 如果章节不存在或内容已被修改，则抛出错误
 */
export function commitChapterEditInDb(
  db: ChapterCommitDb,
  projectId: string,
  chapterId: string,
  oldContent: string,
  newContent: string
): { versionId: string } {
  // 查询章节信息，确保章节存在且内容未被修改
  // 使用参数绑定，而不是字符串拼接，可以避免SQL注入
  const row = prepareStatement(db,
    'SELECT title, summary, status, word_target, content FROM chapters WHERE id = ? AND project_id = ?'
  ).get(chapterId, projectId) as Record<string, unknown> | undefined

  if (!row) {
    throw new Error(`Chapter not found: ${chapterId}`)
  }
  if (String(row.content) !== oldContent) {
    throw new Error('章节正文在暂存后已发生变化，请重新生成修改提案。')
  }

  // 乐观锁：在提交时检查章节内容是否与旧内容一致，如果不一致则抛出错误，避免覆盖其他人的修改
  const versionId = randomUUID()
  db.exec('BEGIN')
  try {
    // 在 chapter_versions 表中插入新的版本记录，记录提交的章节内容和元数据
    prepareStatement(db, `
      INSERT INTO chapter_versions (id, project_id, chapter_id, title, summary, status, word_target, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      versionId,
      projectId,
      chapterId,
      String(row.title),
      String(row.summary),
      String(row.status),
      String(row.word_target),
      oldContent,
      new Date().toISOString()
    )

    
    // 更新章节内容，如果更新失败（即没有行被修改），则说明内容已被修改，抛出错误
    const result = prepareStatement(db, 'UPDATE chapters SET content = ? WHERE id = ? AND project_id = ? AND content = ?')
      .run(newContent, chapterId, projectId, oldContent)
    // 检查更新结果，如果没有行被修改，则说明章节内容已被修改，抛出错误
    if (result.changes === 0) {
      throw new Error('章节正文在暂存后已发生变化，请重新生成修改提案。')
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  return { versionId }
}

// 定义用于章节提交的数据库接口类型
type ChapterCommitDb = Pick<DatabaseSync, 'exec'> & {
  prepare?: (sql: string) => StatementSync
  prepareSync?: (sql: string) => StatementSync
}

// 辅助函数：用于兼容不同版本的 SQLite 数据库接口，确保可以获取到 prepare 方法
function prepareStatement(db: ChapterCommitDb, sql: string): StatementSync {
  const prepare = db.prepare ?? db.prepareSync
  if (!prepare) {
    throw new Error('SQLite database does not expose prepare/prepareSync')
  }
  return prepare.call(db, sql)
}

// 修改意见：使用版本号进行乐观锁控制，确保在提交章节编辑时不会覆盖其他人的修改。
// 即使使用版本号，旧正文仍然需要从数据库中读取后保存到版本表，而不应该完全信任客户端传来的 oldContent