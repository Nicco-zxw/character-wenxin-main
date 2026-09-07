# Narrative Memory Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不破坏现有项目数据的前提下，为 CharacterArc 建立版本化五层叙事记忆基础、原子章节结算、JSON/Markdown 双投影和任意章点级联回溯。

**Architecture:** 保留现有类型化 `story_*` 表，引入项目级账本版本而不是改成泛型 EAV。Observer/Validator/Arbiter 继续在现有结算管线中工作，Reducer 的数据库写入改由统一 Committer 在单一 SQLite 事务中完成。JSON 与 Markdown 从同一 `NarrativeSnapshot` 生成，只作为带哈希的派生投影。

**Tech Stack:** Electron 37、TypeScript 5.9、Node `node:sqlite`、Zod 4、Node test runner、Vue 3 preload/IPC。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `electron/shared/narrative-memory.ts` | 五层记忆、账本版本、投影 Envelope、回溯计划的 Zod 契约 |
| `electron/shared/narrative-memory.test.mjs` | 契约解析、钳制和拒绝非法结构的单测 |
| `electron/main/story-state-store.ts` | 项目账本版本、历史状态查询、逻辑失效和 NarrativeSnapshot 数据读取 |
| `electron/main/story-state-store.test.mjs` | 账本迁移、版本递增、任意章点查询和下游失效测试 |
| `electron/main/ai/settlement/types.ts` | `baseLedgerVersion`、`runId` 和结算提交结果类型 |
| `electron/main/ai/settlement/settlement-store.ts` | 结算表迁移、按版本读取、下游结算逻辑失效 |
| `electron/main/ai/settlement/settlement-store.test.mjs` | 结算版本字段和逻辑失效测试 |
| `electron/main/ai/settlement/committer.ts` | 单事务执行快照、Reducer、摘要、账本版本和结算事件写入 |
| `electron/main/ai/settlement/committer.test.mjs` | 故障注入验证无半写入、版本冲突拒绝提交 |
| `electron/main/ai/settlement/index.ts` | 使用 Committer，保留 Observer–Validator–Arbiter 决策职责 |
| `electron/main/ai/narrative-projection.ts` | 从 SQLite 快照生成同源 JSON/Markdown 与内容哈希 |
| `electron/main/ai/narrative-projection.test.mjs` | 双投影同版本、同哈希和确定性测试 |
| `electron/main/register-main-ipc.ts` | 扩展 truth export，同时支持 JSON/Markdown；新增回溯预览/执行 IPC |
| `electron/preload/index.ts` | 暴露投影导出和回溯接口 |
| `renderer/src/env.d.ts` | preload API 类型 |
| `package.json` | 把新增 `.test.mjs` 加入固定测试清单 |

### Task 1: 恢复并锁定验证基线

**Files:**
- Verify: `package.json`
- Verify: `pnpm-lock.yaml`

- [ ] **Step 1: 按锁文件恢复依赖**

Run:

```powershell
pnpm install --frozen-lockfile
```

Expected: exit 0；`node_modules/vue-tsc/bin/vue-tsc.js` 存在；不修改 `pnpm-lock.yaml`。

- [ ] **Step 2: 运行类型基线**

Run:

```powershell
pnpm run typecheck
```

Expected: PASS。若出现源码类型错误，记录为基线阻塞并先做最小修复，不进入后续任务。

- [ ] **Step 3: 运行测试与评测基线**

Run:

```powershell
pnpm test
pnpm eval
```

Expected: 229 tests PASS；eval gate PASS。删除本轮新生成且未被跟踪的时间戳报告，只保留既有基线文件。

### Task 2: 建立五层记忆运行时契约

**Files:**
- Create: `electron/shared/narrative-memory.ts`
- Create: `electron/shared/narrative-memory.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: 写契约失败测试**

```javascript
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MemoryLayerSchema,
  NarrativeProjectionEnvelopeSchema,
  RollbackPlanSchema
} from './narrative-memory.ts'

test('五层记忆 ID 只接受 M0-M4', () => {
  assert.equal(MemoryLayerSchema.parse('M0'), 'M0')
  assert.equal(MemoryLayerSchema.parse('M4'), 'M4')
  assert.equal(MemoryLayerSchema.safeParse('M5').success, false)
})

