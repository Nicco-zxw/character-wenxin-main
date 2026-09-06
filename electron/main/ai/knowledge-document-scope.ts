type ScopedKnowledgeDocument = {
  projectId?: string
  sourceType: string
}

/** 旧版关键词检索只允许读取当前项目知识；参考资料由显式选书流程单独注入。 */
export function filterProjectKnowledgeDocuments<T extends ScopedKnowledgeDocument>(
  documents: T[],
  projectId: string
): T[] {
  const normalizedProjectId = projectId.trim()
  return documents.filter((document) => (
    document.sourceType !== 'reference-summary'
    && document.sourceType !== 'reference-chunk'
    && Boolean(normalizedProjectId)
    && String(document.projectId ?? '').trim() === normalizedProjectId
  ))
}
