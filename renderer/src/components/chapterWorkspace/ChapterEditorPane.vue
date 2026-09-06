<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Check, ChevronDown, ChevronRight, Folder, FocusIcon, History, Maximize2, Menu, MessageSquareQuote, Minus, Minimize2, Plus, RefreshCw, Settings2, ShieldAlert, Sparkles, Type, Wand2 } from 'lucide-vue-next'
import { NAlert, NButton, NDropdown, NInput, NInputNumber, NModal, NSwitch, NTag, NTooltip, useDialog, useMessage } from 'naive-ui'
import type { DropdownOption } from 'naive-ui'
import SimpleChapterEditor from './SimpleChapterEditor.vue'
import type { ChapterRecoverySnapshot } from './SimpleChapterEditor.vue'
import ChapterVersionDialog from './ChapterVersionDialog.vue'
import EditorFindBar from './EditorFindBar.vue'
import EditorContextMenu from './EditorContextMenu.vue'
import { getChapterCharacterCount, getPlainTextFromEditorContent } from '@/features/chapters/editorContent'
import { editorFontOptions, getEditorFontOption, isEditorFont } from '@/features/chapters/editorTypography'
import { formatChapterWordTargetLabel, parseChapterWordTarget } from '@/features/chapters/wordTarget'
import { formatVolumeLabel } from '@/features/workspace/outlineVolumes'
import { useAppStore } from '@/stores/app'
import { toIpcPayload } from '@/utils/ipcPayload'

defineProps<{
  aiOpen: boolean
  focusMode: boolean
  showSidebarToggle?: boolean
}>()

const emit = defineEmits<{
  toggleAi: []
  toggleFocus: []
  toggleSidebar: []
  selectionAction: [action: string, text: string]
  generateDraft: []
  useAdoptionMemo: [text: string]
}>()

const appStore = useAppStore()
const message = useMessage()

const FONT_LEVELS = [14, 15, 16, 17, 18, 20, 22]
const fontIdx = ref(3)
const fontSize = computed(() => FONT_LEVELS[fontIdx.value])
const versionDialogVisible = ref(false)

const currentEditorFont = computed(() => getEditorFontOption(appStore.appSettings.editorFont))
const editorFontMenuOptions = computed<DropdownOption[]>(() =>
  editorFontOptions.map((option) => ({
    key: option.id,
    label: () => h(
      'span',
      {
        style: {
          display: 'inline-flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: '24px',
          width: '170px',
          fontFamily: option.fontFamily
        }
      },
      [
        h('span', option.label),
        h('span', { style: { color: 'var(--arc-text-hint)', fontSize: '12px' } }, '“引号”')
      ]
    ),
    icon: () => h(Check, {
      size: 14,
      style: { opacity: option.id === currentEditorFont.value.id ? '1' : '0' }
    })
  }))
)

function selectEditorFont(key: string | number): void {
  if (isEditorFont(key)) {
    appStore.updateAppSetting('editorFont', key)
  }
}

function stepFont(delta: number): void {
  const next = Math.max(0, Math.min(FONT_LEVELS.length - 1, fontIdx.value + delta))
  fontIdx.value = next
}

const currentChapter = computed(() => appStore.selectedChapter)
const currentVolume = computed(() => appStore.selectedChapterVolume)
const currentVolumeIndex = computed(() =>
  appStore.outlineVolumes.findIndex((v) => v.id === currentVolume.value?.id)
)
const volumeLabel = computed(() =>
  currentVolume.value
    ? formatVolumeLabel(currentVolume.value, Math.max(currentVolumeIndex.value, 0), 'compact')
    : '未分卷'
)

const wordCount = computed(() => getChapterCharacterCount(currentChapter.value?.content ?? ''))
const targetWords = computed(() => parseChapterWordTarget(currentChapter.value?.wordTarget))
const progressPercent = computed(() => {
  if (!targetWords.value) return 0
  return Math.min(100, Math.round((wordCount.value / targetWords.value) * 100))
})

const saveStatusText = computed(() => {
  if (appStore.isPersistencePending) {
    return appStore.isLiveAutoSave ? '排队保存' : '自动保存中'
  }
  return '已保存'
})

const chapterIndex = computed(() => {
  const i = appStore.chapters.findIndex((c) => c.id === currentChapter.value?.id)
  return i >= 0 ? i + 1 : 1
})

const postGenerationIssues = computed(() => {
  const chapterId = currentChapter.value?.id ?? ''
  return chapterId ? appStore.getChapterPostGenerationIssues(chapterId) : null
})

const postGenerationIssueType = computed(() =>
  postGenerationIssues.value?.issues.some((issue) => issue.severity === 'error') ? 'error' : 'warning'
)

function dismissPostGenerationIssues(): void {
  const chapterId = currentChapter.value?.id ?? ''
  if (!chapterId) {
    return
  }
  appStore.dismissChapterPostGenerationIssues(chapterId)
}

// ==================== 结算状态条 + 操作（P3） ====================
const dialog = useDialog()
const settlementView = ref<CharacterArcSettlementRunView | null>(null)
const settlementBusy = ref(false)

/** 结算状态 → UI 标签/颜色映射（status === null 视为未结算） */
const settlementMeta = computed<{ label: string; type: 'default' | 'success' | 'warning' | 'error' | 'info' }>(() => {
  switch (settlementView.value?.status) {
    case 'settled': return { label: '状态已结算', type: 'success' }
    case 'settled_with_warning': return { label: '已结算(带警告)', type: 'warning' }
    case 'rejected': return { label: '结算被拒', type: 'error' }
    case 'error': return { label: '结算失败', type: 'error' }
    case 'rolled_back': return { label: '已回滚', type: 'warning' }
    case 'skipped': return { label: '无状态变更', type: 'info' }
    default: return { label: '未结算', type: 'default' }
  }
})

/** 该章是否有正文（决定是否提供重试结算） */
const settlementEligible = computed(() =>
  getChapterCharacterCount(currentChapter.value?.content ?? '') > 50
)

/** 仅最新章节允许回滚（回滚会影响其后章节一致性） */
const isLatestChapter = computed(() => {
  const i = appStore.chapters.findIndex((c) => c.id === currentChapter.value?.id)
  return i >= 0 && i === appStore.chapters.length - 1
})

