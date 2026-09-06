<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ArrowUp, ChevronDown, GripHorizontal, Info, Pen, Square, X } from 'lucide-vue-next'

const props = defineProps<{
  disabled: boolean
  hasSelection: boolean
  selectionPreview: string
  enabledContextCount: number
}>()

const emit = defineEmits<{
  send: [value: string]
  stop: []
  'open-commands': []
  'open-context': []
  'clear-selection': []
  'generate-draft': []
}>()

const text = ref('')
const isDragging = ref(false)
const inputHeight = ref(120)
const minHeight = 60
const maxHeight = computed(() => Math.floor(window.innerHeight * 0.5))

type AiMode = '问答' | '改写' | '续写'
const modes: AiMode[] = ['问答', '改写', '续写']
const activeMode = ref<AiMode>('问答')

const placeholders: Record<AiMode, string> = {
  '问答': '向 AI 提问，或描述你想要的修改 (Enter 发送)',
  '改写': '描述你想如何改写选中的段落...',
  '续写': '给出续写方向，或留空让 AI 自由发挥...'
}

onMounted(() => {
  const saved = localStorage.getItem('arc-ai-input-height')
  if (saved) {
    const val = Number(saved)
    if (val >= minHeight && val <= maxHeight.value) {
      inputHeight.value = val
    }
  }
})

function startDrag(e: MouseEvent): void {
  e.preventDefault()
  isDragging.value = true
  const startY = e.clientY
  const startHeight = inputHeight.value
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'row-resize'

  function onMove(ev: MouseEvent): void {
    const delta = startY - ev.clientY
    const newHeight = Math.max(minHeight, Math.min(maxHeight.value, startHeight + delta))
    inputHeight.value = newHeight
  }

  function onEnd(): void {
    isDragging.value = false
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    localStorage.setItem('arc-ai-input-height', String(inputHeight.value))
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onEnd)
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onEnd)
}

function handleSend(): void {
  const value = text.value.trim()
  if (!value || props.disabled) return
  const prefix = activeMode.value !== '问答' ? `[${activeMode.value}] ` : ''
  emit('send', prefix + value)
  text.value = ''
}

function handleKey(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    handleSend()
  }
}
</script>

<template>
  <div class="ai-composer">
    <!-- Drag handle -->
    <div
      class="drag-handle"
      :class="{ dragging: isDragging }"
      @mousedown="startDrag"
    >
      <GripHorizontal :size="14" class="drag-icon" />
    </div>

    <div class="composer-toolbar">
      <button class="composer-btn" @click="emit('open-commands')">
        <ChevronDown :size="12" />
        指令面板
      </button>
      <button class="composer-btn active" @click="emit('open-context')">
        <Info :size="11" />
        上下文
        <span class="composer-ctx-count">{{ enabledContextCount }}</span>
      </button>
    </div>

    <div v-if="hasSelection" class="composer-selection">
      <Pen :size="12" class="selection-icon" />
      <span class="composer-selection-text">{{ selectionPreview }}</span>
      <button class="composer-selection-close" @click="emit('clear-selection')">
        <X :size="10" />
      </button>
    </div>

    <div class="composer-input-wrap" :class="{ disabled }">
      <div class="composer-mode-tabs">
        <button
          v-for="mode in modes"
          :key="mode"
          class="composer-mode-tab"
          :class="{ active: activeMode === mode }"
          @click="activeMode = mode"
        >
          {{ mode }}
        </button>
      </div>
      <textarea
        v-model="text"
        :placeholder="disabled ? 'AI 正在生成...' : placeholders[activeMode]"
        :disabled="disabled"
        :style="{ height: inputHeight + 'px' }"
        @keydown="handleKey"
      />
      <div v-if="activeMode === '续写' && !disabled" class="composer-mode-hint">
        续写适合接着写一小段。要按大纲生成整章正文，请用
        <button class="composer-mode-hint-link" @click="emit('generate-draft')">生成初稿</button>。
      </div>
      <div class="composer-input-footer">
        <button v-if="disabled" class="composer-send stop" @click="$emit('stop')">
          <Square :size="12" />
        </button>
        <button v-else class="composer-send" :disabled="!text.trim()" @click="handleSend">
          <ArrowUp :size="14" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-composer {
  border-top: 1px solid var(--arc-border);
  background: var(--arc-bg-surface);
  padding: 0 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* ── Drag Handle ── */
.drag-handle {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 12px;
  cursor: row-resize;
  position: relative;
  flex-shrink: 0;
  opacity: 0.4;
  transition: opacity 0.15s;
}

.drag-handle:hover,
.drag-handle.dragging {
  opacity: 1;
}

.drag-icon {
  color: var(--arc-text-hint);
  transition: color 0.15s;
}

.drag-handle:hover .drag-icon,
.drag-handle.dragging .drag-icon {
  color: var(--arc-primary);
}

/* ── Toolbar ── */
.composer-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
}

