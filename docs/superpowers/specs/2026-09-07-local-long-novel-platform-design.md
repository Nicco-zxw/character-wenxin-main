# CharacterArc 本地长篇小说创作平台优化设计

> 日期：2026-09-07  
> 状态：已评审  
> 基础项目：CharacterArc v1.15.5  
> 参考项目：InkOS v1.7.2 的长篇小说设计模式

## 1. 目标与边界

本次优化保留 CharacterArc 的 Electron、Vue、TypeScript、SQLite 与现有编辑器架构，通过渐进式收口建立统一的长篇小说创作内核。核心目标是让长篇创作具备可追溯的叙事记忆、可预算的上下文、可恢复的 AI 执行过程，以及稳定的三轨创作编排。

只参考 InkOS 的长篇小说能力，包括结构化运行时状态、章节生产管线、上下文治理、状态校验、章节快照、写锁、会话记录和剧情推演。明确排除互动世界、互动影视、翻译、短篇、封面、通知、平台部署等模块。

不直接依赖或整体移植 `@actalk/inkos-core`。InkOS 使用 AGPL-3.0-only，而 CharacterArc 使用 MIT；本项目只吸收可独立实现的架构思想，不复制其实现代码。该约束同时避免把 CLI/Studio 多包架构强行嵌入 Electron 主进程。

所有变更必须满足以下约束：

- 向后兼容现有项目、章节、角色、知识库、结算记录和版本历史。
- SQLite 是唯一真相源；JSON 和 Markdown 只是带版本的可再生投影。
- 小步接线、项目级开关灰度、每阶段可独立回退。
- 不引入分析遥测或额外网络调用；仅复用用户显式配置的 AI Provider。
- 不保存 API Key、鉴权头或模型隐性思维链。

## 2. 现状审计

### 2.1 已有能力

CharacterArc 已经具备本设计的大量基础模块：

| 目标域 | 已有实现 | 结论 |
|---|---|---|
| 结构化真相 | `electron/main/story-state-store.ts` 包含角色状态、关系、伏笔、时间线、世界规则、倒计时、章摘要和向量索引 | 可复用，需统一版本与时序契约 |
| 结算闭环 | `ai/settlement/index.ts` 已实现 Observer 输入、L0/L1 Validator、Arbiter、Reducer、快照、写锁和结算账 | 可复用，需扩大事务边界并统一运行记录 |
| 历史查询 | 角色与关系已采用 `valid_from_chapter / valid_until_chapter`，支持任意章点查询 | 部分完成，其他状态类型需统一时序语义 |
| 可再生投影 | `buildTruthProjectionMarkdown` 与 `truth-export` IPC 已存在 | 只有 Markdown；缺统一 JSON 投影、自动刷新和 UI 入口 |
| 上下文构建 | `runtime-v2/context-builder.ts` 已支持 Provider、优先级、压缩、占位符和工具补载提示 | 缺固定槽位硬保护、任务槽位契约和全路径 trace |
| 执行护栏 | Agent 最大步数、工具同参去重、输出合成、JSON 修复、Zod 输出 Schema 已存在 | 分散在两套 Runtime；输入 Schema 与 ID 作用域未统一 |
| 故障重放 | `runtime-v2/conversation-manager.ts` 已持久化 Session、Turn、Event、暂存变更和可续跑状态 | 只覆盖 Runtime v2，会话外 AI 任务与章节工作流未统一接入 |
| 三轨编排 | 共享章节顺序器、AgentProfile、反射循环、局部改写、spiral seam、forecast 存储和采用备忘已存在 | 多处默认关闭，主进程闭环未成为生产唯一入口 |

### 2.2 已验证基线

- `pnpm test`：229/229 通过。
- `pnpm eval`：通过现有门禁；生成式语料结算 133/175、硬矛盾拒绝 42、伏笔回收 2/3、Observer 故障恢复 3/4。
- `pnpm run typecheck`：当前环境失败，原因是已安装依赖中缺少 `node_modules/vue-tsc/bin/vue-tsc.js`，属于依赖环境损坏而非已确认的源码类型错误。P0 先执行锁文件约束下的依赖恢复，再建立可信类型基线。

### 2.3 主要缺口