const canRollbackSettlement = computed(() =>
  isLatestChapter.value &&
  (settlementView.value?.status === 'settled' || settlementView.value?.status === 'settled_with_warning')
)

const canRetrySettlement = computed(() =>
  !settlementBusy.value &&
  settlementEligible.value &&
  settlementView.value?.status !== 'settled' &&
  settlementView.value?.status !== 'settled_with_warning'
)

async function refreshSettlementStatus(): Promise<void> {
  const chapter = currentChapter.value
  const projectId = appStore.currentProject?.id
  if (!chapter?.id || !projectId) {
    settlementView.value = null
    return
  }
  try {
    const res = await window.characterArc.settlementStatus(projectId, chapter.id)
    settlementView.value = res.success ? (res.result ?? null) : null
  } catch {
    settlementView.value = null
  }
}

watch(
  () => currentChapter.value?.id,
  () => { void refreshSettlementStatus() },
  { immediate: true }
)

// 后处理完成（含结算被拒产生的 settlement issue）后刷新结算状态
watch(postGenerationIssues, () => { void refreshSettlementStatus() })

async function retrySettlement(): Promise<void> {
  const chapter = currentChapter.value
  const projectId = appStore.currentProject?.id
  if (!chapter?.id || !projectId) return
  const content = getPlainTextFromEditorContent(chapter.content ?? '').trim()
  if (!content) {
    message.warning('本章暂无正文，无法结算')
    return
  }
  settlementBusy.value = true
  try {
    // contextBridge 边界会做结构化克隆：先经 toIpcPayload 摊平（不能把 Vue 响应式 Proxy 直接传出）
    const res = await window.characterArc.settlementRerun(toIpcPayload({
      projectId,
      chapterId: chapter.id,
      content,
      settings: appStore.appSettings
    }))
    if (res.success && res.result) {
      const status = res.result.status
      if (status === 'settled') {
        message.success('结算完成：状态已写入')
      } else if (status === 'settled_with_warning') {
        message.warning('结算完成（带警告）：状态已写入')
      } else {
        message.error(`结算未通过（${status}）：${res.result.reason || '请检查正文后重试'}`)
      }
    } else {
      message.error(res.error || '重试结算失败')
    }
  } catch (error) {
    message.error(`重试结算出错：${String(error)}`)
  } finally {
    settlementBusy.value = false
    void refreshSettlementStatus()
  }
}

function rollbackSettlement(): void {
  const chapter = currentChapter.value
  const projectId = appStore.currentProject?.id
  const idx = appStore.chapters.findIndex((c) => c.id === chapter?.id)
  if (!projectId || !chapter?.id || idx < 0) return
  dialog.warning({
    title: '回滚本章状态结算',
    content: `将把第 ${idx + 1} 章结算写入的世界状态回滚到结算前，并把该章已结算记录标记为「已回滚」（之后可重新生成或点重试结算）。仅建议对最新章节执行，是否继续？`,
    positiveText: '回滚',
    negativeText: '取消',
    onPositiveClick: async () => {
      const res = await window.characterArc.settlementRollback(projectId, idx)
      if (res.success) {
        message.success(res.restored && res.restored > 0 ? '已回滚本章状态结算' : '无可回滚快照（可能本章尚未结算成功）')
      } else {
        message.error(res.error || '回滚失败')
      }
      void refreshSettlementStatus()
    }
  })
}

// ==================== 剧情多线推演（P6.2，隔离：不写正史） ====================
const forecastVisible = ref(false)
const forecastBusy = ref(false)
const forecastRecord = ref<CharacterArcForecastRecordView | null>(null)
// P8.5：采用分支后生成的「下一章建议 memo」（作者在环可改）
const adoptionMemoDraft = ref('')

async function runForecast(): Promise<void> {
  const chapter = currentChapter.value
  const projectId = appStore.currentProject?.id
  if (!chapter?.id || !projectId) return
  const content = getPlainTextFromEditorContent(chapter.content ?? '').trim()
  if (!content) {
    message.warning('本章暂无正文，无法推演')
    return
  }
  forecastBusy.value = true
  try {
    const res = await window.characterArc.narrativeForecastCreate(toIpcPayload({
      projectId,
      chapterId: chapter.id,
      content,
      branchCount: 3,
      settings: appStore.appSettings
    }))
    if (res.success && res.result) {
      forecastRecord.value = res.result
      forecastVisible.value = true
    } else {
      message.error(res.error || '推演失败')
    }
  } catch (error) {
    message.error(`推演出错：${String(error)}`)
  } finally {
    forecastBusy.value = false
  }
}

async function adoptBranchWithMemo(branchId: string): Promise<void> {
  const record = forecastRecord.value
  const projectId = appStore.currentProject?.id
  if (!record || !projectId || forecastBusy.value) return
  forecastBusy.value = true
  try {
    // P8.5：采用分支 + 生成下一章建议 memo（主进程只写 forecast 域，隔离承诺不变）
    const res = await window.characterArc.narrativeForecastAdoptMemo(projectId, record.id, branchId)
    if (res.success && res.result?.record) {
      forecastRecord.value = res.result.record
      adoptionMemoDraft.value = res.result.text ?? ''
      message.success('已采用该分支并生成下一章 memo（未改动正文/设定/世界状态）')
    } else {
      message.error(res.error || '采用分支并生成 memo 失败')
    }
  } catch (error) {
    message.error(`采用失败：${String(error)}`)
  } finally {
    forecastBusy.value = false
  }
}

async function copyAdoptionMemo(): Promise<void> {
  const text = adoptionMemoDraft.value.trim()
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    message.success('已复制下一章 memo 建议')
  } catch {
    message.error('复制失败')
  }
}

function prefillAdoptionMemo(): void {
  const text = adoptionMemoDraft.value.trim()
  if (!text) return
  emit('useAdoptionMemo', text)
  message.success('已预填到「生成初稿」的写作备忘（可先编辑再生成）')
}

