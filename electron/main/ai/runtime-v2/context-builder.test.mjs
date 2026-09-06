import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ContextBuilder,
  assembleContextBlock
} from './context-builder.ts'

const surface = {
  id: 'global-assistant',
  scope: 'project',
  autoCommit: false,
  maxSteps: 8
}

function makeRequest(budgetTokens) {
  return {
    surface,
    sessionId: 'session-1',
    projectId: 'project-1',
    budgetTokens
  }
}

function makeProvider({ id, priority, body, estimatedTokens, truncationHint, build }) {
  return {
    id,
    priority,
    truncationHint,
    async build(request) {
      if (build) return build(request)
      return {
        providerId: id,
        priority,
        heading: id,
        body,
        estimatedTokens
      }
    }
  }
}

test('上下文按优先级保留，高优先级切片先占用预算', async () => {
  const builder = new ContextBuilder()
  builder.register(makeProvider({
    id: 'low-priority',
    priority: 10,
    body: '低优先级内容',
    estimatedTokens: 60,
    truncationHint: '低优先级内容已省略'
  }))
  builder.register(makeProvider({
    id: 'high-priority',
    priority: 100,
    body: '高优先级内容',
    estimatedTokens: 60,
    truncationHint: '高优先级内容已省略'
  }))

  const result = await builder.build(surface, makeRequest(60))

  assert.deepEqual(result.slices.map((slice) => slice.providerId), ['high-priority'])
  assert.equal(result.slices[0].truncated, undefined)
  assert.deepEqual(result.truncatedProviderIds, ['low-priority'])
  assert.equal(result.usedTokens, 60)
})

test('超大上下文在预算允许时压缩并保留开头和结尾', async () => {
  const builder = new ContextBuilder()
  const body = `开头标记\n${'中间内容'.repeat(1200)}\n结尾标记`
  builder.register(makeProvider({
    id: 'large-provider',
    priority: 50,
    body,
    estimatedTokens: 5000,
    truncationHint: '需要全文时调用 read_project_data'
  }))

  const result = await builder.build(surface, makeRequest(360))

  assert.equal(result.slices.length, 1)
  assert.equal(result.slices[0].providerId, 'large-provider')
  assert.equal(result.slices[0].truncated, true)
  assert.match(result.slices[0].heading, /已压缩/)
  assert.match(result.slices[0].body, /开头标记/)
  assert.match(result.slices[0].body, /结尾标记/)
  assert.deepEqual(result.compressedProviderIds, ['large-provider'])
  assert.deepEqual(result.truncatedProviderIds, [])
  assert.ok(result.usedTokens <= 360)
})

test('预算不足时先使用占位提示，连占位也放不下时记录为省略', async () => {
  const placeholderBuilder = new ContextBuilder()
  placeholderBuilder.register(makeProvider({
    id: 'placeholder-provider',
    priority: 20,
    body: '正文'.repeat(500),
    estimatedTokens: 1000,
    truncationHint: '请调用 read_chapter 查询'
  }))

  const placeholderResult = await placeholderBuilder.build(surface, makeRequest(20))

  assert.equal(placeholderResult.slices.length, 1)
  assert.equal(placeholderResult.slices[0].body, '请调用 read_chapter 查询')
  assert.equal(placeholderResult.slices[0].truncated, true)
  assert.deepEqual(placeholderResult.truncatedProviderIds, ['placeholder-provider'])

  const omittedBuilder = new ContextBuilder()
  omittedBuilder.register(makeProvider({
    id: 'omitted-provider',
    priority: 20,
    body: '正文'.repeat(500),
    estimatedTokens: 1000,
    truncationHint: '请调用 read_chapter 查询'
  }))

  const omittedResult = await omittedBuilder.build(surface, makeRequest(1))

  assert.deepEqual(omittedResult.slices, [])
  assert.deepEqual(omittedResult.truncatedProviderIds, ['omitted-provider'])
})

test('单个 provider 失败不会阻断其余上下文构建', async () => {
  const builder = new ContextBuilder()
  builder.register(makeProvider({
    id: 'broken-provider',
    priority: 100,
    build: async () => {
      throw new Error('provider failed')
    }
  }))
  builder.register(makeProvider({
    id: 'healthy-provider',
    priority: 10,
    body: '可用上下文',
    estimatedTokens: 10
  }))
  const originalConsoleError = console.error
  const logged = []
  console.error = (...args) => logged.push(args)
  try {
    const result = await builder.build(surface, makeRequest(100))

    assert.deepEqual(result.slices.map((slice) => slice.providerId), ['healthy-provider'])
    assert.equal(logged.length, 1)
    assert.match(String(logged[0][0]), /broken-provider/)
  } finally {
    console.error = originalConsoleError
  }
})

test('拼装上下文时列出已压缩和已省略模块并提示主动查询', () => {
  const output = assembleContextBlock({
    slices: [{
      providerId: 'project-brief',
      priority: 100,
      heading: '项目摘要',
      body: '摘要正文',
      estimatedTokens: 10
    }],
    usedTokens: 10,
    compressedProviderIds: ['current-chapter'],
    truncatedProviderIds: ['outline']
  })

  assert.match(output, /## 项目摘要\n\n摘要正文/)
  assert.match(output, /已压缩模块：current-chapter/)
  assert.match(output, /已省略模块：outline/)
  assert.match(output, /read_project_data \/ search_project \/ read_chapter/)
})