1. “已有文件”尚未形成一个统一的 Narrative Engine；旧 Runtime、Runtime v2、渲染层章节流和结算流仍有语义分叉。
2. 当前真相类型主要依赖 TypeScript 接口和防御性 normalize，缺少覆盖输入、增量、快照、投影的统一运行时 Schema。
3. 角色和关系时序较完整，但伏笔、世界规则、倒计时、认知、资源等没有统一的历史有效期与证据归因模型。
4. 上下文压缩按优先级执行，没有“固定槽位永不压缩、超限即失败”的硬边界；结算 trace 也不能代表所有 AI 任务实际输入。
5. `ai_runs`、`assistant_events`、反射 transcript、结算账和章节步骤记录彼此割裂，不能通过一个 run ID 完整重放。
6. 主进程章节闭环、AgentProfile、复审、humanize 和 spiral 反射能力仍受默认关闭的常量或独立入口控制，尚未完成生产切流。
7. 当前结算失败虽可回滚，但正文提交、状态应用、摘要、索引失效和运行终态没有形成跨模块的一致提交协议。

## 3. 总体架构

新增“受治理叙事内核”作为主进程内部应用层，不改变渲染层直接访问规则：渲染层仍只通过 preload/IPC 调用主进程，所有文件、SQLite 和 AI Provider 操作仍留在主进程。

内核由五个边界清晰的组件组成：

1. **Narrative Memory**：维护五层叙事记忆、时序查询、投影与回滚。
2. **Task Contract Registry**：声明任务输入、上下文槽位、预算、工具权限、输出 Schema 和持久化权限。
3. **Context Compiler**：根据任务契约组装固定、可压缩和按需上下文，并产生可审计清单。
4. **Reliable Executor**：统一输入校验、AgentLoop、结构修复、写锁、事务和 transcript。
5. **Creation Orchestrator**：执行单章闭环、反射迭代和隔离推演三条轨道。

现有 `TaskHandler`、Context Provider、settlement、ConversationManager、AgentProfile 和 forecast 模块通过适配器逐步接入；适配完成前旧入口保留，切流后删除重复路径。

## 4. 五层叙事记忆引擎

### 4.1 五层定义

| 层 | 名称 | 内容 | 权威性与生命周期 |
|---|---|---|---|
| M0 | 创作宪法 | 作者意图、世界硬规则、题材禁写项、叙事视角、长期风格约束 | SQLite 权威；固定上下文，不可被局部任务覆盖 |
| M1 | 时序真相账本 | 角色、关系、位置、资源、身体/情感、角色认知、世界规则、时间线、伏笔、倒计时 | SQLite 权威；按章节生效区间版本化 |
| M2 | 情节事件记忆 | 章节摘要、结算事件、状态 Delta、正文版本、回滚快照、采用记录 | Append-only 事件为主；支持重建 M1 |
| M3 | 证据检索记忆 | 章节片段、事实证据、关键词和向量索引、来源内容哈希 | 可重建索引；查询必须检查来源版本和有效期 |
| M4 | 任务工作记忆 | 任务槽位、当前章材料、工具结果、工作流状态、会话事件和恢复点 | 可丢弃重建；通过 run ID 审计与重放 |

M0–M4 是读取与生命周期分层，不代表五个可互相写入的真相源。所有权威数据仍在同一个 SQLite 工作区数据库中。

### 4.2 统一状态契约

为每类状态定义 Zod Schema，并由其推导 TypeScript 类型。Schema 覆盖：

- `NarrativeDelta`：Observer 只能提交候选差量，不能提交全量覆盖文件。
- `NarrativeSnapshot`：指定 `projectId / ledgerVersion / atChapter` 的一致快照。
- `NarrativeEvent`：包含 `eventId / runId / actor / chapterIndex / evidenceRefs / occurredAt`。
- `ProjectionEnvelope`：包含 Schema 版本、账本版本、生成时间、源哈希和投影内容。
- `RollbackPlan`：列出目标章、受影响事件、摘要、索引、推演和需要重新结算的章节。

所有实体 ID 必须通过项目作用域白名单解析，Observer 不得自行创建已存在实体的新 ID。确需新增角色或伏笔时，由受控的 create operation 分配 ID，并记录原文证据。

### 4.3 Observer–Reducer–Validator–Arbiter 闭环

章节最终正文进入以下闭环：