const selToolbarVisible = ref(false)
const selToolbarTop = ref(0)
const selToolbarLeft = ref(0)
// 在 selectionchange 时缓存选区文本——mousedown 时浏览器会清除 window.getSelection()，
// click 时用这个缓存值兜底，避免 handleSelAction 读到空选区。
let cachedSelectionText = ''
const scrollRef = ref<HTMLDivElement | null>(null)
const editorRef = ref<InstanceType<typeof SimpleChapterEditor> | null>(null)
const findBarRef = ref<InstanceType<typeof EditorFindBar> | null>(null)
const findBarVisible = ref(false)
const findInitialTerm = ref('')
const recoverySnapshot = ref<ChapterRecoverySnapshot | null>(null)
// editorRef.value.editor 通过模板 ref 自动 unwrap 为 Editor | undefined
const tiptapEditor = computed(() => (editorRef.value as any)?.editor ?? null)

function openFindBar(): void {
  const editor = tiptapEditor.value
  let preset = ''
  if (editor) {
    const { from, to } = editor.state.selection
    if (from !== to) {
      const text = editor.state.doc.textBetween(from, to, '\n').trim()
      // 选区单行才预填，多段选区跳过
      if (text && !text.includes('\n')) preset = text
    }
  }
  findInitialTerm.value = preset
  if (findBarVisible.value) {
    // 已打开：强制用选区文本覆盖（如果没选区，则保留原搜索词）
    if (preset) {
      ;(findBarRef.value as any)?.setTerm(preset)
    } else {
      ;(findBarRef.value as any)?.focus()
    }
  } else {
    findBarVisible.value = true
  }
}

const ctxMenuVisible = ref(false)
const ctxMenuX = ref(0)
const ctxMenuY = ref(0)
const ctxMenuHasSelection = ref(false)

function handleEditorContextMenu(e: MouseEvent): void {
  const target = e.target as HTMLElement | null
  // 仅在 ProseMirror 编辑区域内拦截
  if (!target?.closest('.ProseMirror')) return
  e.preventDefault()
  const editor = tiptapEditor.value
  const sel = editor?.state.selection
  ctxMenuHasSelection.value = !!sel && sel.from !== sel.to
  ctxMenuX.value = e.clientX
  ctxMenuY.value = e.clientY
  ctxMenuVisible.value = true
}

async function handleCtxAction(id: string): Promise<void> {
  const editor = tiptapEditor.value
  if (!editor) return
  if (id === 'copy') {
    const { from, to } = editor.state.selection
    if (from === to) return
    const text = editor.state.doc.textBetween(from, to, '\n')
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // 剪贴板被拒绝时回退到执行命令
      document.execCommand('copy')
    }
  } else if (id === 'cut') {
    const { from, to } = editor.state.selection
    if (from === to) return
    const text = editor.state.doc.textBetween(from, to, '\n')
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      document.execCommand('cut')
      return
    }
    editor.chain().focus().deleteSelection().run()
  } else if (id === 'paste') {
    try {
      const text = await navigator.clipboard.readText()
      if (text) editor.chain().focus().insertContent(text).run()
    } catch {
      document.execCommand('paste')
    }
  } else if (id === 'paste-plain') {
    try {
      const text = await navigator.clipboard.readText()
      if (text) editor.chain().focus().insertContent(text).run()
    } catch {
      /* ignore */
    }
  } else if (id === 'select-all') {
    editor.chain().focus().selectAll().run()
  } else if (id === 'find') {
    openFindBar()
  }
}

function handleSelectionChange(): void {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    selToolbarVisible.value = false
    cachedSelectionText = ''
    return
  }
  const range = sel.getRangeAt(0)
  const scrollEl = scrollRef.value
  if (!scrollEl || !scrollEl.contains(range.commonAncestorContainer)) {
    selToolbarVisible.value = false
    cachedSelectionText = ''
    return
  }
  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) {
    selToolbarVisible.value = false
    cachedSelectionText = ''
    return
  }
  // 在工具栏显示前缓存选区文本，mousedown 时浏览器会清除 window.getSelection()
  cachedSelectionText = sel.toString().trim()
  const scrollRect = scrollEl.getBoundingClientRect()
  const toolbarH = 36
  const gap = 6
  let top = rect.top - toolbarH - gap
  if (top < scrollRect.top) top = rect.bottom + gap
  const toolbarW = 360
  let left = rect.left + rect.width / 2
  const minLeft = scrollRect.left + toolbarW / 2 + 4
  const maxLeft = scrollRect.right - toolbarW / 2 - 4
  if (left < minLeft) left = minLeft
  else if (left > maxLeft) left = maxLeft
  selToolbarTop.value = top
  selToolbarLeft.value = left
  selToolbarVisible.value = true
}

function handleSelAction(action: string): void {
  // 优先读实时选区，若浏览器已因 mousedown 清除则用缓存值兜底
  const sel = window.getSelection()
  const text = sel?.toString().trim() || cachedSelectionText
  cachedSelectionText = ''
  if (!text) return
  selToolbarVisible.value = false
  emit('selectionAction', action, text)
}

// ── P8.3 反思式局部改写（自评重做；作者在环：预览确认后替换选区） ──
const rewriteBusy = ref(false)
const rewriteError = ref('')
const rewriteVisible = ref(false)
const rewriteResult = ref<{ text: string; iterations: number; passed: boolean } | null>(null)
const rewriteTextDraft = ref('')
const rewriteRange = ref<{ from: number; to: number } | null>(null)

function getEditorSelectionText(): string {
  const editor = tiptapEditor.value
  if (!editor) return ''
  const { from, to } = editor.state.selection
  if (from === to) return ''
  return editor.state.doc.textBetween(from, to, '\n').trim()
}

async function runReflectiveRewrite(): Promise<void> {
  const sourceText = getEditorSelectionText()
  if (!sourceText) {
    message.warning('请先在正文中选中要改写的文本')
    return
  }
  if (rewriteBusy.value) return
  const editor = tiptapEditor.value
  const { from, to } = editor?.state.selection ?? { from: 0, to: 0 }
  rewriteBusy.value = true
  rewriteError.value = ''
  rewriteResult.value = null
  rewriteTextDraft.value = ''
  rewriteRange.value = { from, to }
  try {
    const response = await window.characterArc.reflectiveRewrite(toIpcPayload({
      settings: appStore.appSettings,
      sourceText,
      instruction: '请对选中正文做一版高质量改写：保留剧情事实、人物语气与专有名词，强化表达、动作层次与情绪推进；只输出改写后的最终文本。',
      maxIterations: 2,
      passScore: 80
    }))
    if (!response.success || !response.result) {
      rewriteError.value = response.error ?? '反思式改写失败'
    } else {
      rewriteResult.value = response.result
      rewriteTextDraft.value = response.result.text
    }
  } catch (error) {
    rewriteError.value = error instanceof Error ? error.message : '反思式改写失败'
  } finally {
    rewriteBusy.value = false
    rewriteVisible.value = true
  }
}

