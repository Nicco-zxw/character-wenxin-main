# Context Governance Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Runtime v2 建立版本化 Task Contract、fixed/compressible/on-demand 上下文编译、可审计 Context Manifest 与任务级 Token 校准，同时保持旧 TaskHandler 可用。

**Architecture:** 新增纯契约注册表作为任务配置唯一来源，现有 Provider 继续产出 ContextSlice，由 ContextCompiler 按契约槽位分层装载并同时生成 Prompt Context 与 ContextManifest。Manifest 在模型调用前写入 SQLite，运行结束后补记实际 usage 与按需工具命中；现有 context_traces 作为兼容投影保留。

**Tech Stack:** TypeScript、Zod、Node.js `crypto`、SQLite `DatabaseSync`、Node test runner、Electron Runtime v2。

**Spec:** `docs/superpowers/specs/2026-09-07-local-long-novel-platform-design.md`

## Global Constraints

- 仅实现长篇小说创作能力，不引入互动、翻译、影视、封面、通知或部署模块。
- SQLite 是唯一真相源；Context Manifest 是运行审计记录，不得成为小说事实来源。
- `fixed` 槽位禁止压缩、截断和占位；超预算必须抛出 `CONTEXT_PROTECTED_OVERFLOW`。
- 未装载正文只生成逻辑引用和白名单读取工具提示，不复制为第二份权威数据。
- 不新增网络调用、遥测或密钥日志；Manifest 只记录哈希、来源和有限摘要，不保存鉴权信息或隐性推理。
- 旧 `TaskHandler` 通过适配器接入，现有任务输出和 UI 行为默认保持兼容。

---

### Task 1: Versioned Task Contract Registry

**Files:**
- Create: `electron/main/ai/task-contract.ts`
- Create: `electron/main/ai/task-contract.test.mjs`
- Modify: `electron/main/ai/tasks/index.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `TaskContract`, `TaskContextSlotContract`, `TaskBudgetContract`, `registerTaskContract()`, `resolveTaskContract()`, `adaptTaskHandlerContract()`。
- Consumes: `AiTaskName`, `TaskHandler`, `SurfaceId`, `SurfaceScope` 与 Zod Schema。

- [ ] **Step 1: 写失败测试，覆盖注册、版本、输入校验、预算钳制与旧 Handler 适配**

```js
test('契约注册后按 taskId 解析并冻结预算', () => {
  const registry = new TaskContractRegistry()
  registry.register(makeContract({ taskId: 'chapter-assistant', version: 1 }))
  const contract = registry.resolve('chapter-assistant')
  assert.equal(contract.version, 1)
  assert.equal(contract.budgets.maxSteps, 8)
  assert.ok(Object.isFrozen(contract.budgets))
})

test('旧 TaskHandler 适配器生成保守默认契约', () => {
  const contract = adaptTaskHandlerContract(handler)
  assert.equal(contract.taskId, handler.name)
  assert.deepEqual(contract.persistence, ['none'])
  assert.equal(contract.repairAttempts, 2)
})
```

- [ ] **Step 2: 运行测试确认缺少注册表实现**

Run: `node --test electron/main/ai/task-contract.test.mjs`
Expected: FAIL，提示模块或导出不存在。

- [ ] **Step 3: 实现完整契约类型和边界钳制**

```ts
export type ContextTier = 'fixed' | 'compressible' | 'on_demand'

export interface TaskContextSlotContract {
  slotId: string
  providerId: string
  tier: ContextTier
  priority: number
  required: boolean
  minimumTokens: number
  loaderTools: readonly string[]
}

export interface TaskBudgetContract {
  totalInputTokens: number
  fixedTokens: number
  compressibleTokens: number
  toolCallTokens: number
  maxOutputTokens: number
  maxSteps: number
}

