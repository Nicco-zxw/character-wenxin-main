# 叙事记忆 P1 交接

> 日期：2026-09-07
> 分支：`codex/narrative-memory-foundation`
> 范围：五层记忆契约、项目账本版本、原子结算、双投影、级联回溯与 IPC

## 已落地能力

- SQLite 仍是唯一真相源。JSON 与 Markdown 都从同一个 `NarrativeSnapshot` 即时生成，不会被业务逻辑读回。
- 项目账本版本通过 `story_project_ledgers` 单调递增。成功结算和回溯各推进一次版本。
- 成功结算在一个 `BEGIN IMMEDIATE` 事务中完成快照、Reducer、章摘要、forecast 失效、版本推进和结算记录；提交前校验账本版本、正文哈希、章节归属/顺序及租约令牌。
- 回溯保留 `chapters`、`chapter_versions` 及目标章后的派生状态原行，通过回滚事件关联做逻辑失效；服务端在写事务内重算计划，保留章节完整进入有序重结算队列。
- 重观察成功后提交第二轮 Observer Delta；成功重结算会在同一事务中解决对应队列项。

## 数据库变更

### 新表

| 表 | 用途 |
|---|---|
| `story_project_ledgers` | 项目账本版本、最近完整结算章、投影 dirty 状态 |
| `chapter_resettlement_queue` | 回溯后保留章节的重新结算队列 |
| `narrative_rollback_events` | 回溯目标、基础/提交版本及失效章节审计 |

### 兼容补列

| 表 | 新列 |
|---|---|
| `settlement_runs` | `base_ledger_version`、`committed_ledger_version`、`invalidated_at`、`invalidated_by_run_id` |
| `chapter_summaries` | `valid` |
| `story_embeddings` | `invalidated_at` |
| `story_character_state`、`story_relationships`、`story_timeline`、`story_world_rules`、`story_foreshadowing` | `invalidated_at`、`invalidated_by_run_id` |

初始化使用 `CREATE TABLE IF NOT EXISTS` 与列级幂等迁移。故事状态、结算和写锁结构由统一事务迁移；首次迁移前保存 `workspace.pre-narrative-v4.db`，失败则整体回滚并只读打开工作区。

## 核心接口

- `buildNarrativeSnapshot(db, projectId, atChapter)`：构建 M0–M4 稳定排序快照。
- `buildNarrativeProjection(...)`：生成共享 `ledgerVersion/sourceHash` 的 JSON 与 Markdown。
- `commitSettlement(...)`：以 CAS 和单事务提交已通过裁决的章节状态。
- `planRollbackToChapter(...)`：只读返回目标章、失效章、保留正文 ID 和基础版本。
- `applyRollbackPlan(...)`：再次比较版本后原子应用回溯。
- `listChaptersNeedingResettlement(...)`：读取尚未解决的重结算队列。

Renderer 可通过 preload 调用：

- `truthExportV2({ projectId, atChapter, format })`
- `narrativeRollbackPreview({ projectId, targetChapter })`
- `narrativeRollbackApply(plan)`

## 错误与安全边界

- `STALE_BASE_VERSION`：观察或预览后项目账本已变化，必须重新读取并重新校验。
- `STALE_CHAPTER_CONTENT` / `CHAPTER_SCOPE_MISMATCH`：Observer 运行期间正文变化，或章节归属、章序不一致。
- `TARGET_CHAPTER_OUT_OF_RANGE`：回溯目标不存在；客户端传入的影响列表不会被信任。
- `RESETTLEMENT_ORDER_VIOLATION` / `NON_CONTIGUOUS_SETTLEMENT`：拒绝跳过最早待重结算章或跨越未结算缺口。
- `PROJECT_NOT_FOUND`：IPC 项目 ID 不在工作区项目白名单内。
- Zod 在文件对话框和数据库写入前拒绝非法格式、空项目 ID、负数/非有限章号及畸形回溯计划。
- 文件目标只能来自 Electron 保存对话框；没有增加遥测、网络调用或密钥处理。
- `BOOK_BUSY` 租约在最终事务内再次校验 owner/token/存活性；任一心跳失败会让本次运行不可提交。

## 回退方式

本批迁移为向后兼容增量列/表，回退应用代码时不要删除新表或新列。启动时会保留一次性 v4 前备份；旧代码会忽略新结构。若需要撤销某次业务回溯，应从备份恢复数据库，而不是手工改写 closure 行或失效标记。

不建议直接删除 `story_project_ledgers` 或清零版本；这会破坏结算 CAS 与投影版本关联。

## 验证记录

- `pnpm run typecheck`：退出 0。
- `pnpm test`：pretest 20/20；标准测试 237/237。
- `pnpm eval`：133/175 结算成功；42/42 硬矛盾拒绝；伏笔回收 2/3；Observer 故障恢复 3/4。
- `pnpm build`：main 801 个模块、preload、renderer 生产构建成功。
- 已观察到的非阻塞既存警告：两处 `eval` 构建警告、Vite 动静态混合导入提示及第三方 PURE 注释提示。

## 尚未完成

- 尚未在真实旧项目中通过 UI 实际执行 JSON/Markdown 保存、回溯预览、回溯确认与重结算提示；需要人工验收。
- 尚未实现投影后台缓存、临时文件原子替换和 dirty 自动刷新；当前导出按请求从 SQLite 即时再生。
- P2 的完整 Task Contract、固定/可压缩/按需槽位和统一 Context Manifest 尚未实施。
- P3 的三轨工作流生产切流、统一 run ID 与跨运行 transcript 重放尚未实施。