function applyReflectiveRewrite(): void {
  const editor = tiptapEditor.value
  const text = (rewriteTextDraft.value || rewriteResult.value?.text || '').trim()
  if (!editor || !text) return
  const range = rewriteRange.value
  const chain = editor.chain().focus()
  if (range) chain.setTextSelection(range)
  chain.deleteSelection().run()
  editor.chain().focus().insertContent(text).run()
  rewriteVisible.value = false
  rewriteResult.value = null
  rewriteTextDraft.value = ''
  rewriteRange.value = null
  message.success('已替换选中文本')
}

function dismissReflectiveRewrite(): void {
  rewriteVisible.value = false
  rewriteResult.value = null
  rewriteTextDraft.value = ''
  rewriteRange.value = null
  rewriteError.value = ''
}

// ── P8.7b 项目级 Agent 角色差异化配置（enabled + 六角色 × model/temperature/maxTokens） ──
const AGENT_ROLE_DEFS = [
  { id: 'memo', label: '写作备忘', desc: '规划本章硬契约' },
  { id: 'draft', label: '初稿', desc: '整章创作' },
  { id: 'audit', label: '审计', desc: '质量审查' },
  { id: 'repair', label: '修复', desc: '最小改动修复' },
  { id: 'humanize', label: '润色', desc: '去 AI 味' },
  { id: 'session-note', label: '写作日志', desc: '本章经验入库' }
] as const
type AgentRoleId = (typeof AGENT_ROLE_DEFS)[number]['id']
type AgentRoleDraft = { model: string; temperature: number | null; maxTokens: number | null }
const emptyRoleDraft = (): AgentRoleDraft => ({ model: '', temperature: null, maxTokens: null })
const agentCfgProfiles = reactive<Record<AgentRoleId, AgentRoleDraft>>({
  memo: emptyRoleDraft(),
  draft: emptyRoleDraft(),
  audit: emptyRoleDraft(),
  repair: emptyRoleDraft(),
  humanize: emptyRoleDraft(),
  'session-note': emptyRoleDraft()
})
const agentCfgEnabled = ref(false)
const agentCfgVisible = ref(false)
const agentCfgBusy = ref(false)

async function openAgentConfig(): Promise<void> {
  const projectId = appStore.currentProject?.id
  if (!projectId) return
  agentCfgBusy.value = true
  try {
    const settings = await appStore.ensureProjectAgentSettings(projectId)
    agentCfgEnabled.value = settings.enabled
    for (const def of AGENT_ROLE_DEFS) {
      const p = settings.profiles[def.id]
      agentCfgProfiles[def.id].model = p?.model ?? ''
      agentCfgProfiles[def.id].temperature = p?.temperature ?? null
      agentCfgProfiles[def.id].maxTokens = p?.maxTokens ?? null
    }
    agentCfgVisible.value = true
  } finally {
    agentCfgBusy.value = false
  }
}

async function saveAgentConfig(): Promise<void> {
  const projectId = appStore.currentProject?.id
  if (!projectId) return
  const profiles: ChapterAgentProfileMap = {}
  for (const def of AGENT_ROLE_DEFS) {
    const d = agentCfgProfiles[def.id]
    const entry: { model?: string; temperature?: number; maxTokens?: number } = {}
    if (d.model.trim()) entry.model = d.model.trim()
    if (d.temperature != null) entry.temperature = d.temperature
    if (d.maxTokens != null) entry.maxTokens = d.maxTokens
    if (Object.keys(entry).length > 0) profiles[def.id] = entry
  }
  agentCfgBusy.value = true
  try {
    await appStore.saveProjectAgentSettings(projectId, agentCfgEnabled.value, profiles)
    message.success('已保存本项目 Agent 差异化配置')
    agentCfgVisible.value = false
  } finally {
    agentCfgBusy.value = false
  }
}

function handleMouseDown(e: MouseEvent): void {
  const toolbar = document.querySelector('.arc-sel-toolbar')
  if (toolbar?.contains(e.target as Node)) return
  selToolbarVisible.value = false
}

function handleGlobalKeydown(e: KeyboardEvent): void {
  const commandKey = e.ctrlKey || e.metaKey
  if (commandKey && e.key.toLowerCase() === 'f') {
    const scrollEl = scrollRef.value
    if (!scrollEl) return
    // 仅当焦点在当前编辑器区域内时才拦截
    const active = document.activeElement
    const inEditor = scrollEl.contains(active) || findBarVisible.value
    if (!inEditor) return
    e.preventDefault()
    openFindBar()
    return
  }
  if (commandKey && e.altKey && e.key.toLowerCase() === 'a') {
    e.preventDefault()
    emit('toggleAi')
    return
  }
  if (commandKey && e.key.toLowerCase() === 's') {
    e.preventDefault()
    if (e.shiftKey) {
      void appStore.saveCurrentChapterVersion().then((result) => {
        if (result.success) message.success('已保存当前章节版本')
        else message.error(result.error ?? '保存版本失败')
      })
    } else {
      void appStore.persistWorkspace().then(() => {
        if (appStore.persistenceError) message.error(appStore.persistenceError)
        else message.success('工作区已保存')
      })
    }
  }
}

function restoreRecovery(): void {
  editorRef.value?.restoreRecovery()
  recoverySnapshot.value = null
  message.success('已恢复异常退出前的本地草稿')
}

function discardRecovery(): void {
  editorRef.value?.discardRecovery()
  recoverySnapshot.value = null
}

