import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  BookWriteLockError,
  acquireBookLock,
  bookLockHeld,
  forceClearBookLock,
  heartbeatBookLock,
  initBookLockSchema,
  releaseBookLock
} from './book-lock.ts'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  initBookLockSchema(db)
  return db
}

test('成功获取并占用锁', () => {
  const db = makeDb()
  assert.equal(acquireBookLock(db, { scope: 'p:0', owner: 'task-a', token: 't1', now: 1000 }), true)
  const state = bookLockHeld(db, 'p:0', 2000)
  assert.deepEqual(state, { held: true, owner: 'task-a', live: true })
})

test('其他持有者的活锁 → BOOK_BUSY', () => {
  const db = makeDb()
  acquireBookLock(db, { scope: 'p:0', owner: 'task-a', token: 't1', now: 1000 })
  assert.throws(
    () => acquireBookLock(db, { scope: 'p:0', owner: 'task-b', token: 't2', now: 2000 }),
    (err) => err instanceof BookWriteLockError && err.code === 'BOOK_BUSY' && err.currentOwner === 'task-a'
  )
})

test('同持有者重复获取 → 幂等心跳续约（不抛错）', () => {
  const db = makeDb()
  acquireBookLock(db, { scope: 'p:0', owner: 'task-a', token: 't1', now: 1000 })
  acquireBookLock(db, { scope: 'p:0', owner: 'task-a', token: 't1', now: 5000 })
  assert.equal(bookLockHeld(db, 'p:0', 5000).live, true)
})

test('过期锁可被新持有者抢占（崩溃自愈）', () => {
  const db = makeDb()
  acquireBookLock(db, { scope: 'p:0', owner: 'dead-task', token: 't1', ttlMs: 100, now: 1000 })
  // 心跳 1s → 1100 已超 ttl 100 → 锁过期
  acquireBookLock(db, { scope: 'p:0', owner: 'new-task', token: 't2', ttlMs: 100, now: 2000 })
  assert.equal(bookLockHeld(db, 'p:0', 2000).owner, 'new-task')
})

test('心跳续约使锁在租约内保持活跃', () => {
  const db = makeDb()
  acquireBookLock(db, { scope: 'p:0', owner: 'task-a', token: 't1', ttlMs: 100, now: 1000 })
  heartbeatBookLock(db, { scope: 'p:0', owner: 'task-a', token: 't1', now: 1090 })
  // 若没心跳，1190 已过期；有心跳（1090）→ 1189（diff 99 < 100）仍活跃
  assert.equal(bookLockHeld(db, 'p:0', 1189).live, true)
  // 到 1190（diff 100 不再 < ttl）→ 过期
  assert.equal(bookLockHeld(db, 'p:0', 1190).live, false)
})

test('非持有者不能心跳或释放', () => {
  const db = makeDb()
  acquireBookLock(db, { scope: 'p:0', owner: 'task-a', token: 't1', now: 1000 })
  assert.equal(heartbeatBookLock(db, { scope: 'p:0', owner: 'intruder', token: 'x', now: 2000 }), false)
  assert.equal(releaseBookLock(db, { scope: 'p:0', owner: 'intruder', token: 'x' }), false)
  assert.equal(bookLockHeld(db, 'p:0', 2000).held, true)
})

test('持有者正常释放 → 其他任务可取锁', () => {
  const db = makeDb()
  acquireBookLock(db, { scope: 'p:0', owner: 'task-a', token: 't1', now: 1000 })
  assert.equal(releaseBookLock(db, { scope: 'p:0', owner: 'task-a', token: 't1' }), true)
  acquireBookLock(db, { scope: 'p:0', owner: 'task-b', token: 't2', now: 1000 })
  assert.equal(bookLockHeld(db, 'p:0', 1000).owner, 'task-b')
})

test('forceClearBookLock 清理任意锁', () => {
  const db = makeDb()
  acquireBookLock(db, { scope: 'p:0', owner: 'task-a', token: 't1', now: 1000 })
  assert.equal(forceClearBookLock(db, 'p:0'), true)
  assert.equal(bookLockHeld(db, 'p:0', 1000).held, false)
})
