import type { DatabaseSync } from 'node:sqlite'

type ProjectRow = { rowId: number; id: string; title: string }
type KnowledgeDocumentRow = {
  id: string
  projectId: string
  sourceType: string
  sourceLabel: string
  metadataJson: string
  createdAt: string
}

function parseProjectCreatedAt(projectId: string): number | null {
  const timestamp = /^project-(\d{10,})/.exec(projectId)?.[1]
  if (!timestamp) return null
  const value = Number(timestamp)
  return Number.isFinite(value) ? value : null
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function isRelevantAiTask(document: KnowledgeDocumentRow, task: string): boolean {
  if (document.sourceLabel === 'story-deep-audit') return task === 'story-deep-audit'
  if (document.sourceLabel === 'global-constraint') {
    return task === 'global-assistant' || task === 'global-assistant-proposal'
  }
  if (document.sourceType === 'workflow-document') return task === 'workflow-documents'
  if (document.sourceType === 'chapter-summary') {
    return task === 'chapter-first-draft' || task === 'chapter-memo' || task === 'chapter-audit'
  }
  return false
}

/** 修正历史知识文档的作用域：有证据才恢复项目归属，否则保持未归属。 */
export function migrateKnowledgeDocumentScopes(db: DatabaseSync): void {
  db.exec(`
    UPDATE knowledge_documents
    SET project_id = ''
    WHERE source_type IN ('reference-summary', 'reference-chunk');
  `)

  const projects = db.prepare(`
    SELECT rowid AS rowId, id, title
    FROM projects
    ORDER BY rowid ASC
  `).all() as ProjectRow[]
  const projectById = new Map(projects.map((project) => [project.id, project]))
  const earliestProjectByTitle = new Map<string, ProjectRow>()
  projects.forEach((project) => {
    const title = project.title.trim()
    if (title && !earliestProjectByTitle.has(title)) {
      earliestProjectByTitle.set(title, project)
    }
  })

  const documents = db.prepare(`
    SELECT id, project_id AS projectId, source_type AS sourceType, source_label AS sourceLabel,
      metadata_json AS metadataJson, created_at AS createdAt
    FROM knowledge_documents
    WHERE source_type IN ('workflow-document', 'canon-fact', 'chapter-summary')
  `).all() as KnowledgeDocumentRow[]
  const nearbyRuns = db.prepare(`
    SELECT DISTINCT p.title, r.task
    FROM ai_runs r
    JOIN projects p ON p.id = r.project_id
    WHERE ABS(unixepoch(r.started_at) - unixepoch(?)) <= 900
  `)
  const updateProjectId = db.prepare(`UPDATE knowledge_documents SET project_id = ? WHERE id = ?`)

  for (const document of documents) {
    const assignedProject = projectById.get(document.projectId)
    const documentCreatedAt = Date.parse(document.createdAt)
    const assignedProjectCreatedAt = assignedProject ? parseProjectCreatedAt(assignedProject.id) : null
    const hasImpossibleAssignment = Boolean(
      assignedProjectCreatedAt !== null
      && Number.isFinite(documentCreatedAt)
      && assignedProjectCreatedAt > documentCreatedAt
    )
    if (assignedProject && !hasImpossibleAssignment) continue

    const metadata = parseMetadata(document.metadataJson)
    const metadataProjectId = String(metadata.projectId ?? '').trim()
    const metadataProject = projectById.get(metadataProjectId)
    if (metadataProject) {
      updateProjectId.run(metadataProject.id, document.id)
      continue
    }

    const metadataProjectTitle = String(metadata.projectTitle ?? metadata.sourceProjectTitle ?? '').trim()
    const metadataTitleProject = earliestProjectByTitle.get(metadataProjectTitle)
    if (metadataTitleProject) {
      updateProjectId.run(metadataTitleProject.id, document.id)
      continue
    }

    const candidateTitles = new Set(
      (nearbyRuns.all(document.createdAt) as Array<{ title: string; task: string }>)
        .filter((run) => isRelevantAiTask(document, run.task))
        .map((run) => run.title.trim())
        .filter(Boolean)
    )
    const inferredTitle = candidateTitles.size === 1 ? [...candidateTitles][0] : ''
    updateProjectId.run(earliestProjectByTitle.get(inferredTitle)?.id ?? '', document.id)
  }
}
