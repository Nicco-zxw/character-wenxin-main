# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager: `pnpm` (pinned to 10.33.2 in `package.json`). Scripts shell out via Windows `set` syntax — on macOS/Linux replace `set ELECTRON_RUN_AS_NODE=&&` with `cross-env ELECTRON_RUN_AS_NODE= ` or strip the prefix.

```powershell
pnpm install          # install deps (uses npmmirror via .npmrc)
pnpm run dev          # electron-vite dev: starts main + preload + renderer (Vite on 127.0.0.1, port auto-selected)
pnpm run build        # vue-tsc --noEmit (full type check) then electron-vite build
pnpm run preview      # run the production build locally
pnpm run dist         # type check + build + electron-builder (Windows NSIS installer)
```

There is no test runner, linter, or formatter configured. "Build = type check" — `vue-tsc --noEmit` is the only static gate, and `pnpm run build` will fail loudly on TS errors. Run it before declaring work done.

## Architecture

CharacterArc is an Electron 37 + Vue 3.5 + TypeScript desktop app for novel writing. Three processes, three roots:

- `electron/main/` — Node main process: SQLite, AI pipeline, IPC handlers, file I/O
- `electron/preload/` — context-bridge surface exposed as `window.characterArc`
- `electron/shared/` — types shared across process boundaries (`@shared/*` alias)
- `renderer/src/` — Vue 3 + Pinia + Naive UI + TipTap (`@/*` alias → `renderer/src/*`)

Build outputs land in `dist-electron/{main,preload}` and `out/renderer`. Entry is `dist-electron/main/index.js` (see `package.json#main`).

### Data flow

The renderer **never** touches the filesystem or AI providers directly. Everything goes through IPC:

1. App boot (`renderer/src/main.ts`) creates Pinia, calls `useAppStore().initialize()`, which IPC-loads the workspace snapshot from SQLite, then `app.mount('#app')`.
2. Edits mutate the Pinia store (`renderer/src/stores/app.ts`); a debounced persistence layer (`renderer/src/features/workspace/persistence.ts`) writes back via `window.characterArc.saveWorkspace` / `saveAppSettings`.
3. Main holds `latestWorkspaceSnapshot` in memory for AI tasks to read; on `before-quit` it flushes one last time.
4. The renderer-side `characterArc` API and the main-side IPC channels share names like `characterarc:*`. `IPC_CHANNELS` in `electron/shared/ipc-types.ts` is *partial* — most channel names are still string literals on both sides.

### SQLite (workspace store)

`electron/main/workspace-store.ts` uses Node's built-in `node:sqlite` (`DatabaseSync`), not better-sqlite3 — node ≥18 with the experimental flag, or the bundled Electron Node. Schema is created idempotently via `CREATE TABLE IF NOT EXISTS` on first `ensureWorkspaceDb()` call. Tables include `projects`, `worldview_entries`, `characters`, `organizations`, `character_relationships`, `organization_memberships`, `inspiration_entries`, `outline_volumes`, `outline_items`, `chapters`, `chapter_versions`, `ai_messages`, `knowledge_documents`, `reference_works`, `ai_runs`, `workflow_documents`, `plot_threads`, `app_settings`, `cover_workbench_history`, `assistant_sessions`. Story-state tables are initialized separately in `story-state-store.ts`.

The DB lives under `<userData>/data/workspace.db`. `configureCanonicalUserDataPath()` migrates legacy `characterarc/` userData to `CharacterArc/` on first launch — preserve this path discipline if you touch boot code.

### AI pipeline (`electron/main/ai/`)

The core dispatch is in `ai/runtime/orchestrator.ts`:

- `runAiTask(task, knowledgeContext, signal)` — non-streaming. Routes to **agent loop** if `task.task ∈ AGENT_TASK_WHITELIST` (currently `outline-batch`, `reference-deep-analyze`, `style-fingerprint-extract`, `global-assistant`) **and** the provider supports `tool_use`; otherwise falls through to the single-shot path.
- `streamAiTask(task, handlers, signal, knowledgeContext)` — streaming. Only enabled for `chapter-assistant`, `global-assistant`, `chapter-first-draft`, `chapter-memo`, `chapter-audit`.
- `runAgentTask` (`ai/agent/`) drives the AI SDK `streamText` loop with progressive skill disclosure, capped at `maxSteps = 8`.

Both paths share: settings normalization (`ai/settings.ts`), skill resolution (`ai/skills/task-selection.ts`), prompt assembly (`ai/runtime/context-builder.ts` + `ai/prompts/`), task handler lookup (`ai/tasks/index.ts` registry), JSON normalize/validate with up-to-2-attempt repair loop, and run metadata (`ai/runtime/run-meta.ts`) emitted via `emitAiRunEvent`.