1. **Observer** 从正文提取带证据位置的 `NarrativeDelta`；输出先经 Schema 校验和字段钳制。
2. **Validator** 对照 `baseLedgerVersion` 的 M0/M1/M2 快照执行确定性规则，再按策略执行语义对账。问题分为 `critical / warning / hint`，并携带规则 ID 和证据。
3. **Arbiter** 是纯函数状态机，只能返回 `apply / apply_with_warning / retry_observer / reject / skip`。Observer 最多自动重试一次，避免无界循环。
4. **Reducer** 以不可变语义把已裁决 Delta 应用于类型化状态；同一 `eventId` 必须幂等。
5. **Committer** 在 SQLite 事务内写 M1 状态版本、M2 事件、章节摘要、结算终态和索引失效标记。任一步失败则整笔回滚。

Observer 和可选语义校验可在锁外运行，但必须绑定 `baseLedgerVersion`。提交前获取章节级租约锁并重新比较版本；版本变化时返回 `STALE_BASE_VERSION`，重新读取后校验，不能用旧快照覆盖新状态。

### 4.4 伏笔与跨章节回溯

伏笔状态使用 `planted → progressing/deferred → resolved/abandoned` 生命周期，记录首次埋设章、最近推进章、预期回收窗口、实际回收章、证据和责任事件。Validator 检查不存在伏笔的回收、重复埋设、无证据推进、逾期未处理和回收后再次激活。

任意章节支持两种操作：

- **只读时间旅行**：按生效区间重建第 N 章结算后的 M0–M3 视图，不改变当前状态。
- **恢复到第 N 章**：保留后续章节正文和正文版本，但把 N 章之后的结算事件、状态版本、摘要、索引和 forecast 标记为失效；这些章节进入 `needs_resettlement`。重新审计和结算完成前禁止继续生成后续章节。

失效采用逻辑标记，不直接删除历史数据，保证审计和恢复可逆。

### 4.5 JSON / Markdown 双投影

每次成功结算、回滚或迁移后，把项目投影标记为 dirty，由投影器生成：

- JSON：完整机器可读快照，供 Agent、导出和诊断使用。
- Markdown：当前真相、角色状态、伏笔、时间线与章节摘要的人类可读视图。

两种投影都包含 `ledgerVersion` 和 `sourceHash`。内部缓存写入 `userData` 下的项目投影目录时采用临时文件加原子重命名；用户也可以通过 UI 导出。启动时若版本或哈希不匹配，直接从 SQLite 重建。任何导入、上下文构建和结算逻辑都不得把投影读回为权威数据。

## 5. 上下文治理

### 5.1 Task Contract

每个 AI 任务注册版本化契约，至少声明：

- 任务 ID、任务版本、允许的 Surface 和项目作用域。
- 输入 Zod Schema 与字段钳制规则。
- 上下文槽位、槽位来源、层级、优先级、是否必需。
- 总输入预算、固定预算、可压缩预算、工具调用预算、输出预算和最大步骤。
- 工具白名单、输出 Schema、修复次数和持久化权限。
- 失败策略及是否允许恢复。

旧 `TaskHandler` 在迁移期由适配器包装为 Task Contract，避免一次性重写所有任务。

### 5.2 三类上下文槽位

1. **fixed**：系统创作指令、M0、关键 M1 真相、当前任务硬约束。禁止压缩、截断和占位；总量超过保留预算时返回 `CONTEXT_PROTECTED_OVERFLOW`。
2. **compressible**：近期章节摘要、相关角色历史、检索证据和风格样本。按任务相关度、时效和证据强度排序，可使用确定性裁剪或带版本缓存的语义摘要。
3. **on_demand**：完整远期章节、大型设定文档、低相关历史和完整工具结果。初始 Prompt 只放轻量占位符和逻辑引用，Agent 通过白名单读取工具按需加载。

每个槽位保存 `slotId / sourceRef / sourceVersion / contentHash / tier / selectionReason / estimatedTokens / actualTokens / compression / loadedByTool`，从而能回答“本次创作实际看到了什么”。

### 5.3 预算算法

预算按以下顺序分配：

1. 预留模型输出和工具循环预算。
2. 装载全部 fixed 槽位；超限立即失败。
3. 为任务必要的 compressible 槽位分配最小额度。
4. 按相关度和优先级分配剩余额度。
5. 将未装载内容转换为 on-demand 引用。

Token 预估保留当前中英文启发式作为离线兜底，同时通过 Provider 返回的实际 usage 校准任务级倍率。模型切换后按 Provider 和模型分别统计，不能使用一个全局固定字符比。

### 5.4 可审计输出

Context Compiler 输出两份结果：实际 Prompt Context 和 `ContextManifest`。后者落入统一 Run Manifest，记录所有入选、压缩、占位、遗漏和工具补载。现有 `context_traces` 迁移为该模型的兼容投影，不再只记录结算时的六类 story context。

