import assert from 'node:assert/strict'
import test from 'node:test'
import { StagedChangesStore } from './staged-changes-store.ts'

function makeChange(sessionId, title) {
  return {
    sessionId,
    turnId: `turn-${sessionId}`,
    kind: 'worldview',
    action: 'create',
    entityTitle: title,
    reason: '测试暂存变更',
    before: '',
    after: title,
    entityPayload: {
      title,
      type: '设定',
      content: title
    }
  }
}

test('暂存状态迁移只在真实变化时返回并发出事件', async () => {
  const store = new StagedChangesStore()
  const events = []
  store.subscribe((event) => events.push(event))

  const change = store.add(makeChange('session-a', '青铜城'))
  events.length = 0

  assert.equal(store.finalize(change.id), null)
  assert.equal(events.length, 0)

  assert.deepEqual(store.accept([change.id]).map((item) => item.id), [change.id])
  assert.equal(store.get(change.id)?.status, 'accepted')
  assert.equal(events.length, 1)

  events.length = 0
  assert.deepEqual(store.accept([change.id]), [])
  assert.equal(events.length, 0)

  assert.deepEqual(store.reject([change.id]).map((item) => item.id), [change.id])
  assert.equal(store.get(change.id)?.status, 'rejected')
  assert.equal(events.length, 1)

  events.length = 0
  assert.deepEqual(store.reject([change.id]), [])
  assert.equal(events.length, 0)

  store.accept([change.id])
  await store.commit(
    async (item) => ({ changeId: item.id, ok: true, entityId: 'world-1' }),
    { changeIds: [change.id] }
  )
  assert.equal(store.get(change.id)?.status, 'committed')

  events.length = 0
  assert.deepEqual(store.reject([change.id]), [])
  assert.equal(store.bindTarget(change.id, 'world-2'), null)
  assert.equal(store.get(change.id)?.entityId, 'world-1')
  assert.equal(events.length, 0)
})

test('缺省提交 accepted 变更时限定在指定 session 内', async () => {
  const store = new StagedChangesStore()
  const a = store.add(makeChange('session-a', '青铜城'))
  const b = store.add(makeChange('session-b', '白塔'))
  store.accept([a.id, b.id])

  const committedIds = []
  const results = await store.commit(
    async (item) => {
      committedIds.push(item.id)
      return { changeId: item.id, ok: true, entityId: `entity-${item.id}` }
    },
    { sessionId: 'session-a' }
  )

  assert.deepEqual(results.map((item) => item.changeId), [a.id])
  assert.deepEqual(committedIds, [a.id])
  assert.equal(store.get(a.id)?.status, 'committed')
  assert.equal(store.get(b.id)?.status, 'accepted')
})

test('commit 成功后更新状态和返回的 entityId', async () => {
  const store = new StagedChangesStore()
  const change = store.add(makeChange('session-a', '镜湖'))
  store.accept([change.id])

  const results = await store.commit(
    async (item) => ({ changeId: item.id, ok: true, entityId: 'world-mirror-lake' }),
    { changeIds: [change.id] }
  )

  assert.deepEqual(results, [{ changeId: change.id, ok: true, entityId: 'world-mirror-lake' }])
  assert.equal(store.get(change.id)?.status, 'committed')
  assert.equal(store.get(change.id)?.entityId, 'world-mirror-lake')
})

test('commit 失败后保持 accepted，允许再次提交', async () => {
  const store = new StagedChangesStore()
  const change = store.add(makeChange('session-a', '灰塔'))
  store.accept([change.id])

  const failed = await store.commit(
    async (item) => ({ changeId: item.id, ok: false, error: '写库失败' }),
    { changeIds: [change.id] }
  )

  assert.deepEqual(failed, [{ changeId: change.id, ok: false, error: '写库失败' }])
  assert.equal(store.get(change.id)?.status, 'accepted')

  const retried = await store.commit(
    async (item) => ({ changeId: item.id, ok: true, entityId: 'world-gray-tower' }),
    { changeIds: [change.id] }
  )

  assert.deepEqual(retried, [{ changeId: change.id, ok: true, entityId: 'world-gray-tower' }])
  assert.equal(store.get(change.id)?.status, 'committed')
  assert.equal(store.get(change.id)?.entityId, 'world-gray-tower')
})

test('混合提交保持结果顺序，成功项 committed，失败项 accepted', async () => {
  const store = new StagedChangesStore()
  const a = store.add(makeChange('session-a', '南港'))
  const b = store.add(makeChange('session-a', '北桥'))
  const c = store.add(makeChange('session-a', '旧井'))
  store.accept([a.id, b.id, c.id])

  const results = await store.commit(
    async (item) => (
      item.id === b.id
        ? { changeId: item.id, ok: false, error: '目标不存在' }
        : { changeId: item.id, ok: true, entityId: `entity-${item.id}` }
    ),
    { changeIds: [c.id, b.id, a.id] }
  )

  assert.deepEqual(results.map((item) => item.changeId), [c.id, b.id, a.id])
  assert.equal(store.get(a.id)?.status, 'committed')
  assert.equal(store.get(a.id)?.entityId, `entity-${a.id}`)
  assert.equal(store.get(b.id)?.status, 'accepted')
  assert.equal(store.get(b.id)?.entityId, undefined)
  assert.equal(store.get(c.id)?.status, 'committed')
  assert.equal(store.get(c.id)?.entityId, `entity-${c.id}`)
})
