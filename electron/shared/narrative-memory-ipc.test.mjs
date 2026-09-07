import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RollbackPreviewRequestSchema,
  TruthExportRequestSchema
} from './narrative-memory.ts'

test('投影导出只接受 json 或 markdown', () => {
  assert.equal(
    TruthExportRequestSchema.parse({ projectId: 'p', atChapter: 2, format: 'json' }).format,
    'json'
  )
  assert.equal(
    TruthExportRequestSchema.safeParse({ projectId: 'p', atChapter: 2, format: 'html' }).success,
    false
  )
})

test('回溯请求钳制为非负整数章号', () => {
  assert.equal(
    RollbackPreviewRequestSchema.parse({ projectId: 'p', targetChapter: 2.8 }).targetChapter,
    2
  )
  assert.equal(
    RollbackPreviewRequestSchema.safeParse({ projectId: 'p', targetChapter: -1 }).success,
    false
  )
})

test('IPC 请求拒绝空项目 ID 和非法章号', () => {
  assert.equal(
    TruthExportRequestSchema.safeParse({ projectId: ' ', atChapter: 0, format: 'json' }).success,
    false
  )
  assert.equal(
    RollbackPreviewRequestSchema.safeParse({ projectId: 'p', targetChapter: Number.NaN }).success,
    false
  )
})
