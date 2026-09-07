import { constants } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { initStoryStateSchema } from './story-state-store.ts'
import { initBookLockSchema } from './ai/locking/book-lock.ts'
import { initSettlementSchema } from './ai/settlement/settlement-store.ts'

export const NARRATIVE_MIGRATION_BACKUP = 'workspace.pre-narrative-v4.db'

/** 首次执行 v4 迁移前保留原库副本；重复启动复用同一备份。 */
export async function ensureNarrativeMigrationBackup(
  workspaceDir: string,
  databaseFile = 'workspace.db'
): Promise<string | null> {
  const source = join(workspaceDir, databaseFile)
  const backup = join(workspaceDir, NARRATIVE_MIGRATION_BACKUP)
  try {
    await copyFile(source, backup, constants.COPYFILE_EXCL)
    return backup
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return backup
    if (code === 'ENOENT') return null
    throw error
  }
}

/** 所有叙事核心结构在同一写事务中迁移，任一步失败均不留下半迁移状态。 */
export function runNarrativeMigrations(
  db: DatabaseSync,
  hooks: { afterStoryState?(): void; afterSettlement?(): void } = {}
): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    initStoryStateSchema(db)
    hooks.afterStoryState?.()
    initSettlementSchema(db)
    hooks.afterSettlement?.()
    initBookLockSchema(db)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
