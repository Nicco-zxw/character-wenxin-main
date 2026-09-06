import { app } from 'electron'
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillDefinition } from './types'
import { parseSkillFrontmatter } from './frontmatter'
import { validateManifest } from './manifest'
import { inferSkillMeta, buildFullManifest } from './heuristics'

/** 将 projectId 标准化为 registry key，空值时返回 '_shared' */
function resolveProjectSkillsScope(projectId?: string): string {
  const normalizedProjectId = String(projectId ?? '').trim()
  return normalizedProjectId || '_shared'
}

/** 获取内置 skill 目录的绝对路径 */
export function getBuiltinSkillsDirPath(): string {
  return join(app.getAppPath(), 'resources', 'skills')
}

/**
 * 获取项目级 skill 目录的绝对路径
 * @param projectId - 项目标识，为空时使用共享目录
 * @returns 项目 skill 目录路径
 */
export function getProjectSkillsDirPath(projectId?: string): string {
  return join(app.getPath('userData'), 'project-skills', resolveProjectSkillsScope(projectId))
}

/**
 * 扫描磁盘上的内置和项目 skill，合并后按名称排序返回
 * @param projectId - 项目标识
 * @returns 合并后的 skill 定义列表
 */
export async function scanSkillsFromDisk(projectId?: string): Promise<SkillDefinition[]> {
  const builtinSkills = await scanSkillsUnderRoot(getBuiltinSkillsDirPath(), 'builtin')
  const projectSkills = await scanSkillsUnderRoot(getProjectSkillsDirPath(projectId), 'project')
  const mergedMap = new Map<string, SkillDefinition>()

  for (const skill of builtinSkills) mergedMap.set(skill.id, skill)
  for (const skill of projectSkills) mergedMap.set(skill.id, skill)

  return Array.from(mergedMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

/** 扫描指定根目录下所有子目录，将每个目录解析为 SkillDefinition（支持一层分组目录） */
async function scanSkillsUnderRoot(root: string, scope: 'builtin' | 'project'): Promise<SkillDefinition[]> {
  if (!existsSync(root)) return []

  const entries = await readdir(root, { withFileTypes: true })
  const skills: SkillDefinition[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dirPath = join(root, entry.name)
    if (existsSync(join(dirPath, 'SKILL.md'))) {
      const skill = await loadSkillDefinition(root, entry.name, scope)
      if (skill) skills.push(skill)
    } else {
      const subEntries = await readdir(dirPath, { withFileTypes: true })
      for (const subEntry of subEntries) {
        if (!subEntry.isDirectory()) continue
        if (existsSync(join(dirPath, subEntry.name, 'SKILL.md'))) {
          const skill = await loadSkillDefinition(dirPath, subEntry.name, scope, entry.name)
          if (skill) skills.push(skill)
        }
      }
    }
  }

  return skills
}

/** 从单个 skill 目录加载完整定义，解析失败时返回 null */
async function loadSkillDefinition(root: string, dirName: string, scope: 'builtin' | 'project', group?: string): Promise<SkillDefinition | null> {
  const skillDir = join(root, dirName)
  const skillPath = join(skillDir, 'SKILL.md')

  try {
    const content = await readFile(skillPath, 'utf-8')
    const frontmatter = parseSkillFrontmatter(content)
    const validatedManifest = validateManifest(frontmatter.manifest)
    const heuristic = inferSkillMeta(dirName, frontmatter.description)
    const fullManifest = buildFullManifest(validatedManifest, heuristic)

    const referencesDir = join(skillDir, 'references')
    const referenceFiles = existsSync(referencesDir) ? await listFilesRecursive(referencesDir) : []
    const referencesCount = referenceFiles.length
    const pathPrefix = scope === 'builtin' ? 'skills' : 'project-skills'
    const pathSegment = group ? `${pathPrefix}/${group}/${dirName}` : `${pathPrefix}/${dirName}`

    return {
      id: dirName,
      name: frontmatter.name || dirName,
      version: frontmatter.version || '',
      path: pathSegment,
      scope,
      rootDir: skillDir,
      description: frontmatter.description || '',
      source: frontmatter.source || '',
      manifest: fullManifest,
      compatibility: frontmatter.overrides.compatibility ?? heuristic.compatibility,
      compatibilityNote: frontmatter.overrides.compatibilityNote ?? heuristic.compatibilityNote,
      enabled: frontmatter.overrides.enabled ?? heuristic.enabled,
      referencesCount,
      referenceFiles: referenceFiles.map((f) => `references/${f}`),
      content
    }
  } catch {
    return null
  }
}

/** 递归列出目录下所有文件，返回相对 root 的路径 */
async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = []

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name)
        continue
      }
      out.push(prefix ? `${prefix}/${entry.name}` : entry.name)
    }
  }

  await walk(root, '')
  return out.sort()
}