## 6. 五层 Reliability 护栏

### 6.1 R1 输入层

- 所有 IPC、任务、工具和状态 Delta 使用 Zod Schema；拒绝未知危险字段。
- 对章节号、字数、温度、Token、循环次数、分支数和文本长度执行明确上下界钳制。
- ID 必须存在且属于当前项目/章节作用域；工具只接收解析后的内部 ID。
- 路径参数使用现有安全路径工具并限制在用户选择或项目目录内。
- 非法输入在任何模型调用和数据库写入前失败。

### 6.2 R2 执行层

- 每个任务限制最大步骤、总工具调用数、单工具调用次数、墙钟时间和 Token。
- 对 `toolName + canonicalArgs + sourceVersion` 计算指纹；同一运行内同参调用只回放缓存结果，不重复执行。
- 工具按任务白名单暴露；读工具和写工具分离，写工具只能产生 staged change。
- 模型 reasoning 与业务状态隔离；只有显式最终输出、工具调用、工具结果和可见评价摘要进入后续步骤。
- 支持 AbortSignal；取消后禁止继续提交迟到结果。

### 6.3 R3 输出层

- 先执行确定性 JSON 清洗和截断恢复，再执行 Schema 校验。
- 结构错误最多触发两次针对性修复，每次都记录原错误和修复结果。
- Agent 步数耗尽且无有效正文时，禁用工具执行一次最终合成；仍为空则返回明确错误。
- 文本任务也执行最低长度、截断、重复、正文污染和任务特定质量门。
- 未通过最终 Schema 或质量门的结果不能进入持久层。

### 6.4 R4 持久层

- 使用 `BOOK_BUSY` 租约锁，默认 30 秒心跳、3 分钟租约；owner/token 不匹配时禁止续约或释放。
- 锁 scope 至少包含项目和章节，工作流跨越多章时逐章获取，避免长时间锁整本书。
- 所有正史写入必须通过 Committer，并在一个 SQLite 事务内完成。
- 事务提交前再次校验账本版本、正文版本和运行状态。
- 结算失败、锁丢失、版本过期或用户取消均拒绝落盘。
- 快照、事件账和逻辑失效支持版本回滚及异常恢复。

### 6.5 R5 故障层

统一 `runId` 串联任务、Context Manifest、模型配置摘要、工具事件、输出修复、工作流步骤、结算事件和状态版本。Transcript 为 append-only 事件流，至少支持：

- UI 刷新后重建运行视图。
- 应用崩溃后识别 `running` 的孤儿运行，并转为 `recovery_required`。
- 从最近安全恢复点继续尚未产生正史写入的任务。
- 以 dry-run 方式重放输入、上下文选择、工具结果和状态机决策。
- 导出脱敏审计包，用于复现故障。

重放默认使用已记录的模型输出和工具结果，不重新调用模型；用户显式选择“重新执行”时创建新的 run，并通过 `parentRunId` 关联原运行。

统一错误码至少包括 `INPUT_INVALID`、`ID_OUT_OF_SCOPE`、`CONTEXT_PROTECTED_OVERFLOW`、`CONTEXT_BUDGET_EXHAUSTED`、`STEP_LIMIT_REACHED`、`OUTPUT_INVALID`、`BOOK_BUSY`、`STALE_BASE_VERSION`、`SETTLEMENT_REJECTED` 和 `RECOVERY_REQUIRED`。

## 7. 三轨式 AI 创作编排

### 7.1 共享运行内核

三条轨道共享 Task Contract、AgentProfile、Context Compiler、Reliable Executor、Run Manifest、取消/恢复协议和错误码，但具有不同的写入权限。

AgentProfile 按角色配置 Provider 可用模型、温度、输出预算、推理等级和任务超时。默认档位不擅自切换模型；项目显式配置才能覆盖模型。配置保存前校验与当前 Provider 的兼容性，并提供回退到全局模型的明确提示。

### 7.2 轨道一：单章生产闭环

生产状态机为：

`planning → drafting → auditing → revising → re_auditing → finalizing → settling → completed`

规则如下：

