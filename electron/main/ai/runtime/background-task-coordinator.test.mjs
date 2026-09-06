import assert from 'node:assert/strict'
import test from 'node:test'

import { BackgroundTaskCoordinator } from './background-task-coordinator.ts'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('相同业务键和输入会复用正在运行的后台任务', async () => {
  const coordinator = new BackgroundTaskCoordinator()
  const pending = deferred()
  let calls = 0
  const runner = async () => {
    calls += 1
    return pending.promise
  }

  const first = coordinator.runLatest('chapter:1', 'content-a', runner)
  const duplicate = coordinator.runLatest('chapter:1', 'content-a', runner)

  assert.equal(first, duplicate)
  assert.equal(calls, 0)
  pending.resolve('done')
  assert.equal(await first, 'done')
  assert.equal(calls, 1)
  assert.equal(coordinator.isRunning('chapter:1'), false)
})

test('同一业务键的新输入会取消旧任务并运行最新任务', async () => {
  const coordinator = new BackgroundTaskCoordinator()
  let oldSignal
  const oldTask = coordinator.runLatest('chapter:1', 'content-a', async (signal) => {
    oldSignal = signal
    await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })
  await Promise.resolve()

  const latestTask = coordinator.runLatest(
    'chapter:1',
    'content-b',
    async () => 'latest'
  )

  assert.equal(oldSignal.aborted, true)
  await assert.rejects(oldTask, /superseded/)
  assert.equal(await latestTask, 'latest')
  assert.equal(coordinator.isRunning('chapter:1'), false)
})

test('旧任务稍后结束时不会清除仍在运行的新任务', async () => {
  const coordinator = new BackgroundTaskCoordinator()
  const oldPending = deferred()
  const latestPending = deferred()

  const oldTask = coordinator.runLatest(
    'chapter:1',
    'content-a',
    async () => oldPending.promise
  )
  const latestTask = coordinator.runLatest(
    'chapter:1',
    'content-b',
    async () => latestPending.promise
  )

  oldPending.resolve('old')
  assert.equal(await oldTask, 'old')
  assert.equal(coordinator.isRunning('chapter:1'), true)

  latestPending.resolve('latest')
  assert.equal(await latestTask, 'latest')
  assert.equal(coordinator.isRunning('chapter:1'), false)
})