export interface TaskContract {
  taskId: AiTaskName
  version: number
  allowedSurfaces: readonly SurfaceId[]
  allowedScopes: readonly SurfaceScope[]
  inputSchema: z.ZodType<Record<string, unknown>>
  slots: readonly TaskContextSlotContract[]
  budgets: Readonly<TaskBudgetContract>
  toolAllowlist: readonly string[]
  outputKind: 'json' | 'text'
  repairAttempts: number
  persistence: readonly ('none' | 'staged_change' | 'truth_commit')[]
  recoverable: boolean
}
```

钳制范围：版本 `1..9999`、Token `1..1_000_000`、步骤 `1..32`、修复次数 `0..2`；重复 `slotId` 或 fixed 预算大于总输入预算时拒绝注册。导出 `listTaskHandlers()`，让适配器为未显式配置的旧任务生成只读、无工具、保守预算契约。

- [ ] **Step 4: 运行定向测试和类型检查**

Run: `node --test electron/main/ai/task-contract.test.mjs && pnpm run typecheck`
Expected: PASS。

- [ ] **Step 5: 提交契约注册表**

```bash
git add electron/main/ai/task-contract.ts electron/main/ai/task-contract.test.mjs electron/main/ai/tasks/index.ts package.json
git commit -m "feat: add versioned task contracts"
```

### Task 2: Three-tier Context Compiler and Manifest

**Files:**
- Modify: `electron/shared/assistant-runtime.ts`
- Modify: `electron/main/ai/runtime-v2/context-builder.ts`
- Modify: `electron/main/ai/runtime-v2/context-builder.test.mjs`

**Interfaces:**
- Consumes: `TaskContract` 与现有 `ContextProvider.build()`。
- Produces: `ContextManifest`, `ContextManifestSlot`, `ContextCompileError`、扩展后的 `BuildResult.manifest`。

- [ ] **Step 1: 写 fixed 不可降级、compressible 优先裁剪和 on-demand 占位测试**

```js
test('fixed 总量超过硬预算立即失败且不构造降级 Prompt', async () => {
  await assert.rejects(
    builder.build(surface, request, contractWithFixedBudget(20)),
    (error) => error.code === 'CONTEXT_PROTECTED_OVERFLOW'
  )
})

test('on-demand 槽位只注入引用并记录加载工具', async () => {
  const result = await builder.build(surface, request, contractWithOnDemand())
  assert.match(result.slices[0].body, /sourceRef=chapter:c9/)
  assert.equal(result.manifest.slots[0].disposition, 'placeholder')
  assert.deepEqual(result.manifest.slots[0].loaderTools, ['read_chapter'])
})
```

- [ ] **Step 2: 运行 ContextBuilder 测试确认旧算法会压缩 fixed**

Run: `node --test electron/main/ai/runtime-v2/context-builder.test.mjs`
Expected: FAIL，缺少 tier/manifest 或 fixed 溢出未报错。

- [ ] **Step 3: 扩展 ContextSlice 来源元数据并实现编译顺序**

```ts
export interface ContextManifestSlot {
  slotId: string
  providerId: string
  sourceRef: string
  sourceVersion: string
  contentHash: string
  tier: ContextTier
  selectionReason: string
  estimatedTokens: number
  actualTokens: number | null
  disposition: 'full' | 'compressed' | 'placeholder' | 'omitted'
  compression: { strategy: 'head_tail'; originalTokens: number } | null
  loaderTools: string[]
  loadedByTool: boolean
}
```

算法固定为：先构建全部 required/fixed；Provider 失败或 fixed 超限直接抛结构化错误；再保证 required compressible 的 `minimumTokens`；其余 compressible 按 priority 分配并允许确定性 head/tail 压缩；on-demand 永不注入完整 body，只注入 `sourceRef/sourceVersion/contentHash/loaderTools` 占位。`contentHash` 使用稳定 SHA-256，未提供 `sourceVersion` 时使用 `sha256:<contentHash>`。

- [ ] **Step 4: 保留旧 build 调用的兼容重载**

没有显式 contract 时，从 Surface Provider 列表生成全部 `compressible` 的兼容契约，使旧测试与旧入口行为不变；新 runtime-v2 必须显式传契约。

- [ ] **Step 5: 运行定向测试**

Run: `node --test electron/main/ai/runtime-v2/context-builder.test.mjs`
Expected: 旧用例和新增三层用例全部 PASS。

- [ ] **Step 6: 提交编译器**

```bash
git add electron/shared/assistant-runtime.ts electron/main/ai/runtime-v2/context-builder.ts electron/main/ai/runtime-v2/context-builder.test.mjs
git commit -m "feat: compile tiered task context"
```

### Task 3: Context Manifest Store and Token Calibration

**Files:**
- Create: `electron/main/ai/context-manifest-store.ts`
- Create: `electron/main/ai/context-manifest-store.test.mjs`
- Modify: `electron/main/workspace-store.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `initContextManifestSchema()`, `createContextManifest()`, `finalizeContextManifest()`, `readContextManifest()`, `resolveTokenCalibration()`。
- Consumes: Task 2 的 `ContextManifest` 和 `AiRunUsage` 的 prompt token 总量。

