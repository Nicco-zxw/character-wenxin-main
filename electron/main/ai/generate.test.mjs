import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveProviderOptions } from './request-options.ts'

const baseSettings = {
  apiKey: 'test-key',
  baseUrl: 'https://example.com/v1',
  temperature: 0.7,
  topP: 0.9
}

test('DeepSeek 状态提取请求不发送 reasoning_effort none', () => {
  assert.equal(resolveProviderOptions({
    ...baseSettings,
    provider: 'deepseek',
    model: 'deepseek-chat'
  }, { disableReasoning: true }), undefined)
})

test('只有官方 OpenAI 推理模型使用 reasoning_effort none', () => {
  assert.deepEqual(resolveProviderOptions({
    ...baseSettings,
    provider: 'openai',
    model: 'gpt-5.2'
  }, { disableReasoning: true }), {
    openai: { reasoningEffort: 'none' }
  })
  assert.equal(resolveProviderOptions({
    ...baseSettings,
    provider: 'openai-compatible',
    model: 'gpt-5.2'
  }, { disableReasoning: true }), undefined)
})