- Planner 产出本章目标、must-keep、must-avoid、伏笔动作和场景节拍。
- Writer 只接收经 Context Compiler 编译的材料。
- Auditor 输出结构化问题和证据；critical 问题触发 Reviser。
- 修订后必须复审，自动修订次数由任务契约限制，默认一次。
- 最终正文只有在质量门通过后才提交；正文提交后立即针对同一正文版本执行结算。
- 正文与结算共享最终内容哈希。结算失败时保留正文版本但标记 `settlement_required`，禁止把它作为下一章已确认真相。
- 每个步骤记录独立 AgentProfile、usage、Context Manifest、输入/输出哈希和终态。

现有渲染层六步交互保留外观，但步骤决策迁移到主进程共享状态机；渲染层只订阅状态和提交用户选择，不再维护第二套编排语义。

### 7.3 轨道二：反射式 AgentLoop

用于大纲生成、局部改写、humanize 和需要开放式迭代的 spiral 扩写。统一协议为：

`Act → Deterministic Gate → Optional Semantic Judge → Critique → bounded retry`

- 优先使用确定性退化门，只有无法确定质量时才调用语义评价，控制成本。
- 大纲默认最多三轮，局部改写和 humanize 默认最多两轮。
- 每轮输入、输出、分数和 critique 都进入 transcript。
- 达到轮数仍未通过时返回最佳候选和未解决问题，不能假装成功。
- 局部正文修改先生成 staged change，由作者采用后写入；采用后触发受影响章节的重新审计与结算。

### 7.4 轨道三：隔离式单 Agent 推演

推演基于固定的 `baseLedgerVersion + chapterContentHash` 生成 2–5 条候选后续。所有分支只写 forecast 域，不能调用正史写工具，不能产生 M1/M2 状态事件。

每条候选包含核心决策、节拍、角色影响、伏笔影响、风险、与作者意图的适配度以及来源快照。正史推进导致基础版本过期时，候选自动标记 stale，但保留审计记录。

“采用”只生成下一章 Planning Memo 并预填给作者；作者确认后由轨道一重新编译上下文。采用动作本身不能直接更新人物状态、伏笔或章节正文。

## 8. 数据与持久化演进

采用扩展现有表与少量新表的方式，不重建整个数据库：

- 扩展 `ledger_manifest`：账本单调版本、最近完整结算章、投影版本和迁移状态。
- 补齐各 `story_*` 表的生效区间、`source_event_id`、`actor` 和内容哈希；保留现有类型化表，不改为泛型 EAV。
- 扩展 `settlement_runs`：`base_ledger_version / committed_ledger_version / content_hash / run_id`。
- 建立统一执行运行与事件记录，现有 `ai_runs`、`assistant_turns/events` 和反射 transcript 通过兼容适配器关联，不立即删除。
- 为工作流步骤、Context Manifest 和恢复点建立独立的窄表，避免把所有信息塞入一个超大 JSON 字段。
- 保留 `chapter_versions`、`settlement_snapshots` 和 forecast 表；通过版本关联与逻辑失效支持级联回溯。

迁移必须幂等，并在事务中执行。启动前保存数据库备份；迁移失败时继续使用旧引擎只读打开项目，并在恢复中心显示错误，不允许半迁移状态继续写入。

## 9. 产品界面

首版只增加四个与可靠性直接相关的入口：

1. **真相账本检查器**：查看当前状态、任意章点状态、来源事件和 JSON/Markdown 导出。
2. **上下文检查器**：展示本次任务的固定、可压缩、按需槽位与 Token 决策。
3. **工作流时间线**：展示规划、写、审、改、复审、结算各步骤和失败原因。
4. **恢复中心**：查看孤儿运行、回滚计划、需要重新结算的章节和 transcript 重放。

这些入口复用现有 Chapter Workspace、AI 进度和结算状态 UI，不在本期重做整体视觉系统。

## 10. 分阶段实施

### P0：基线与兼容外壳

- 用锁文件恢复依赖，建立类型检查基线。
- 固化现有 229 项测试和离线评测结果。
- 增加旧数据库迁移样本与备份/恢复测试。
- 建立项目级功能开关和旧接口适配层。

### P1：五层记忆与原子结算

- 落地统一 Schema、账本版本和证据引用。
- 补齐状态时序语义、伏笔生命周期和任意章点查询。
- 收紧 Observer–Reducer–Validator–Arbiter 事务边界。
- 实现 JSON/Markdown 双投影与级联失效回溯。

### P2：上下文与 Reliability 底座

- 落地 Task Contract 和三类槽位。
- 实施 fixed 硬保护、分层 Token 预算和按需加载。
- 统一输入、执行、输出、持久和故障防护。
- 用一个 run ID 串联 Context Manifest 与 transcript。