- [ ] **Step 1: 写持久化、幂等 finalize、工具补载和模型隔离校准测试**

```js
test('Manifest 主表和槽位窄表可完整读回', () => {
  createContextManifest(db, manifest)
  assert.deepEqual(readContextManifest(db, manifest.runId)?.slots, manifest.slots)
})

test('不同 provider/model 的校准倍率互不污染', () => {
  finalizeContextManifest(db, runId, usage(1200), [{ toolName: 'read_chapter' }])
  assert.notEqual(resolveTokenCalibration(db, 'openai', 'gpt-x'), resolveTokenCalibration(db, 'anthropic', 'claude-y'))
})
```

- [ ] **Step 2: 运行测试确认存储模块不存在**

Run: `node --test electron/main/ai/context-manifest-store.test.mjs`
Expected: FAIL。

- [ ] **Step 3: 创建窄表和存储 API**

```sql
CREATE TABLE context_manifests (
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_version INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  estimated_input_tokens INTEGER NOT NULL,
  actual_input_tokens INTEGER,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finalized_at TEXT
) STRICT;

CREATE TABLE context_manifest_slots (
  run_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  tier TEXT NOT NULL,
  disposition TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  actual_tokens INTEGER,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY (run_id, slot_id)
) STRICT;
```

再建 `context_token_calibration(provider, model, factor, sample_count, updated_at)`；factor 按实际输入/估算总量的截断比值 `0.5..2.0` 做 EMA，少于 3 个样本时编译器继续使用系数 `1.0`。按需工具匹配时只更新对应槽位 `loadedByTool=true`，不保存完整工具结果。

- [ ] **Step 4: 在工作区初始化中注册 Schema**

在 `ensureWorkspaceDb()` 的 runtime schema 初始化区调用 `initContextManifestSchema(db)`；重复启动不得改变已有行。

- [ ] **Step 5: 运行测试与类型检查**

Run: `node --test electron/main/ai/context-manifest-store.test.mjs && pnpm run typecheck`
Expected: PASS。

- [ ] **Step 6: 提交 Manifest Store**

```bash
git add electron/main/ai/context-manifest-store.ts electron/main/ai/context-manifest-store.test.mjs electron/main/workspace-store.ts package.json
git commit -m "feat: persist context manifests"
```

### Task 4: Runtime v2 Contract Integration and Unified Run ID

**Files:**
- Modify: `electron/main/ai/runtime-v2/bootstrap.ts`
- Modify: `electron/main/ai/runtime-v2/execution-plan.ts`
- Modify: `electron/main/ai/runtime-v2/ipc.ts`
- Modify: `electron/main/ai/runtime-v2/agent-loop-core.ts`
- Modify: `electron/main/ai/runtime-v2/conversation-manager.ts`
- Modify: `electron/main/ai/runtime-v2/agent-loop.test.mjs`
- Create: `electron/main/ai/runtime-v2/execution-plan.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `resolveTaskContract(taskId)`, `ContextBuilder.build(..., contract)`、Manifest Store。
- Produces: 同一个 `runId` 作为 `assistant_turns.id`、Manifest 主键及运行日志关联 ID。

- [ ] **Step 1: 写 runId、fixed 溢出前置失败和 Manifest 完结测试**

```js
test('IPC 生成的 runId 同时用于 turn 和 context manifest', async () => {
  const result = await sendTurn(validPayload)
  assert.equal(readContextManifest(db, result.turnId).runId, result.turnId)
})