test('投影 Envelope 要求非负账本版本和 64 位源哈希', () => {
  const result = NarrativeProjectionEnvelopeSchema.safeParse({
    schemaVersion: 1,
    projectId: 'project-1',
    ledgerVersion: 3,
    atChapter: 2,
    generatedAt: '2026-09-07T00:00:00.000Z',
    sourceHash: 'a'.repeat(64),
    snapshot: { constitution: {}, truth: {}, episodes: {}, evidence: {}, working: {} }
  })
  assert.equal(result.success, true)
  assert.equal(NarrativeProjectionEnvelopeSchema.safeParse({
    schemaVersion: 1,
    projectId: 'project-1',
    ledgerVersion: -1,
    atChapter: 2,
    generatedAt: 'bad-date',
    sourceHash: 'short',
    snapshot: {}
  }).success, false)
})

test('回溯计划去重并拒绝目标章之后仍声明有效的下游章', () => {
  const plan = RollbackPlanSchema.parse({
    projectId: 'project-1',
    targetChapter: 3,
    invalidatedChapters: [5, 4, 5],
    retainedChapterIds: ['c4', 'c5'],
    baseLedgerVersion: 9
  })
  assert.deepEqual(plan.invalidatedChapters, [4, 5])
})
```

- [ ] **Step 2: 运行测试确认模块不存在**

Run:

```powershell
node --test electron/shared/narrative-memory.test.mjs
```

Expected: FAIL，错误包含 `ERR_MODULE_NOT_FOUND`。

- [ ] **Step 3: 实现契约**

```typescript
import { z } from 'zod'

export const MemoryLayerSchema = z.enum(['M0', 'M1', 'M2', 'M3', 'M4'])
export type MemoryLayer = z.infer<typeof MemoryLayerSchema>

const UnknownRecordSchema = z.record(z.string(), z.unknown())

export const NarrativeSnapshotSchema = z.object({
  constitution: UnknownRecordSchema,
  truth: UnknownRecordSchema,
  episodes: UnknownRecordSchema,
  evidence: UnknownRecordSchema,
  working: UnknownRecordSchema
}).strict()
export type NarrativeSnapshot = z.infer<typeof NarrativeSnapshotSchema>

