/**
 * BOOK_BUSY 写锁 · 租约 · 心跳（P6.1 核心，行为默认不接入运行时）。
 *
 * 参考 inkos `state/manager.ts` 语义：跨会话/进程对同一 scope（如 `project:chapter`）
 * 的串行化写入；冲突抛出 `BookWriteLockError(code='BOOK_BUSY')`；带心跳与租约，
 * 进程崩溃/异常后过期租约可被新持有者抢占（自愈）。
 *
 * 设计约束：本模块仅依赖 node 内置模块，可直接被 `node --test` 以 `.ts` 后缀导入。
 * 说明：真实多进程下 SQLite 已提供串行写，本锁解决的是「跨窗口/跨 AI 任务的语义级互斥」。
 */
import type { DatabaseSync } from 'node:sqlite'

export const DEFAULT_LEASE_TTL_MS = 180_000 // 3 分钟租约
export const DEFAULT_HEARTBEAT_MS = 30_000   // 30 秒心跳参考

export const BOOK_BUSY_CODE = 'BOOK_BUSY'

export class BookWriteLockError extends Error {
  readonly code = BOOK_BUSY_CODE
  readonly scope: string
  readonly currentOwner: string | null

  constructor(scope: string, currentOwner: string | null) {
    super(`写入冲突：资源已被占用（BOOK_BUSY） scope=${scope} owner=${currentOwner ?? '未知'}`)
    this.name = 'BookWriteLockError'
    this.scope = scope
    this.currentOwner = currentOwner
  }
}

const BOOK_LOCK_SCHEMA = `
  CREATE TABLE IF NOT EXISTS book_locks (
    scope TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    token TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL,
    ttl_ms INTEGER NOT NULL
  ) STRICT;
`

export function initBookLockSchema(db: DatabaseSync): void {
  db.exec(BOOK_LOCK_SCHEMA)
}

interface LockRow {
  scope: string
  owner: string
  token: string
  started_at: number
  heartbeat_at: number
  ttl_ms: number
}

function readLock(db: DatabaseSync, scope: string): LockRow | null {
  const row = db.prepare(
    'SELECT scope, owner, token, started_at, heartbeat_at, ttl_ms FROM book_locks WHERE scope = ?'
  ).get(scope) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    scope: String(row.scope),
    owner: String(row.owner),
    token: String(row.token),
    started_at: Number(row.started_at),
    heartbeat_at: Number(row.heartbeat_at),
    ttl_ms: Number(row.ttl_ms)
  }
}

function isLive(row: LockRow, ttlMs: number, nowMs: number): boolean {
  return nowMs - row.heartbeat_at < ttlMs
}

/**
 * 获取写锁。
 * @returns 是否取得（false 表示当前持有者是自己时的心跳续约？不——统一 true；失败会抛 BOOK_BUSY）
 * @throws BookWriteLockError 当 scope 已被其他活锁持有
 */
export function acquireBookLock(
  db: DatabaseSync,
  input: {
    scope: string
    owner: string
    token: string
    ttlMs?: number
    now?: number
  }
): true {
  const ttlMs = input.ttlMs ?? DEFAULT_LEASE_TTL_MS
  const nowMs = input.now ?? Date.now()
  const existing = readLock(db, input.scope)

  if (existing) {
    if (isLive(existing, existing.ttl_ms, nowMs)) {
      // 自己重复获取 → 视为心跳续约（幂等）
      if (existing.owner === input.owner && existing.token === input.token) {
        db.prepare('UPDATE book_locks SET heartbeat_at = ? WHERE scope = ?')
          .run(nowMs, input.scope)
        return true
      }
      throw new BookWriteLockError(input.scope, existing.owner)
    }
    // 过期锁 → 抢占（崩溃自愈）
  }

  db.prepare(`
    INSERT OR REPLACE INTO book_locks (scope, owner, token, started_at, heartbeat_at, ttl_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(input.scope, input.owner, input.token, nowMs, nowMs, ttlMs)
  return true
}

/** 心跳续约：仅当仍是自己的锁时延长 heartbeat_at。 */
export function heartbeatBookLock(
  db: DatabaseSync,
  input: { scope: string; owner: string; token: string; now?: number }
): boolean {
  const nowMs = input.now ?? Date.now()
  const result = db.prepare(`
    UPDATE book_locks SET heartbeat_at = ?
    WHERE scope = ? AND owner = ? AND token = ?
  `).run(nowMs, input.scope, input.owner, input.token)
  return result.changes > 0
}

/** 释放写锁（仅当持有者匹配）。 */
export function releaseBookLock(
  db: DatabaseSync,
  input: { scope: string; owner: string; token: string }
): boolean {
  const result = db.prepare(
    'DELETE FROM book_locks WHERE scope = ? AND owner = ? AND token = ?'
  ).run(input.scope, input.owner, input.token)
  return result.changes > 0
}

/** 只读检查锁是否仍被持有（含是否活锁）。 */
export function bookLockHeld(
  db: DatabaseSync,
  scope: string,
  nowMs = Date.now()
): { held: boolean; owner: string | null; live: boolean } {
  const row = readLock(db, scope)
  if (!row) return { held: false, owner: null, live: false }
  return { held: true, owner: row.owner, live: isLive(row, row.ttl_ms, nowMs) }
}

/** 在最终写事务内确认租约仍由原运行持有；令牌、所有者或存活性任一不符即拒绝写入。 */
export function assertBookLockOwned(
  db: DatabaseSync,
  input: { scope: string; owner: string; token: string; now?: number }
): void {
  const row = readLock(db, input.scope)
  const nowMs = input.now ?? Date.now()
  if (!row
    || row.owner !== input.owner
    || row.token !== input.token
    || !isLive(row, row.ttl_ms, nowMs)) {
    throw new BookWriteLockError(input.scope, row?.owner ?? null)
  }
}

/** 强制清理指定 scope 的锁（管理员/测试用；生产建议用过期抢占而非强删）。 */
export function forceClearBookLock(db: DatabaseSync, scope: string): boolean {
  const result = db.prepare('DELETE FROM book_locks WHERE scope = ?').run(scope)
  return result.changes > 0
}
