import assert from 'node:assert/strict'
import test from 'node:test'

import { BackfillTaskPauseController } from './state-backfill-task-controller.ts'

test('暂停请求会在章节边界阻塞，恢复后继续执行', async () => {
  const controller = new BackfillTaskPauseController()
  const statuses = []
  let continued = false

  assert.equal(controller.requestPause(), 'pausing')
  const waiting = controller.waitIfPaused((status) => statuses.push(status)).then(() => {
    continued = true
  })
  await Promise.resolve()

  assert.equal(controller.status, 'paused')
  assert.equal(continued, false)
  assert.deepEqual(statuses, ['paused'])

  assert.equal(controller.resume(), 'running')
  await waiting
  assert.equal(continued, true)
  assert.deepEqual(statuses, ['paused', 'running'])
})

test('尚未进入暂停点时可以取消暂停请求', async () => {
  const controller = new BackfillTaskPauseController()
  controller.requestPause()
  controller.resume()

  await controller.waitIfPaused(() => {
    throw new Error('不应进入暂停状态')
  })
  assert.equal(controller.status, 'running')
})