export const NarrativeProjectionEnvelopeSchema = z.object({
  schemaVersion: z.number().int().positive(),
  projectId: z.string().trim().min(1),
  ledgerVersion: z.number().int().nonnegative(),
  atChapter: z.number().int().nonnegative(),
  generatedAt: z.string().datetime(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  snapshot: NarrativeSnapshotSchema
}).strict()
export type NarrativeProjectionEnvelope = z.infer<typeof NarrativeProjectionEnvelopeSchema>

export const RollbackPlanSchema = z.object({
  projectId: z.string().trim().min(1),
  targetChapter: z.number().int().nonnegative(),
  invalidatedChapters: z.array(z.number().int().nonnegative()),
  retainedChapterIds: z.array(z.string().trim().min(1)),
  baseLedgerVersion: z.number().int().nonnegative()
}).strict().transform((value, ctx) => {
  const invalidatedChapters = [...new Set(value.invalidatedChapters)].sort((a, b) => a - b)
  if (invalidatedChapters.some((chapter) => chapter <= value.targetChapter)) {
    ctx.addIssue({ code: 'custom', message: '失效章节必须晚于回溯目标章' })
    return z.NEVER
  }
  return { ...value, invalidatedChapters }
})
export type RollbackPlan = z.infer<typeof RollbackPlanSchema>
```

- [ ] **Step 4: 加入固定测试清单并验证**

在 `package.json#scripts.test` 的 `node --test` 文件列表中加入：

```text
electron/shared/narrative-memory.test.mjs
```

Run:

```powershell
node --test electron/shared/narrative-memory.test.mjs
pnpm run typecheck
```

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add package.json electron/shared/narrative-memory.ts electron/shared/narrative-memory.test.mjs
git commit -m "feat: define narrative memory contracts"
```

### Task 3: 增加项目级账本版本

**Files:**
- Modify: `electron/main/story-state-store.ts`
- Modify: `electron/main/story-state-store.test.mjs`

- [ ] **Step 1: 写失败测试**

在 `story-state-store.test.mjs` 增加：

```javascript
test('项目账本版本彼此隔离且事务内单调递增', () => {
  const db = new DatabaseSync(':memory:')
  initStoryStateSchema(db)
  assert.equal(readProjectLedger(db, 'p1').ledgerVersion, 0)
  assert.equal(bumpProjectLedger(db, 'p1', { settledThroughChapter: 2 }), 1)
  assert.equal(bumpProjectLedger(db, 'p1', { settledThroughChapter: 3 }), 2)
  assert.equal(readProjectLedger(db, 'p1').settledThroughChapter, 3)
  assert.equal(readProjectLedger(db, 'p2').ledgerVersion, 0)
})
```

并从 `story-state-store.ts` 导入 `readProjectLedger` 与 `bumpProjectLedger`。

- [ ] **Step 2: 运行测试确认失败**

Run:

```powershell
node --test electron/main/story-state-store.test.mjs
```

Expected: FAIL，提示缺少导出。

- [ ] **Step 3: 增加表和 API**

在 `STORY_STATE_SCHEMA` 中加入：

```sql
CREATE TABLE IF NOT EXISTS story_project_ledgers (
  project_id TEXT PRIMARY KEY,
  ledger_version INTEGER NOT NULL DEFAULT 0,
  settled_through_chapter INTEGER NOT NULL DEFAULT -1,
  projections_dirty INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
) STRICT;
```

在 `story-state-store.ts` 增加：

```typescript
export interface ProjectLedgerState {
  projectId: string
  ledgerVersion: number
  settledThroughChapter: number
  projectionsDirty: boolean
  updatedAt: string
}

export function readProjectLedger(db: DatabaseSync, projectId: string): ProjectLedgerState {
  const row = db.prepare(`SELECT * FROM story_project_ledgers WHERE project_id = ?`).get(projectId) as Record<string, unknown> | undefined
  if (!row) return { projectId, ledgerVersion: 0, settledThroughChapter: -1, projectionsDirty: true, updatedAt: '' }
  return {
    projectId,
    ledgerVersion: Number(row.ledger_version),
    settledThroughChapter: Number(row.settled_through_chapter),
    projectionsDirty: Number(row.projections_dirty) === 1,
    updatedAt: String(row.updated_at)
  }
}

export function bumpProjectLedger(
  db: DatabaseSync,
  projectId: string,
  input: { settledThroughChapter: number }
): number {
  const timestamp = now()
  db.prepare(`
    INSERT INTO story_project_ledgers
      (project_id, ledger_version, settled_through_chapter, projections_dirty, updated_at)
    VALUES (?, 1, ?, 1, ?)
    ON CONFLICT(project_id) DO UPDATE SET
      ledger_version = ledger_version + 1,
      settled_through_chapter = excluded.settled_through_chapter,
      projections_dirty = 1,
      updated_at = excluded.updated_at
  `).run(projectId, input.settledThroughChapter, timestamp)
  return readProjectLedger(db, projectId).ledgerVersion
}
```

- [ ] **Step 4: 验证迁移幂等和现有测试**

Run:

```powershell
node --test electron/main/story-state-store.test.mjs
pnpm run typecheck
```

Expected: PASS；重复调用 `initStoryStateSchema` 不改变已有项目版本。

- [ ] **Step 5: 提交**

```powershell
git add electron/main/story-state-store.ts electron/main/story-state-store.test.mjs
git commit -m "feat: version project truth ledgers"
```

### Task 4: 给结算账关联账本版本

**Files:**
- Modify: `electron/main/ai/settlement/types.ts`
- Modify: `electron/main/ai/settlement/settlement-store.ts`
- Modify: `electron/main/ai/settlement/settlement-store.test.mjs`

- [ ] **Step 1: 写旧库迁移与读回失败测试**

```javascript
test('结算记录保存基础与提交后账本版本', () => {
  const db = makeDb()
  recordSettlementRun(db, {
    id: 'run-versioned', projectId: 'p', chapterIndex: 2, contentHash: 'hash', attempt: 0,
    status: 'settled', decision: 'apply', issues: [], delta: null, reason: 'ok',
    baseLedgerVersion: 4, committedLedgerVersion: 5
  })
  const run = readSettlementRun(db, 'p', undefined, 2)
  assert.equal(run.baseLedgerVersion, 4)
  assert.equal(run.committedLedgerVersion, 5)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```powershell
node --test electron/main/ai/settlement/settlement-store.test.mjs
```

Expected: FAIL，版本字段为 `undefined`。

- [ ] **Step 3: 增加兼容列与类型**

在 `settlement_runs` 增加并通过 `ensureColumn` 迁移：

```sql
base_ledger_version INTEGER NOT NULL DEFAULT 0,
committed_ledger_version INTEGER
```

在 `SettlementRunRecord` 和 `recordSettlementRun` 输入中增加：

```typescript
baseLedgerVersion: number
committedLedgerVersion: number | null
```

旧调用缺省为 `0 / null`，保证现有代码继续通过；读写 SQL 使用显式列名。

- [ ] **Step 4: 验证**

Run:

```powershell
node --test electron/main/ai/settlement/settlement-store.test.mjs
pnpm run typecheck
```

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add electron/main/ai/settlement/types.ts electron/main/ai/settlement/settlement-store.ts electron/main/ai/settlement/settlement-store.test.mjs
git commit -m "feat: link settlements to ledger versions"
```

### Task 5: 建立原子 Settlement Committer

**Files:**
- Create: `electron/main/ai/settlement/committer.ts`
- Create: `electron/main/ai/settlement/committer.test.mjs`
- Modify: `electron/main/story-state-store.ts`
- Modify: `electron/main/ai/settlement/index.ts`
- Modify: `package.json`

- [ ] **Step 1: 抽出不自行开事务的 Reducer 核心并写失败测试**

把现有 `applyStateDelta` 函数体移动到内部 `applyStateDeltaCore`，保留原 API：

```typescript
export function applyStateDeltaInTransaction(
  db: DatabaseSync,
  projectId: string,
  chapterIndex: number,
  delta: StateDelta,
  opts?: { sourceEventId?: string | null; actor?: string }
): void {
  applyStateDeltaCore(db, projectId, chapterIndex, delta, opts)
}

export function applyStateDelta(/* existing signature */): void {
  db.exec('BEGIN')
  try {
    applyStateDeltaCore(db, projectId, chapterIndex, delta, opts)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
```

测试断言直接调用 `applyStateDelta` 的既有行为不变，并新增在外层事务中调用 `applyStateDeltaInTransaction` 后可由外层回滚。

- [ ] **Step 2: 实现 Committer 的失败测试**

`committer.test.mjs` 使用临时 SQLite 数据库，构造 `chapters` 表和一个最小 Delta，覆盖：

```javascript
test('摘要阶段故障会回滚状态、账本版本和结算记录', () => {
  const before = readProjectLedger(db, 'p')
  assert.throws(() => commitSettlement(db, input, { afterReducer: () => { throw new Error('injected') } }), /injected/)
  assert.deepEqual(getLatestCharacterStates(db, 'p', ['林岚']), [])
  assert.equal(readProjectLedger(db, 'p').ledgerVersion, before.ledgerVersion)
  assert.equal(readSettlementRun(db, 'p', 'c1', 1), null)
})

test('基础账本版本过期时拒绝提交', () => {
  bumpProjectLedger(db, 'p', { settledThroughChapter: 0 })
  assert.throws(() => commitSettlement(db, { ...input, baseLedgerVersion: 0 }), /STALE_BASE_VERSION/)
})
```

- [ ] **Step 3: 实现 Committer**

`committer.ts` 导出：

```typescript
export interface CommitSettlementInput {
  runId: string
  projectId: string
  chapterId?: string
  chapterIndex: number
  contentHash: string
  baseLedgerVersion: number
  actor: SettlementActor
  delta: StateDelta
  issues: SettlementIssue[]
  status: 'settled' | 'settled_with_warning'
  decision: 'apply' | 'apply_with_warning'
  reason: string
}

export interface SettlementCommitHooks {
  afterReducer?(): void
  afterSummary?(): void
}

export function commitSettlement(
  db: DatabaseSync,
  input: CommitSettlementInput,
  hooks: SettlementCommitHooks = {}
): { runId: string; committedLedgerVersion: number } {
  db.exec('BEGIN IMMEDIATE')
  try {
    const current = readProjectLedger(db, input.projectId)
    if (current.ledgerVersion !== input.baseLedgerVersion) {
      throw new Error(`STALE_BASE_VERSION: expected ${input.baseLedgerVersion}, received ${current.ledgerVersion}`)
    }
    snapshotSettlementState(db, input.projectId, input.chapterIndex, touchedEntities(input.delta), input.runId)
    applyStateDeltaInTransaction(db, input.projectId, input.chapterIndex, input.delta, {
      sourceEventId: input.runId,
      actor: input.actor
    })
    hooks.afterReducer?.()
    summarizeChapterAfterSettlement(db, input.projectId, input.chapterIndex, input.delta, input.runId)
    hooks.afterSummary?.()
    const committedLedgerVersion = bumpProjectLedger(db, input.projectId, {
      settledThroughChapter: input.chapterIndex
    })
    recordSettlementRun(db, { ...input, attempt: 0, committedLedgerVersion })
    db.exec('COMMIT')
    return { runId: input.runId, committedLedgerVersion }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
```

`touchedEntities` 复用 `index.ts` 当前构造 scope 的确切逻辑并导出为纯函数；不得另写一套字段映射。

- [ ] **Step 4: 让结算编排调用 Committer**

`settlement/index.ts` 保留锁、心跳、Observer/Validator/Arbiter 和 reject/skip 记账；仅将 apply 分支的快照、Reducer、摘要、版本递增和成功记账替换成 `commitSettlement`。进入校验前读取 `baseLedgerVersion`；重观察后仍使用同一版本，提交时由 Committer 做最终 CAS 检查。

- [ ] **Step 5: 验证**

Run:

```powershell
node --test electron/main/ai/settlement/committer.test.mjs electron/main/ai/settlement/settlement-store.test.mjs electron/main/story-state-store.test.mjs
pnpm test
pnpm run typecheck
pnpm eval
```

Expected: 全部 PASS；故障注入后所有相关表保持提交前状态。

- [ ] **Step 6: 提交**

```powershell
git add package.json electron/main/story-state-store.ts electron/main/story-state-store.test.mjs electron/main/ai/settlement/index.ts electron/main/ai/settlement/committer.ts electron/main/ai/settlement/committer.test.mjs
git commit -m "feat: commit chapter settlements atomically"
```

### Task 6: 生成同源 JSON/Markdown 投影

**Files:**
- Create: `electron/main/ai/narrative-projection.ts`
- Create: `electron/main/ai/narrative-projection.test.mjs`
- Modify: `electron/main/story-state-store.ts`
- Modify: `package.json`

- [ ] **Step 1: 写确定性投影失败测试**

```javascript
test('JSON 与 Markdown 投影共享账本版本和源哈希', () => {
  const db = makeDbWithOneSettledChapter()
  const projection = buildNarrativeProjection(db, 'p', 0, '2026-09-07T00:00:00.000Z')
  const parsed = JSON.parse(projection.json)
  assert.equal(parsed.ledgerVersion, projection.ledgerVersion)
  assert.equal(parsed.sourceHash, projection.sourceHash)
  assert.match(projection.markdown, /ledgerVersion: 1/)
  assert.match(projection.markdown, new RegExp(`sourceHash: ${projection.sourceHash}`))
  assert.equal(
    buildNarrativeProjection(db, 'p', 0, '2026-09-07T00:00:00.000Z').json,
    projection.json
  )
})
```

- [ ] **Step 2: 实现快照与投影**

在 `story-state-store.ts` 增加 `buildNarrativeSnapshot(db, projectId, atChapter)`，按稳定键排序返回：

```typescript
{
  constitution: { worldRules },
  truth: queryStateAtChapter(db, projectId, atChapter),
  episodes: { chapterSummaries: listChapterSummaries(db, projectId).filter((x) => x.chapterIndex <= atChapter) },
  evidence: { indexedSources: listActiveEvidenceRefs(db, projectId, atChapter) },
  working: {}
}
```

`narrative-projection.ts` 使用 `node:crypto#createHash('sha256')` 对稳定序列化后的 `snapshot` 计算 `sourceHash`，再从同一个 Envelope 生成 JSON 与 Markdown。Markdown Front Matter 写入 `schemaVersion / projectId / ledgerVersion / atChapter / generatedAt / sourceHash`。

- [ ] **Step 3: 验证**

Run:

```powershell
node --test electron/main/ai/narrative-projection.test.mjs
pnpm run typecheck
```

Expected: PASS。

- [ ] **Step 4: 提交**

```powershell
git add package.json electron/main/story-state-store.ts electron/main/ai/narrative-projection.ts electron/main/ai/narrative-projection.test.mjs
git commit -m "feat: generate versioned truth projections"
```

### Task 7: 实现任意章点回溯计划与级联失效

**Files:**
- Modify: `electron/main/story-state-store.ts`
- Modify: `electron/main/story-state-store.test.mjs`
- Modify: `electron/main/ai/settlement/settlement-store.ts`
- Modify: `electron/main/ai/settlement/settlement-store.test.mjs`

- [ ] **Step 1: 写回溯失败测试**

建立三章已结算数据后断言：

```javascript
const plan = planRollbackToChapter(db, 'p', 1)
assert.deepEqual(plan.invalidatedChapters, [2])
assert.deepEqual(plan.retainedChapterIds, ['c2'])

applyRollbackPlan(db, plan)
assert.equal(queryStateAtChapter(db, 'p', 1).characterStates[0].location, 'B')
assert.equal(readProjectLedger(db, 'p').settledThroughChapter, 1)
assert.equal(listChaptersNeedingResettlement(db, 'p')[0].chapterId, 'c2')
assert.equal(db.prepare(`SELECT COUNT(*) count FROM chapters WHERE project_id='p'`).get().count, 3)
```

- [ ] **Step 2: 增加逻辑失效字段**

通过幂等迁移增加：

```sql
ALTER TABLE settlement_runs ADD COLUMN invalidated_at TEXT;
ALTER TABLE settlement_runs ADD COLUMN invalidated_by_run_id TEXT;
ALTER TABLE chapter_summaries ADD COLUMN valid INTEGER NOT NULL DEFAULT 1;
ALTER TABLE story_embeddings ADD COLUMN invalidated_at TEXT;
```

新增窄表：

```sql
CREATE TABLE IF NOT EXISTS chapter_resettlement_queue (
  project_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  chapter_index INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (project_id, chapter_id)
) STRICT;
```

- [ ] **Step 3: 实现预览和应用**

`planRollbackToChapter` 只读查询目标章之后仍有效的结算，并保留章节正文 ID。`applyRollbackPlan` 执行 `BEGIN IMMEDIATE`，检查 `baseLedgerVersion`，然后：

1. 关闭或删除目标章之后的当前生效状态行，并重新打开目标章点最后一个历史行。
2. 标记下游 `settlement_runs`、`chapter_summaries`、`story_embeddings` 和 forecast 为 invalid/stale。
3. 把保留的下游章节加入 `chapter_resettlement_queue`。
4. 更新项目账本 `settled_through_chapter=targetChapter` 并递增版本。
5. 不删除 `chapters` 和 `chapter_versions`。

所有 SQL 使用 `project_id` 作用域；空计划仍递增一次账本版本并留下回溯事件，确保审计明确。

- [ ] **Step 4: 验证故障回滚**

在每个阶段注入错误并断言所有表保持原状，再运行：

```powershell
node --test electron/main/story-state-store.test.mjs electron/main/ai/settlement/settlement-store.test.mjs
pnpm test
pnpm run typecheck
```

Expected: PASS；正文和正文版本数量不变。

- [ ] **Step 5: 提交**

```powershell
git add electron/main/story-state-store.ts electron/main/story-state-store.test.mjs electron/main/ai/settlement/settlement-store.ts electron/main/ai/settlement/settlement-store.test.mjs
git commit -m "feat: invalidate narrative state after rollback"
```

### Task 8: 接入双投影导出与回溯 IPC

**Files:**
- Modify: `electron/main/register-main-ipc.ts`
- Modify: `electron/preload/index.ts`
- Modify: `renderer/src/env.d.ts`
- Create: `electron/shared/narrative-memory-ipc.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: 写 IPC payload 解析测试**

把纯解析函数放在 `electron/shared/narrative-memory.ts`，测试：

```javascript
test('投影导出只接受 json 或 markdown', () => {
  assert.equal(TruthExportRequestSchema.parse({ projectId: 'p', atChapter: 2, format: 'json' }).format, 'json')
  assert.equal(TruthExportRequestSchema.safeParse({ projectId: 'p', atChapter: 2, format: 'html' }).success, false)
})

test('回溯请求钳制为非负整数章号', () => {
  assert.equal(RollbackPreviewRequestSchema.parse({ projectId: 'p', targetChapter: 2.8 }).targetChapter, 2)
  assert.equal(RollbackPreviewRequestSchema.safeParse({ projectId: 'p', targetChapter: -1 }).success, false)
})
```

- [ ] **Step 2: 扩展 IPC 与 preload**

注册：

```text
characterarc:truth-export-v2
characterarc:narrative-rollback-preview
characterarc:narrative-rollback-apply
```

`truth-export-v2` 先用 Schema 校验，再调用 `buildNarrativeProjection`，根据 format 写 `.json` 或 `.md`。回溯 preview 只读返回 `RollbackPlan`；apply 再次校验计划的 `baseLedgerVersion` 后执行。

preload 暴露：

```typescript
truthExportV2(payload: { projectId: string; atChapter: number; format: 'json' | 'markdown' }): Promise<{ canceled: boolean; filePath?: string }>
narrativeRollbackPreview(payload: { projectId: string; targetChapter: number }): Promise<RollbackPlan>
narrativeRollbackApply(payload: RollbackPlan): Promise<{ ledgerVersion: number; invalidatedChapters: number[] }>
```

- [ ] **Step 3: 验证**

Run:

```powershell
node --test electron/shared/narrative-memory-ipc.test.mjs
pnpm run typecheck
pnpm test
```

Expected: PASS；非法 format、负章号、过期账本版本均在写入前失败。

- [ ] **Step 4: 提交**

```powershell
git add package.json electron/shared/narrative-memory.ts electron/shared/narrative-memory-ipc.test.mjs electron/main/register-main-ipc.ts electron/preload/index.ts renderer/src/env.d.ts
git commit -m "feat: expose truth projections and rollback APIs"
```

### Task 9: P1 全量验收与文档同步

**Files:**
- Modify: `docs/superpowers/specs/2026-09-07-local-long-novel-platform-design.md`
- Create: `docs/design/narrative-memory-p1-handover.md`

- [ ] **Step 1: 运行全量自动门禁**

```powershell
pnpm run typecheck
pnpm test
pnpm eval
git diff --check
```

Expected: 全部 exit 0；现有 229 tests 加新增测试全部通过；eval gate 不回退。

- [ ] **Step 2: 执行最小 Electron 走查**

Run:

```powershell
pnpm dev
```

验证：打开旧项目无迁移错误；结算一章后 JSON/Markdown 同版本；只读查看历史章不改变当前态；预览回溯不写库；执行回溯后正文仍在、后续章显示需重新结算。

- [ ] **Step 3: 更新状态文档**

在规格的 P1 段落记录完成日期和实际测试数；交接文档记录新表、迁移、开关、错误码、回退方法和真机结果，不写未验证的成功声明。

- [ ] **Step 4: 提交**

```powershell
git add -f docs/superpowers/specs/2026-09-07-local-long-novel-platform-design.md docs/design/narrative-memory-p1-handover.md
git commit -m "docs: record narrative memory foundation rollout"
```

---

## 完成定义

P0–P1 只有在以下条件同时满足时完成：

- 旧数据库自动迁移且可回退，章节正文和版本历史不丢失。
- 成功结算只产生一次账本版本递增，失败结算不改变任何正史表。
- 结算记录能反查基础与提交后账本版本。
- 任意章点可读；执行回溯后下游派生数据逻辑失效并进入重新结算队列。
- JSON 与 Markdown 由同一个 Snapshot 生成，账本版本和源哈希一致。
- 新增与现有自动门禁全绿，Electron 人工走查有记录。
