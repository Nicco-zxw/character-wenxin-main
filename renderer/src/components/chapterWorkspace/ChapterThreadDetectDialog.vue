<script setup lang="ts">
import { NButton, NCheckbox, NModal, NTag } from 'naive-ui'
import type { DetectedThread } from './useChapterThreadDetect'

defineProps<{
  show: boolean
  detected: DetectedThread[]
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  confirm: []
}>()

function close(): void {
  emit('update:show', false)
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="AI 识别到的潜在伏笔"
    :style="{ width: 'min(560px, 92vw)' }"
    :mask-closable="false"
    @update:show="(v) => $emit('update:show', v)"
  >
    <div class="list">
      <div
        v-for="(item, idx) in detected"
        :key="idx"
        class="item"
        :class="{ selected: item.selected }"
        @click="item.selected = !item.selected"
      >
        <n-checkbox v-model:checked="item.selected" @click.stop />
        <div class="content">
          <div class="title">{{ item.title }}</div>
          <div class="desc">{{ item.description }}</div>
          <div v-if="item.tags.length" class="tags">
            <n-tag v-for="tag in item.tags" :key="tag" size="tiny" :bordered="false">{{ tag }}</n-tag>
          </div>
        </div>
      </div>
    </div>
    <template #footer>
      <div class="actions">
        <n-button @click="close">取消</n-button>
        <n-button type="primary" @click="$emit('confirm')">
          添加选中（{{ detected.filter((t) => t.selected).length }}）
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 60vh;
  overflow-y: auto;
}

.item {
  display: flex;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--arc-border);
  border-radius: var(--arc-radius-md);
  background: var(--arc-bg-surface);
  cursor: pointer;
  transition: 0.15s;
  user-select: text;
}

.item:hover {
  border-color: var(--arc-primary);
}

.item.selected {
  border-color: var(--arc-primary);
  background: var(--arc-primary-soft);
}

.content {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.title {
  font-size: 14px;
  font-weight: 600;
  color: var(--arc-text-primary);
}

.desc {
  font-size: 12px;
  line-height: 1.6;
  color: var(--arc-text-secondary);
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}
</style>
