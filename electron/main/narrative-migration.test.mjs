import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  NARRATIVE_MIGRATION_BACKUP,
  ensureNarrativeMigrationBackup,
  runNarrativeMigrations
} from './narrative-migration.ts'

test('叙事迁移中途失败会整体回滚', () => {
  const db = new DatabaseSync(':memory:')

  assert.throws(
    () => runNarrativeMigrations(db, {
      afterStoryState: () => { throw new Error('migration-injected') }
    }),
    /migration-injected/
  )
  assert.equal(
    db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='story_project_ledgers'").get().count,
    0
  )
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='settlement_runs'").get().count, 0)
})

test('迁移前备份只创建一次并保留首次内容', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'characterarc-migration-'))
  try {
    const source = join(dir, 'workspace.db')
    await writeFile(source, 'before')
    const backup = await ensureNarrativeMigrationBackup(dir)
    assert.equal(backup, join(dir, NARRATIVE_MIGRATION_BACKUP))

    await writeFile(source, 'after')
    assert.equal(await ensureNarrativeMigrationBackup(dir), backup)
    assert.equal(await readFile(backup, 'utf8'), 'before')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