### P3：三轨编排生产接线

- 把章节闭环迁移到主进程状态机并启用复审。
- 把大纲、局部改写、humanize、spiral 接入统一反射协议。
- 把 forecast 绑定固定快照并校验正史隔离。
- 把 AgentProfile 改为项目级可验证配置。

### P4：产品收口与旧路径下线

- 接入四个最小审计/恢复界面。
- 完成旧库、长篇 5/50/200 章和真实模型走查。
- 按项目灰度切流；稳定后删除重复的渲染层编排和旧 Runtime 路径。
- 更新用户文档、故障处理手册和架构文档。

## 11. 测试与验收

### 11.1 自动测试

- **Schema/Reducer 单测**：非法输入、钳制、幂等事件、时序关门、伏笔状态机和投影确定性。
- **Context Compiler 单测**：固定槽位不压缩、超限失败、压缩优先级、占位符、按需补载和来源哈希。
- **Executor 单测**：最大步骤、工具同参去重、取消、JSON 两轮修复、步数耗尽合成和错误码。
- **事务故障注入**：在快照、Reducer、摘要、索引和记账各点抛错，验证数据库无部分写入。
- **锁测试**：竞争、续约、进程崩溃、过期抢占、owner/token 校验和锁丢失拒绝提交。
- **重放测试**：给定 transcript 可重建同一运行视图和状态机决策，且不会重新调用模型。
- **迁移测试**：从现有 Schema、缺列旧库和异常中断迁移恢复。
- **三轨权限测试**：轨道二未采用不得写正文，轨道三任何路径不得写正史表。

### 11.2 产品级验收

- 非法输入写入率为 0。
- 结算失败、锁丢失或版本冲突后的正史状态变更为 0。
- fixed 上下文被压缩次数为 0；预算不足必须产生明确错误。
- 同一 run 内相同参数、相同来源版本的工具重复执行次数为 0。
- 任意章点状态可重建；恢复到第 N 章后所有下游数据正确失效并可重新结算。
- JSON 与 Markdown 投影的 `ledgerVersion/sourceHash` 一致，删除投影后可完全重建。
- UI 刷新可恢复运行视图；模拟崩溃后可识别并恢复或终止孤儿运行。
- 5 章与 50 章项目均不超过任务配置预算；增长内容通过检索或占位按需加载，而不是线性全量注入。
- 轨道一完成“规划—写—审—改—复审—最终结算”；轨道二有界收敛；轨道三保持正史隔离。

每阶段结束运行最快相关单测，再运行 `pnpm test`、`pnpm run typecheck` 和 `pnpm eval`。涉及 UI、Provider 或 Electron 生命周期的改动必须补充 `pnpm dev` 人工走查记录。

## 12. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 新旧 Runtime 过渡期语义分叉 | Task Contract 和主进程状态机作为唯一决策源；旧入口只做适配 |
| 时序迁移破坏存量数据 | 迁移前备份、幂等迁移、旧库样本测试、失败只读打开 |
| 固定上下文过大导致任务频繁失败 | 在 M0/M1 写入阶段限制单条尺寸，并在上下文检查器明确展示占用，不静默压缩 |
| 语义校验增加成本和延迟 | 确定性规则优先；语义校验按风险和任务策略启用 |
| 长任务锁租约丢失 | 心跳看门狗、提交前 owner/token 与账本版本双校验 |
| 回滚早期章节造成下游漂移 | 先展示 RollbackPlan，逻辑失效所有下游派生数据并强制重新结算 |
| transcript 泄露敏感信息 | 写入前脱敏；不记录密钥、鉴权头和隐性思维链；审计导出再次过滤 |
| 直接借用 InkOS 带来许可证风险 | 只参考行为与架构，自主实现并保留设计来源说明 |

## 13. 设计结论

本方案不推倒 CharacterArc 已有成果，也不把 InkOS 作为运行时依赖。实施重点是把目前分散且部分关闭的能力收敛为统一的长篇小说创作内核：以 SQLite 时序真相账本为核心，以任务契约治理上下文，以五层可靠性保障执行和恢复，再由同一编排底座承载章节生产、反射迭代和隔离推演。

完成后，CharacterArc 的关键能力不再以“某个模块或测试存在”为完成标准，而以生产路径唯一、状态可回溯、输入可审计、失败不半写、运行可重放和旧项目可迁移为完成标准。
