import assert from 'node:assert/strict'
import test from 'node:test'

import {
  filterKnowledgeDocumentsForProject,
  normalizeKnowledgeDocumentScope,
  replaceKnowledgeDocumentsBySource
} from './knowledgeCenter.ts'

function makeDocument(overrides = {}) {
  return {
    id: 'knowledge-1',
    title: '项目设定',
    sourceType: 'canon-fact',
    sourceLabel: 'manual',
    content: '主角来自临川。',
    summary: '主角来自临川。',
    keywords: ['主角', '临川'],
    metadata: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

test('项目知识仅对所属项目可见，全局参考资料对所有项目可见', () => {
  const projectA = makeDocument({ id: 'a', projectId: 'project-a' })
  const projectB = makeDocument({ id: 'b', projectId: 'project-b' })
  const reference = makeDocument({
    id: 'reference',
    projectId: '',
    sourceType: 'reference-summary'
  })

  assert.deepEqual(
    filterKnowledgeDocumentsForProject([projectA, projectB, reference], 'project-a').map((item) => item.id),
    ['a', 'reference']
  )
  assert.deepEqual(
    filterKnowledgeDocumentsForProject([projectA, projectB, reference], 'project-b').map((item) => item.id),
    ['b', 'reference']
  )
})

test('旧版空作用域项目知识保持未归属，新文档可显式使用当前项目兜底', () => {
  const legacyProjectDocument = normalizeKnowledgeDocumentScope(makeDocument({ projectId: '' }))
  const newProjectDocument = normalizeKnowledgeDocumentScope(makeDocument({ projectId: '' }), 'project-a')
  const referenceDocument = normalizeKnowledgeDocumentScope(
    makeDocument({ projectId: 'project-a', sourceType: 'reference-chunk' }),
    'project-a'
  )

  assert.equal(legacyProjectDocument.projectId, '')
  assert.equal(newProjectDocument.projectId, 'project-a')
  assert.equal(referenceDocument.projectId, '')
})

test('同名来源只替换当前项目文档，不删除其他项目文档', () => {
  const metadata = { sourceTitle: '人物设定', fileName: '人物.md' }
  const oldProjectA = makeDocument({ id: 'a-old', projectId: 'project-a', metadata })
  const projectB = makeDocument({ id: 'b', projectId: 'project-b', metadata })
  const newProjectA = makeDocument({ id: 'a-new', projectId: 'project-a', metadata })

  const result = replaceKnowledgeDocumentsBySource([oldProjectA, projectB], [newProjectA])

  assert.deepEqual(result.map((item) => item.id), ['b', 'a-new'])
})