onMounted(() => {
  document.addEventListener('selectionchange', handleSelectionChange)
  document.addEventListener('mousedown', handleMouseDown)
  document.addEventListener('keydown', handleGlobalKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('selectionchange', handleSelectionChange)
  document.removeEventListener('mousedown', handleMouseDown)
  document.removeEventListener('keydown', handleGlobalKeydown)
})
</script>

<template>
  <main class="editor-pane">
    <header v-if="!focusMode" class="ep-header">
      <button v-if="showSidebarToggle" class="toolbtn sidebar-toggle" @click="emit('toggleSidebar')">
        <Menu :size="14" />
      </button>
      <div class="breadcrumb">
        <Folder :size="13" />
        <span>{{ volumeLabel }}</span>
        <ChevronRight :size="12" />
        <span class="crumb-current">{{ currentChapter?.title || '未命名章节' }}</span>
      </div>

      <div class="ep-actions">
        <span class="save-indicator">
          <span class="dot" :class="{ pending: appStore.isPersistencePending }" />
          {{ saveStatusText }}
        </span>
        <span class="divider" />

        <n-dropdown
          trigger="click"
          placement="bottom-end"
          :options="editorFontMenuOptions"
          @select="selectEditorFont"
        >
          <button class="toolbtn font-picker-tool" :title="`正文字体：${currentEditorFont.label}`">
            <Type :size="13" />
            <span class="font-picker-label">{{ currentEditorFont.shortLabel }}</span>
            <ChevronDown :size="11" />
          </button>
        </n-dropdown>

        <div class="font-stepper">
          <button @click="stepFont(-1)"><Minus :size="11" /></button>
          <span class="level">{{ fontSize }}px</span>
          <button @click="stepFont(1)"><Plus :size="11" /></button>
        </div>

        <n-tooltip placement="bottom">
          <template #trigger>
            <button class="toolbtn" @click="emit('toggleFocus')"><FocusIcon :size="13" /></button>
          </template>
          专注模式 (F11)
        </n-tooltip>
        <n-tooltip placement="bottom">
          <template #trigger>
            <button class="toolbtn" :disabled="!currentChapter" @click="versionDialogVisible = true">
              <History :size="13" />
            </button>
          </template>
          历史版本
        </n-tooltip>
        <n-tooltip placement="bottom">
          <template #trigger>
            <button class="toolbtn" :disabled="rewriteBusy" @click="runReflectiveRewrite">
              <RefreshCw :size="13" />
              <span>反思改写</span>
            </button>
          </template>
          反思改写选中文本（自评重做，预览后替换）
        </n-tooltip>
        <button class="toolbtn" :disabled="!currentChapter" @click="emit('generateDraft')">
          <Wand2 :size="13" />
          <span>生成初稿</span>
        </button>
        <n-tooltip placement="bottom">
          <template #trigger>
            <button class="toolbtn" :disabled="!appStore.currentProject || agentCfgBusy" @click="openAgentConfig">
              <Settings2 :size="13" />
              <span>Agent 配置</span>
            </button>
          </template>
          本项目 Agent 角色差异化配置（实验性）
        </n-tooltip>
        <button class="toolbtn" :class="{ primary: !aiOpen, active: aiOpen }" @click="emit('toggleAi')">
          <Sparkles :size="13" />
          <span>AI 助理</span>
        </button>
      </div>
    </header>

    <div ref="scrollRef" class="ep-scroll arc-scrollbar" @contextmenu="handleEditorContextMenu">
      <div class="ep-canvas" :style="{ fontSize: fontSize + 'px' }">
        <div v-if="!currentChapter" class="ep-empty">
          请在左侧选择一个章节，或新建一个章节开始写作
        </div>
        <template v-else>
          <input
            class="ep-title"
            :value="currentChapter.title"
            placeholder="章节标题"
            @change="(e) => appStore.updateChapter(currentChapter!.id, { title: (e.target as HTMLInputElement).value })"
          />

          <div class="ep-meta-row">
            <n-tag size="small" :bordered="false">{{ wordCount.toLocaleString() }} 字</n-tag>
            <n-tag size="small" :bordered="false">目标 {{ formatChapterWordTargetLabel(currentChapter.wordTarget) }}</n-tag>
            <span v-if="currentChapter.summary" class="meta-summary">大纲：{{ currentChapter.summary }}</span>
          </div>

          <div v-if="settlementView || settlementEligible" class="ep-settlement-row">
            <n-tooltip :disabled="!settlementView || !settlementView.reason && !settlementView.issues.length" trigger="hover">
              <template #trigger>
                <n-tag
                  size="small"
                  :bordered="false"
                  :type="settlementMeta.type"
                  class="ep-settlement-tag"
                >
                  {{ settlementMeta.label }}
                </n-tag>
              </template>
              <span v-if="settlementView" class="ep-settlement-tip">
                <template v-if="settlementView.reason">{{ settlementView.reason }}</template>
                <template v-if="settlementView.issues.length">
                  <template v-for="(issue, i) in settlementView.issues" :key="`${issue.category}-${i}`">
                    <br />· [{{ issue.severity }}] {{ issue.message }}
                  </template>
                </template>
              </span>
            </n-tooltip>

            <n-button
              v-if="canRetrySettlement"
              size="tiny"
              secondary
              :loading="settlementBusy"
              @click="retrySettlement"
            >
              重试结算
            </n-button>
            <n-button
              v-if="canRollbackSettlement"
              size="tiny"
              secondary
              type="warning"
              @click="rollbackSettlement"
            >
              回滚本章
            </n-button>
            <n-button
              v-if="settlementEligible && isLatestChapter"
              size="tiny"
              secondary
              :loading="forecastBusy"
              @click="runForecast"
            >
              推演下一步
            </n-button>
          </div>

          <n-modal
            v-model:show="forecastVisible"
            preset="card"
            title="剧情推演（隔离：不写入正史）"
            :style="{ width: 'min(720px, 92vw)' }"
            :bordered="false"
          >
            <div v-if="forecastRecord" class="ep-forecast">
              <p class="ep-forecast-title">
                {{ forecastRecord.title }} · {{ forecastRecord.branchCount }} 条分支（基于第
                {{ forecastRecord.baseChapterIndex + 1 }} 章之后）
              </p>
              <p v-if="forecastRecord.status === 'selected'" class="ep-forecast-note">
                已采用分支：{{ forecastRecord.selectedBranchId }}
              </p>
              <div class="ep-forecast-branches">
                <div
                  v-for="(branch, i) in forecastRecord.branches"
                  :key="branch.id"
                  class="ep-forecast-branch"
                >
                  <div class="ep-forecast-branch-head">
                    <n-tag
                      size="small"
                      :bordered="false"
                      :type="forecastRecord.selectedBranchId === branch.id ? 'success' : 'default'"
                    >
                      分支{{ i + 1 }} · {{ branch.title }}
                    </n-tag>
                    <n-button
                      v-if="forecastRecord.status === 'active'"
                      size="tiny"
                      secondary
                      type="primary"
                      :loading="forecastBusy"
                      @click="adoptBranchWithMemo(branch.id)"
                    >
                      采用并生成 memo
                    </n-button>
                  </div>
                  <div v-if="branch.beats?.length" class="ep-forecast-field">
                    <strong>节拍：</strong>{{ branch.beats.join(' → ') }}
                  </div>
                  <div v-if="branch.decision" class="ep-forecast-field">
                    <strong>决定：</strong>{{ branch.decision }}
                  </div>
                  <div v-if="branch.changes?.length" class="ep-forecast-field">
                    <strong>变化：</strong>{{ branch.changes.join('；') }}
                  </div>
                  <div v-if="branch.risks?.length" class="ep-forecast-field">
                    <strong>风险：</strong>{{ branch.risks.join('；') }}
                  </div>
                  <div v-if="branch.fit" class="ep-forecast-field">
                    <strong>匹配：</strong>{{ branch.fit }}
                  </div>
                </div>
              </div>
              <p class="ep-forecast-note">
                采用分支只会把这条推演记录标记为 selected（并生成下一章建议 memo），不会改动正文/设定/世界状态。
              </p>
              <div v-if="forecastRecord.status === 'selected'" class="ep-adopt-memo">
                <div class="ep-adopt-memo-head">
                  <strong>下一章 memo 建议（作者在环：可先编辑）</strong>
                  <span class="ep-adopt-memo-hint">写入写作备忘前的草案，不自动进正文</span>
                </div>
                <n-input
                  v-model:value="adoptionMemoDraft"
                  type="textarea"
                  :autosize="{ minRows: 6, maxRows: 14 }"
                  placeholder="采用分支后生成的下一章建议 memo"
                />
                <div class="ep-forecast-actions">
                  <NButton round strong size="small" secondary @click="copyAdoptionMemo">复制 memo</NButton>
                  <NButton
                    round
                    strong
                    size="small"
                    type="primary"
                    :disabled="!adoptionMemoDraft.trim()"
                    @click="prefillAdoptionMemo"
                  >
                    预填下一章写作备忘
                  </NButton>
                </div>
              </div>
              <div class="ep-forecast-actions">
                <NButton round strong @click="forecastVisible = false">关闭</NButton>
              </div>
            </div>
          </n-modal>

          <n-modal
            v-model:show="rewriteVisible"
            preset="card"
            title="反思式改写（自评重做）"
            :style="{ width: 'min(680px, 92vw)' }"
            :bordered="false"
          >
            <div class="ep-rewrite">
              <template v-if="rewriteError">
                <n-alert type="error" :show-icon="false">{{ rewriteError }}</n-alert>
              </template>
              <template v-else-if="rewriteResult">
                <p class="ep-rewrite-meta">
                  {{ rewriteResult.passed ? '✅ 已达标' : '⚠️ 未达自评门（已尽力，可人工判断）' }}
                  · 迭代 {{ rewriteResult.iterations }} 轮
                </p>
                <n-input
                  v-model:value="rewriteTextDraft"
                  type="textarea"
                  :autosize="{ minRows: 12, maxRows: 20 }"
                  placeholder="改写结果（可手动微调）"
                />
                <div class="ep-rewrite-actions">
                  <NButton round strong type="primary" @click="applyReflectiveRewrite">
                    替换选中文本
                  </NButton>
                  <NButton round strong @click="dismissReflectiveRewrite">关闭</NButton>
                </div>
              </template>
            </div>
          </n-modal>

          <n-modal
            v-model:show="agentCfgVisible"
            preset="card"
            title="Agent 角色差异化（本项目）"
            :style="{ width: 'min(720px, 94vw)' }"
            :bordered="false"
          >
            <div class="ep-agent-cfg">
              <p class="ep-agent-cfg-hint">
                为六步（规划-写-审-改-润色-日志）分别配置 model / temperature / maxTokens；留空该项则用全局设置。启用后按角色套用（未配置角色回退内置温度档位）。
              </p>
              <div class="ep-agent-cfg-switch">
                <n-switch v-model:value="agentCfgEnabled" size="small" />
                <span>启用本项目 Agent 差异化（实验性，默认关）</span>
              </div>
              <div v-for="def in AGENT_ROLE_DEFS" :key="def.id" class="ep-agent-cfg-row">
                <div class="ep-agent-cfg-role">
                  <strong>{{ def.label }}</strong>
                  <span>{{ def.desc }}</span>
                </div>
                <n-input
                  v-model:value="agentCfgProfiles[def.id].model"
                  size="small"
                  placeholder="模型（留空=全局）"
                  clearable
                  class="ep-agent-cfg-model"
                />
                <n-input-number
                  v-model:value="agentCfgProfiles[def.id].temperature"
                  size="small"
                  :min="0"
                  :max="2"
                  :step="0.1"
                  placeholder="温度"
                  class="ep-agent-cfg-num"
                />
                <n-input-number
                  v-model:value="agentCfgProfiles[def.id].maxTokens"
                  size="small"
                  :min="1"
                  placeholder="maxTokens"
                  class="ep-agent-cfg-num"
                />
              </div>
              <div class="ep-forecast-actions">
                <NButton round strong secondary @click="agentCfgVisible = false">关闭</NButton>
                <NButton round strong type="primary" :loading="agentCfgBusy" @click="saveAgentConfig">
                  保存到本项目
                </NButton>
              </div>
            </div>
          </n-modal>

          <n-alert
            v-if="postGenerationIssues?.issues.length"
            :type="postGenerationIssueType"
            :show-icon="false"
            closable
            class="ep-postgen-alert"
            @close="dismissPostGenerationIssues"
          >
            <template #header>
              本章正文已生成，但后处理没有完全完成
            </template>
            <div class="ep-postgen-copy">
              你可以继续写作；如果依赖世界状态连续性或语义检索，建议稍后重试状态回填或重新触发一次生成。
            </div>
            <ul class="ep-postgen-list">
              <li
                v-for="(issue, idx) in postGenerationIssues.issues"
                :key="`${issue.stage}-${idx}-${issue.message}`"
              >
                {{ issue.message }}
              </li>
            </ul>
          </n-alert>

          <div v-if="recoverySnapshot" class="recovery-banner">
            <ShieldAlert :size="16" />
            <div class="recovery-copy">
              <strong>发现未同步的本地草稿</strong>
              <span>保存于 {{ new Date(recoverySnapshot.savedAt).toLocaleString('zh-CN') }}</span>
            </div>
            <button type="button" @click="discardRecovery">忽略</button>
            <button type="button" class="primary" @click="restoreRecovery">恢复草稿</button>
          </div>

          <SimpleChapterEditor
            ref="editorRef"
            class="ep-editor"
            :style="{ fontFamily: currentEditorFont.fontFamily }"
            :chapter-id="currentChapter.id"
            :model-value="currentChapter.content ?? ''"
            :insertion-request="appStore.pendingChapterInsertion"
            @update:model-value="(value, chapterId) => appStore.updateChapterContent(value, chapterId)"
            @consume-insertion="appStore.consumeChapterInsertion"
            @selection-change="appStore.updateChapterSelection"
            @recovery-available="recoverySnapshot = $event"
          />
        </template>
      </div>
    </div>

    <EditorFindBar
      ref="findBarRef"
      :visible="findBarVisible"
      :editor="tiptapEditor"
      :initial-term="findInitialTerm"
      :scroll-container="scrollRef"
      @close="findBarVisible = false"
    />

    <EditorContextMenu
      :visible="ctxMenuVisible"
      :x="ctxMenuX"
      :y="ctxMenuY"
      :has-selection="ctxMenuHasSelection"
      @close="ctxMenuVisible = false"
      @action="handleCtxAction"
    />

    <Teleport to="body">
      <Transition name="arc-sel-fade">
        <div
          v-if="selToolbarVisible"
          class="arc-sel-toolbar"
          :style="{ top: selToolbarTop + 'px', left: selToolbarLeft + 'px' }"
        >
          <button class="arc-sel-btn" @click="handleSelAction('润色')">
            <Wand2 :size="12" /> 润色
          </button>
          <button class="arc-sel-btn" @click="handleSelAction('改写')">
            <RefreshCw :size="12" /> 改写
          </button>
          <button class="arc-sel-btn" @click="handleSelAction('扩写')">
            <Maximize2 :size="12" /> 扩写
          </button>
          <button class="arc-sel-btn" @click="handleSelAction('缩写')">
            <Minimize2 :size="12" /> 缩写
          </button>
          <span class="arc-sel-divider" />
          <button class="arc-sel-btn" @click="handleSelAction('问AI')">
            <MessageSquareQuote :size="12" /> 问 AI
          </button>
        </div>
      </Transition>
    </Teleport>

    <footer v-if="!focusMode && currentChapter" class="ep-status">
      <div class="stats-group">
        <span>字数 {{ wordCount.toLocaleString() }}</span>
        <span>第 {{ chapterIndex }} / {{ appStore.chapters.length }} 章</span>
      </div>
      <div class="progress-block">
        <span class="progress-label">本章目标 {{ targetWords.toLocaleString() }}</span>
        <div class="progress-bar">
          <div class="fill" :style="{ width: Math.min(100, progressPercent) + '%' }" />
        </div>
        <span class="progress-pct">{{ progressPercent }}%</span>
      </div>
    </footer>

    <ChapterVersionDialog
      v-model:show="versionDialogVisible"
      :chapter="currentChapter ?? null"
    />
  </main>
</template>

<style scoped>
.editor-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--arc-bg-body);
  overflow: hidden;
  position: relative;
}

