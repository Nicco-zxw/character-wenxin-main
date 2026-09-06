import assert from 'node:assert/strict'
import test from 'node:test'

import {
  insertInHtml,
  joinChapterBlocks,
  replaceInHtml
} from './chapter-html-edit.ts'

test('段内替换不会生成嵌套 p 或额外空段落', () => {
  const result = replaceInHtml('<p>风从旧城吹过。</p>', '旧城', '北境')

  assert.equal(result, '<p>风从北境吹过。</p>')
  assert.doesNotMatch(result, /<p>[^]*<p>/)
  assert.doesNotMatch(result, /<p><\/p>/)
})

test('多行替换在原段落内使用硬换行，不产生额外空段落', () => {
  const result = replaceInHtml('<p>开头旧句结尾</p>', '旧句', '第一句\n第二句')

  assert.equal(result, '<p>开头第一句<br>第二句结尾</p>')
  assert.doesNotMatch(result, /<p><\/p>/)
})

test('锚点插入保持合法段落结构', () => {
  assert.equal(
    insertInHtml('<p>甲乙</p>', '甲', '新增', 'after'),
    '<p>甲<br>新增乙</p>'
  )
})

test('空编辑器追加正文时替换占位空段落', () => {
  assert.equal(joinChapterBlocks('<p></p>', '<p>正文</p>', 'end'), '<p>正文</p>')
})
