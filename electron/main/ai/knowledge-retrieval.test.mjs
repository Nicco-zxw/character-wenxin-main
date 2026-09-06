import assert from 'node:assert/strict'
import test from 'node:test'

import { filterProjectKnowledgeDocuments } from './knowledge-document-scope.ts'

function makeDocument(id, projectId) {
  return {
    id,
    projectId,
    title: '临川城设定',
    sourceType: 'canon-fact',
    sourceLabel: 'manual',
    content: '临川城由沈氏镇守。',
    summary: '临川城由沈氏镇守。',
    keywords: ['临川城', '沈氏'],
    metadata: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

test('关键词知识检索不会注入其他项目、无归属项目文档或全局参考资料', () => {
  const documents = [
    makeDocument('project-a-document', 'project-a'),
    makeDocument('project-b-document', 'project-b'),
    makeDocument('legacy-unscoped-document', ''),
    { ...makeDocument('reference-document', ''), sourceType: 'reference-summary' }
  ]

  assert.deepEqual(
    filterProjectKnowledgeDocuments(documents, 'project-a').map((item) => item.id),
    ['project-a-document']
  )
})