Each task type is a `TaskHandler` (see `ai/tasks/base.ts`) registered in `ai/tasks/index.ts`. **To add a new AI task: implement `buildPrompt`/`normalize`/`validate`, register it, add a Zod schema in `ai/tasks/object-schemas.ts` if `outputType: 'json'`, and (optionally) add it to `AGENT_TASK_WHITELIST` once tool-use is desired.**

Provider abstraction (`ai/provider.ts`) wraps `@ai-sdk/openai` and `@ai-sdk/anthropic`. Anthropic requests automatically attach `cacheControl: { type: 'ephemeral', ttl: '5m' }` to the system prompt. `providerSupportsTools` returns false for DeepSeek and Ollama — that gates agent-loop routing.

After `chapter-first-draft` returns, `runPostGenerationPipeline` asynchronously: (1) extracts a `StateDelta` via a second LLM call, (2) runs `runLightCheck` against the pre-state, (3) persists the delta into the story-state DB, (4) builds vector index segments via `indexChapterSegments`. Failures here surface as warnings emitted on `characterarc:chapter-post-generation-issues`, not as task failures.

### Skills system (`electron/main/ai/skills/`)

Skills are markdown packages with YAML frontmatter discovered from two roots:

- **builtin**: `resources/skills/<group>/<skill-id>/SKILL.md` — bundled with the app (28 skills across 3 groups currently)
- **project**: `<userData>/project-skills/<projectId or _shared>/<skill-id>/SKILL.md` — per-project imports

`scanSkillsFromDisk` merges them (project overrides builtin by id). The registry (`registry.ts`) is initialized once on `app.whenReady` via `initSkillRegistry()` and refreshed when projects change. `pickSkillsFor(task, candidates)` does heuristic matching; `resolveTaskSkills` returns the final list capped by `TaskHandler.maxSkills` (default 4).

In agent-loop mode, **required** skills are inlined into the system prompt; optional skills appear in the index and the model loads them on demand via the `skill_load` tool. Only `scope === 'builtin'` skills can execute scripts (see `agent/tools/skill-tools.ts`).

### Renderer organization

- `renderer/src/pages/` — top-level routed views (`ProjectCenter`, `WorkbenchPage`, `ChapterStudioPage`, `CoverWorkbenchPage`, `DeconstructionLibraryPage`, `ProjectWizardPage`, `SkillsPage`)
- `renderer/src/features/` — feature modules (ai, chapters, cover, knowledge, relations, projects, projectSkills, novelWorkflow, inspiration, settings, wizard, workspace, writingStyles, announcements). Each owns its types, helpers, and (sometimes) sub-stores.
- `renderer/src/stores/app.ts` — single top-level Pinia store; most domain logic delegates to feature-module helpers
- `renderer/src/components/chapterWorkspace/` — three-pane chapter editor (TipTap)
- `renderer/src/composables/` — Vue composables, including `useGlobalAssistant` for the cross-page AI assistant panel
- `renderer/src/theme/` + `styles/` — design tokens and global CSS

### IPC channel conventions

All channels are namespaced `characterarc:*`. Main-side handlers split between two files:

- `electron/main/register-main-ipc.ts` — workspace, files, exports/imports, reference deconstruction, project-skills, sessions, updates
- `electron/main/ai/ipc.ts` — AI generate/stream/agent/cancel, model probing, image generation, story-state

The preload (`electron/preload/index.ts`) exposes a flat `window.characterArc` object via `contextBridge`. Every payload is JSON-cloned through `toIpcPayload` to strip non-serializable values before crossing the bridge.

## Things to know

- Path aliases in `tsconfig.json` and `electron.vite.config.ts` must stay in sync: `@/* → renderer/src/*`, `@shared/* → electron/shared/*`. Main and preload only have `@shared`; renderer has both.
- `@node-rs/jieba` is externalized in the main rollup config and `asarUnpack`-ed in `electron-builder` config — it's a native module used by `knowledge-retrieval.ts` for Chinese tokenization.
- The renderer's `vue-tsc --noEmit` covers `electron/`, `renderer/`, and `electron.vite.config.ts` — all three trees share one `tsconfig.json`.
- The app is shipped Windows-only via NSIS (`build/installer.nsh`, `resources/icon.ico`). `package.json#scripts` use `set ELECTRON_RUN_AS_NODE=` which is cmd/PowerShell syntax.
- User-facing strings, comments, and AI prompts are in Chinese. Match that style when editing or adding content in this codebase.
