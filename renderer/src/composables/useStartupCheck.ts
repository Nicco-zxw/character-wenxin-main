import { ref, onMounted } from 'vue'
import { LOCAL_ANNOUNCEMENTS, resolveFreshAnnouncements, resolveLatestAnnouncementDate } from '@/features/announcements/announcements'

export type StatusIndicator = 'none' | 'new' | 'error'

const STORAGE_KEY = 'arc:announcement-last-viewed'

const announcementStatus = ref<StatusIndicator>('none')
const updateStatus = ref<StatusIndicator>('none')
let latestAnnouncementDate = ''
let checked = false

function resolveFallbackAnnouncementStatus(): void {
  latestAnnouncementDate = resolveLatestAnnouncementDate(LOCAL_ANNOUNCEMENTS)
  const lastViewed = localStorage.getItem(STORAGE_KEY) ?? ''
  announcementStatus.value = latestAnnouncementDate > lastViewed ? 'new' : 'error'
}

async function checkAnnouncements(): Promise<void> {
  try {
    const res = await window.characterArc.fetchAnnouncements()
    if (!res.success) {
      resolveFallbackAnnouncementStatus()
      return
    }
    const resolution = resolveFreshAnnouncements(res.data, LOCAL_ANNOUNCEMENTS)
    latestAnnouncementDate = resolution.latestDate
    const lastViewed = localStorage.getItem(STORAGE_KEY) ?? ''
    announcementStatus.value = latestAnnouncementDate > lastViewed ? 'new' : 'none'
  } catch {
    resolveFallbackAnnouncementStatus()
  }
}

async function checkUpdate(): Promise<void> {
  try {
    const result = await window.characterArc.checkUpdate()
    if (!result.success) {
      updateStatus.value = 'error'
      return
    }
    updateStatus.value = result.result?.hasUpdate ? 'new' : 'none'
  } catch {
    updateStatus.value = 'error'
  }
}

function markAnnouncementRead(date?: string): void {
  const viewedDate = date || latestAnnouncementDate
  if (viewedDate) {
    latestAnnouncementDate = viewedDate > latestAnnouncementDate ? viewedDate : latestAnnouncementDate
    localStorage.setItem(STORAGE_KEY, viewedDate)
  }
  announcementStatus.value = 'none'
}

function markUpdateRead(): void {
  updateStatus.value = 'none'
}

export function useStartupCheck() {
  onMounted(() => {
    if (!checked) {
      checked = true
      checkAnnouncements()
      checkUpdate()
    }
  })

  return {
    announcementStatus,
    updateStatus,
    markAnnouncementRead,
    markUpdateRead
  }
}