.recovery-banner {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  margin: 12px 0 18px;
  padding: 9px 10px;
  border: 1px solid color-mix(in srgb, var(--arc-warning) 34%, var(--arc-border));
  border-radius: 6px;
  background: color-mix(in srgb, var(--arc-warning) 6%, var(--arc-bg-surface));
  color: var(--arc-warning);
}

.recovery-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.recovery-copy strong {
  color: var(--arc-text-primary);
  font-size: 12px;
}

.recovery-copy span {
  color: var(--arc-text-hint);
  font-size: 11px;
}

.recovery-banner button {
  min-height: 28px;
  padding: 0 9px;
  border: 1px solid var(--arc-border);
  border-radius: 5px;
  background: var(--arc-bg-surface);
  color: var(--arc-text-secondary);
  cursor: pointer;
  font-size: 11px;
}

.recovery-banner button.primary {
  border-color: var(--arc-primary);
  background: var(--arc-primary);
  color: white;
}

.ep-header {
  height: 44px;
  flex-shrink: 0;
  padding: 0 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: var(--arc-bg-surface);
  border-bottom: 1px solid var(--arc-border);
}

.breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--arc-text-secondary);
  min-width: 0;
}

.breadcrumb svg {
  flex-shrink: 0;
  color: var(--arc-text-hint);
}