test('fixed 溢出时不调用模型并记录 failed manifest', async () => {
  await assert.rejects(() => resolvePlan(overBudgetInput), /CONTEXT_PROTECTED_OVERFLOW/)
  assert.equal(runAgentCalls, 0)
})
```

- [ ] **Step 2: 运行定向测试确认缺少 runId/contract 串联**

Run: `node --test electron/main/ai/runtime-v2/agent-loop.test.mjs electron/main/ai/runtime-v2/execution-plan.test.mjs`
Expected: FAIL。

- [ ] **Step 3: 将 runId 提前到 IPC preflight**

`TURN_SEND` 入口先生成 `runId = randomUUID()`，传给 `resolveTurnExecutionPlan` 和 `AgentLoop.run`；`CreateTurnInput` 增加可选 `id`，AgentLoop 使用传入 ID 创建 turn。执行计划根据 Surface 映射 `chapter-assistant/global-assistant`，解析并校验对应契约，Surface `maxSteps` 不能突破契约上限。

- [ ] **Step 4: 模型调用前写 Manifest，终态后 finalize**

由 `bootstrap.ts` 将现有 `ensureDb(projectId)` 依赖显式注入执行计划与 IPC，不允许 Manifest Store 自行解析路径或打开第二个数据库连接。计划成功后立即 `createContextManifest()`；AgentLoop 完成、取消或错误后调用 `finalizeContextManifest(runId, usage, toolCalls, status)`。若上下文编译失败，则根据已解析的 contract、runId、project/provider/model 写入不含槽位正文的最小 failed manifest，错误码保持 `CONTEXT_PROTECTED_OVERFLOW` 或 `INPUT_INVALID`，不得调用模型。

- [ ] **Step 5: 工具与持久化权限取交集**

最终工具集合为 `Surface allowlist ∩ TaskContract.toolAllowlist`；`persistence=['none']` 时移除全部 `stage_*`，`staged_change` 仅允许暂存工具，`truth_commit` 不在 Runtime v2 助手路径开放。

- [ ] **Step 6: 运行定向测试、完整测试和类型检查**

先把 `execution-plan.test.mjs` 接入 `package.json` 的 pretest 列表，确保后续 `pnpm test` 不会遗漏该测试。

Run: `node --test electron/main/ai/runtime-v2/agent-loop.test.mjs electron/main/ai/runtime-v2/execution-plan.test.mjs && pnpm test && pnpm run typecheck`
Expected: 全部 PASS。

- [ ] **Step 7: 提交 Runtime 接入**

```bash
git add electron/main/ai/runtime-v2/bootstrap.ts electron/main/ai/runtime-v2/execution-plan.ts electron/main/ai/runtime-v2/ipc.ts electron/main/ai/runtime-v2/agent-loop-core.ts electron/main/ai/runtime-v2/conversation-manager.ts electron/main/ai/runtime-v2/agent-loop.test.mjs electron/main/ai/runtime-v2/execution-plan.test.mjs package.json
git commit -m "feat: enforce context contracts in runtime v2"
```

### Task 5: Compatibility Projection, Audit Documentation, and Final Verification

**Files:**
- Modify: `electron/main/ai/context-trace.ts`
- Modify: `electron/main/ai/context-trace.test.mjs`
- Modify: `docs/superpowers/specs/2026-09-07-local-long-novel-platform-design.md`
- Create: `docs/design/context-governance-p2a-handover.md`

**Interfaces:**
- Produces: `projectManifestToLegacyTrace()`，供现有结算/诊断 UI 在迁移期读取兼容摘要。
- Consumes: Context Manifest Store。

- [ ] **Step 1: 写兼容投影测试**

```js
test('Manifest 投影为旧 trace 时不丢 tier、预算和压缩结论', () => {
  const trace = projectManifestToLegacyTrace(manifest)
  assert.deepEqual(trace.tiers.protected, ['constitution'])
  assert.equal(trace.compression.applied[0], 'recent-chapters')
})
```

- [ ] **Step 2: 实现只读兼容投影**

映射 `fixed -> protected`、`compressible/on_demand -> compressible`；selected source 使用 `sourceRef`，excerpt 只取编译后 Prompt 中最多 200 字，不读取或复制 on-demand 原文。保留旧 `createContextTrace()` API，禁止从旧 trace 反向生成 Manifest。

- [ ] **Step 3: 更新设计状态与交接文档**

记录显式契约覆盖的任务、默认兼容契约、数据库表、错误码、回退开关、实际验证数字，以及 P2B 尚未实现的统一 transcript/orphan recovery/JSON 修复执行器。

- [ ] **Step 4: 最终验证**

Run: `pnpm test`
Expected: 所有前置和标准测试 PASS。

Run: `pnpm run typecheck`
Expected: exit 0。

Run: `pnpm build`
Expected: main、preload、renderer 全部构建成功；只允许记录已知非阻塞构建警告。

- [ ] **Step 5: 提交文档与兼容层**

```bash
git add electron/main/ai/context-trace.ts electron/main/ai/context-trace.test.mjs docs/superpowers/specs/2026-09-07-local-long-novel-platform-design.md
git add -f docs/design/context-governance-p2a-handover.md
git commit -m "docs: hand over context governance foundation"
```
