import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { ComputedRef, WatchSource } from 'vue'

interface IncrementalListOptions {
  initialSize?: number
  batchSize?: number
}

export function useIncrementalList<T>(
  source: ComputedRef<readonly T[]>,
  resetKey: WatchSource<unknown>,
  options: IncrementalListOptions = {}
): ComputedRef<T[]> {
  const initialSize = options.initialSize ?? 40
  const batchSize = options.batchSize ?? 40
  const visibleCount = ref(0)
  let frameId: number | null = null

  function cancelScheduledBatch(): void {
    if (frameId === null) return
    window.cancelAnimationFrame(frameId)
    frameId = null
  }

  function scheduleNextBatch(): void {
    cancelScheduledBatch()
    if (visibleCount.value >= source.value.length) return

    frameId = window.requestAnimationFrame(() => {
      frameId = null
      visibleCount.value = Math.min(source.value.length, visibleCount.value + batchSize)
      scheduleNextBatch()
    })
  }

  function resetVisibleItems(): void {
    cancelScheduledBatch()
    visibleCount.value = Math.min(initialSize, source.value.length)
    scheduleNextBatch()
  }

  watch(resetKey, resetVisibleItems, { flush: 'sync' })
  watch(
    () => source.value.length,
    (length) => {
      if (visibleCount.value === 0) {
        visibleCount.value = Math.min(initialSize, length)
      } else if (length < visibleCount.value) {
        visibleCount.value = length
      }
      scheduleNextBatch()
    },
    { immediate: true, flush: 'sync' }
  )

  onBeforeUnmount(cancelScheduledBatch)

  return computed(() => source.value.slice(0, visibleCount.value))
}