.crumb-current {
  color: var(--arc-text-primary);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ep-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.save-indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--arc-text-hint);
}

.save-indicator .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--arc-success);
}

.save-indicator .dot.pending {
  background: var(--arc-warning);
}

.divider {
  width: 1px;
  height: 18px;
  background: var(--arc-border);
  margin: 0 4px;
}

.font-stepper {
  display: inline-flex;
  align-items: center;
  background: var(--arc-bg-surface-hover);
  border-radius: var(--arc-radius-sm);
  padding: 2px;
  gap: 2px;
}

.font-picker-tool {
  min-width: 68px;
  justify-content: center;
  white-space: nowrap;
}

.font-picker-label {
  min-width: 24px;
  text-align: center;
}

.font-stepper button {
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  color: var(--arc-text-secondary);
  cursor: pointer;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.font-stepper button:hover {
  background: var(--arc-bg-surface);
  color: var(--arc-text-primary);
}

.font-stepper .level {
  font-size: 11px;
  color: var(--arc-text-secondary);
  padding: 0 4px;
  min-width: 30px;
  text-align: center;
}

.toolbtn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: var(--arc-radius-sm);
  border: none;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  color: var(--arc-text-secondary);
  background: transparent;
  transition: 0.15s;
}

.toolbtn:hover {
  background: var(--arc-bg-surface-hover);
  color: var(--arc-text-primary);
}

