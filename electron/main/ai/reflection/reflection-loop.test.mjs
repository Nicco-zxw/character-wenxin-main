import assert from 'node:assert/strict'
import test from 'node:test'

import { runReflectiveLoop } from './reflection-loop.ts'

test('一次通过：score >= 阈值 → 1 轮收敛', async () => {
  const seenFeedback = []
  const result = await runReflectiveLoop({
    initialInput: '任务',
    act: async (input, feedback) => {
      seenFeedback.push(feedback ?? null)
      return `${input}-产物`
    },
    evaluate: async () => ({ score: 95, critique: '' })
  })
  assert.equal(result.passed, true)
  assert.equal(result.iterations, 1)
  assert.deepEqual(seenFeedback, [null])
  assert.equal(result.transcript.length, 1)
  assert.equal(result.final, '任务-产物')
})

test('critique 会注入下一轮 act 直到收敛', async () => {
  const outputs = []
  const received = []
  const result = await runReflectiveLoop({
    initialInput: { task: '写一段', history: [] },
    maxIterations: 5,
    passScore: 80,
    act: async (input, feedback) => {
      received.push(feedback ?? null)
      const attempt = outputs.length + 1
      const output = { text: `v${attempt}`, history: input.history }
      outputs.push(output)
      if (feedback) {
        return { text: `v${attempt}`, history: [...input.history, feedback] }
      }
      return output
    },
    evaluate: async (output) => {
      if (output.text === 'v1') return { score: 40, critique: '太空泛，请加细节' }
      if (output.text === 'v2') return { score: 70, critique: '缺冲突，请加反转' }
      return { score: 88, critique: '' }
    }
  })
  assert.equal(result.iterations, 3)
  assert.equal(result.passed, true)
  assert.equal(received[0], null)
  assert.equal(received[1], '太空泛，请加细节')
  assert.equal(received[2], '缺冲突，请加反转')
  // transcript 记录 critique 注入历史
  assert.equal(result.transcript[1].feedback, '太空泛，请加细节')
})

test('一直不达标 → 在 maxIterations 停止并返回 passed=false', async () => {
  const result = await runReflectiveLoop({
    initialInput: 'x',
    maxIterations: 3,
    passScore: 90,
    act: async (input) => `${input}-try`,
    evaluate: async () => ({ score: 30, critique: '继续改' })
  })
  assert.equal(result.iterations, 3)
  assert.equal(result.passed, false)
  assert.equal(result.transcript.length, 3)
})

test('maxIterations 下限为 1、evaluate 支持同步返回、score 越界被 clamp', async () => {
  const result = await runReflectiveLoop({
    initialInput: 'x',
    maxIterations: 0,
    passScore: 80,
    act: async (input) => `${input}-once`,
    evaluate: () => ({ score: 150, critique: '' })
  })
  assert.equal(result.iterations, 1)
  assert.equal(result.passed, true)
  assert.equal(result.transcript[0].score, 100)
})
