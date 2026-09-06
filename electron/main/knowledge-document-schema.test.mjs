import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { migrateKnowledgeDocumentScopes } from './knowledge-document-schema.ts'

test('旧知识文档仅在归属可确认时迁移，同名项目选择最早创建项', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE knowledge_documents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL,
      source_label TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE TABLE ai_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task TEXT NOT NULL,
      started_at TEXT NOT NULL
    );
    INSERT INTO projects (id, title) VALUES
      ('project-1700000000000-a', '回响之刃'),
      ('project-1710000000000-b', '回响之刃'),
      ('project-1790000000000-c', '凌霄之上'),
      ('project-1690000000000-d', '其他项目');
    INSERT INTO ai_runs (id, project_id, task, started_at) VALUES
      ('run-a', 'project-1700000000000-a', 'story-deep-audit', '2026-06-01T00:00:00.000Z'),
      ('run-b', 'project-1710000000000-b', 'story-deep-audit', '2026-06-01T00:00:00.000Z');
    INSERT INTO knowledge_documents (id, project_id, source_type, source_label, metadata_json, created_at) VALUES
      ('reference', 'project-1690000000000-d', 'reference-summary', '', '{}', '2026-06-01T00:00:00.000Z'),
      ('inferred-duplicate', 'project-1790000000000-c', 'canon-fact', 'story-deep-audit', '{}', '2026-06-01T00:00:10.000Z'),
      ('metadata-title', '', 'canon-fact', 'manual', '{"projectTitle":"回响之刃"}', '2026-06-01T00:00:00.000Z'),
      ('unknown', '', 'canon-fact', 'manual', '{}', '2026-06-01T00:00:00.000Z'),
      ('owned-project', 'project-1690000000000-d', 'chapter-summary', '', '{}', '2026-06-01T00:00:00.000Z');
  `)

  migrateKnowledgeDocumentScopes(db)

  const rows = db.prepare(`
    SELECT id, project_id AS projectId
    FROM knowledge_documents
    ORDER BY id ASC
  `).all().map((row) => ({ id: row.id, projectId: row.projectId }))
  assert.deepEqual(rows, [
    { id: 'inferred-duplicate', projectId: 'project-1700000000000-a' },
    { id: 'metadata-title', projectId: 'project-1700000000000-a' },
    { id: 'owned-project', projectId: 'project-1690000000000-d' },
    { id: 'reference', projectId: '' },
    { id: 'unknown', projectId: '' }
  ])
  db.close()
})