.toolbtn.primary {
  background: var(--arc-primary-soft);
  color: var(--arc-primary);
}

.toolbtn.primary:hover {
  background: color-mix(in srgb, var(--arc-primary) 14%, var(--arc-bg-surface));
}

.toolbtn.active {
  background: var(--arc-primary);
  color: white;
}

.toolbtn.active:hover {
  background: var(--arc-primary-hover);
  color: white;
}

.ep-scroll {
  position: relative;
  flex: 1;
  overflow-y: auto;
  padding: 48px 0 96px;
  min-height: 0;
}

.ep-canvas {
  max-width: 720px;
  margin: 0 auto;
  padding: 0 56px;
}

.ep-title {
  font-size: 32px;
  font-weight: 700;
  border: none;
  outline: none;
  width: 100%;
  color: var(--arc-text-primary);
  background: transparent;
  letter-spacing: -0.025em;
  margin-bottom: 12px;
  line-height: 1.25;
}

.ep-title::placeholder {
  color: var(--arc-text-hint);
}

.ep-meta-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 32px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--arc-border);
  font-size: 12px;
  color: var(--arc-text-secondary);
  flex-wrap: wrap;
}

.meta-summary {
  color: var(--arc-text-hint);
  font-size: 12px;
  line-height: 1.5;
}

.ep-settlement-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: -20px 0 12px;
  font-size: 12px;
  color: var(--arc-text-hint);
  flex-wrap: wrap;
}

.ep-settlement-tip {
  font-size: 12px;
  line-height: 1.7;
}

.ep-forecast-title {
  font-size: 13px;
  color: var(--arc-text-secondary);
  margin-bottom: 8px;
}

.ep-forecast-note {
  font-size: 12px;
  color: var(--arc-text-hint);
  line-height: 1.6;
  margin: 6px 0;
}

.ep-forecast-branches {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 60vh;
  overflow: auto;
  padding-right: 4px;
}

.ep-forecast-branch {
  border: 1px solid var(--arc-border);
  border-radius: 8px;
  padding: 8px 10px;
}

.ep-forecast-branch-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}

.ep-forecast-field {
  font-size: 12px;
  color: var(--arc-text-secondary);
  line-height: 1.6;
}

.ep-forecast-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}

.ep-rewrite-meta {
  font-size: 12px;
  color: var(--arc-text-secondary);
  margin-bottom: 8px;
}

.ep-rewrite-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

.ep-adopt-memo-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
}

.ep-adopt-memo-head strong {
  font-size: 13px;
}

.ep-adopt-memo-hint {
  font-size: 12px;
  color: var(--arc-text-hint);
}

.ep-adopt-memo {
  margin-top: 4px;
}

.ep-agent-cfg-hint {
  font-size: 12px;
  color: var(--arc-text-secondary);
  line-height: 1.6;
  margin-bottom: 10px;
}

.ep-agent-cfg-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  margin-bottom: 10px;
}

.ep-agent-cfg-row {
  display: grid;
  grid-template-columns: 130px 1fr 110px 130px;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid var(--arc-border-color, rgba(128, 128, 128, 0.14));
}

.ep-agent-cfg-role {
  display: flex;
  flex-direction: column;
  line-height: 1.3;
}

.ep-agent-cfg-role strong {
  font-size: 13px;
}

.ep-agent-cfg-role span {
  font-size: 11px;
  color: var(--arc-text-hint);
}

.ep-editor {
  background: transparent;
}

.ep-postgen-alert {
  margin-bottom: 20px;
}

.ep-postgen-copy {
  font-size: 12px;
  line-height: 1.65;
}

.ep-postgen-list {
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.65;
}

.ep-empty {
  text-align: center;
  padding: 80px 0;
  color: var(--arc-text-hint);
  font-size: 14px;
}

.ep-status {
  height: 32px;
  flex-shrink: 0;
  padding: 0 16px;
  background: var(--arc-bg-surface);
  border-top: 1px solid var(--arc-border);
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 11px;
  color: var(--arc-text-hint);
}

.stats-group {
  display: flex;
  gap: 12px;
}

.progress-block {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 120px;
}

.progress-label {
  color: var(--arc-text-secondary);
  white-space: nowrap;
}

.progress-bar {
  flex: 1;
  height: 4px;
  background: var(--arc-bg-surface-hover);
  border-radius: 2px;
  overflow: hidden;
}

.progress-bar .fill {
  height: 100%;
  background: linear-gradient(90deg, var(--arc-success), var(--arc-primary));
  border-radius: 2px;
  transition: width 0.3s ease;
}

.progress-pct {
  color: var(--arc-text-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

</style>

<style>
.arc-sel-toolbar {
  position: fixed;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  background: #1D1D1F;
  border-radius: 6px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
  z-index: 9999;
  transform: translateX(-50%);
  pointer-events: auto;
}

.arc-sel-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border: none;
  background: transparent;
  color: white;
  font-size: 12px;
  border-radius: 4px;
  cursor: pointer;
  transition: 0.15s;
  white-space: nowrap;
}

.arc-sel-btn:hover {
  background: rgba(255, 255, 255, 0.15);
}

.arc-sel-divider {
  width: 1px;
  height: 16px;
  background: rgba(255, 255, 255, 0.2);
  margin: 0 2px;
  flex-shrink: 0;
}

.arc-sel-fade-enter-active,
.arc-sel-fade-leave-active {
  transition: opacity 0.15s, transform 0.15s;
}

.arc-sel-fade-enter-from,
.arc-sel-fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(4px);
}
</style>