.composer-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border: 1px solid var(--arc-border);
  border-radius: 8px;
  background: var(--arc-bg-surface);
  color: var(--arc-text-secondary);
  font-size: 11.5px;
  cursor: pointer;
  transition: all 0.15s;
}

.composer-btn:hover {
  border-color: var(--arc-border-strong);
  color: var(--arc-text-primary);
}

.composer-btn.active {
  background: var(--arc-primary-soft);
  color: var(--arc-primary);
  border-color: color-mix(in srgb, var(--arc-primary) 15%, var(--arc-border));
}

.composer-ctx-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 15px;
  height: 15px;
  border-radius: 999px;
  background: var(--arc-primary);
  color: white;
  font-size: 9px;
  font-weight: 600;
  padding: 0 4px;
}

/* ── Selection Preview ── */
.composer-selection {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--arc-primary) 5%, var(--arc-bg-weak));
  border: 1px solid color-mix(in srgb, var(--arc-primary) 12%, var(--arc-border));
  font-size: 11px;
}

.selection-icon {
  color: var(--arc-primary);
  flex-shrink: 0;
}

.composer-selection-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--arc-text-secondary);
}

.composer-selection-close {
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--arc-text-hint);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.composer-selection-close:hover {
  background: var(--arc-bg-surface-hover);
  color: var(--arc-text-primary);
}

/* ── Input Wrap ── */
.composer-input-wrap {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--arc-border);
  border-radius: 12px;
  background: var(--arc-bg-weak);
  transition: all 0.2s;
  overflow: hidden;
}

.composer-input-wrap:focus-within {
  border-color: var(--arc-primary);
  background: var(--arc-bg-surface);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--arc-primary) 8%, transparent);
}

.composer-input-wrap.disabled {
  opacity: 0.6;
}

/* ── Mode Tabs ── */
.composer-mode-tabs {
  display: flex;
  padding: 6px 8px 0;
  gap: 2px;
}

.composer-mode-tab {
  padding: 4px 10px;
  font-size: 11px;
  color: var(--arc-text-hint);
  cursor: pointer;
  border-radius: 6px;
  border: none;
  background: transparent;
  transition: all 0.15s;
  font-weight: 500;
}

.composer-mode-tab:hover {
  color: var(--arc-text-secondary);
}

.composer-mode-tab.active {
  color: var(--arc-text-primary);
  background: var(--arc-bg-surface);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
  font-weight: 600;
}

/* ── Textarea ── */
.composer-input-wrap textarea {
  width: 100%;
  border: none;
  outline: none;
  background: transparent;
  padding: 8px 12px;
  font-size: 13px;
  line-height: 1.55;
  resize: none;
  font-family: inherit;
  color: var(--arc-text-primary);
  user-select: text;
  min-height: 48px;
}

.composer-mode-hint {
  padding: 0 12px 6px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--arc-text-hint);
}

.composer-mode-hint-link {
  border: none;
  background: transparent;
  padding: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--arc-primary);
  cursor: pointer;
}

.composer-mode-hint-link:hover {
  text-decoration: underline;
}

/* ── Footer ── */
.composer-input-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 4px 6px 6px;
}

.composer-send {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: none;
  background: var(--arc-primary);
  color: white;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}

.composer-send:hover:not(:disabled) {
  background: var(--arc-primary-hover);
}

.composer-send:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.composer-send.stop {
  background: #ef4444;
  animation: pulse-stop 1.5s ease-in-out infinite;
}

.composer-send.stop:hover {
  background: #dc2626;
}

@keyframes pulse-stop {
  0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4); }
  50% { box-shadow: 0 0 0 4px rgba(239, 68, 68, 0); }
}
</style>
