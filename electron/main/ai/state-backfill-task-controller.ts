export type ActiveBackfillTaskStatus = 'running' | 'pausing' | 'paused'

/** 在章节边界协作式暂停，避免中断正在进行的 AI 请求并把章节误记为失败。 */
export class BackfillTaskPauseController {
  private pauseRequested = false
  private currentStatus: ActiveBackfillTaskStatus = 'running'
  private resumeWaiter: (() => void) | null = null

  get status(): ActiveBackfillTaskStatus {
    return this.currentStatus
  }

  requestPause(): ActiveBackfillTaskStatus {
    if (this.currentStatus === 'running') {
      this.pauseRequested = true
      this.currentStatus = 'pausing'
    }
    return this.currentStatus
  }

  resume(): ActiveBackfillTaskStatus {
    this.pauseRequested = false
    this.currentStatus = 'running'
    this.resumeWaiter?.()
    this.resumeWaiter = null
    return this.currentStatus
  }

  async waitIfPaused(onStatusChange: (status: ActiveBackfillTaskStatus) => void): Promise<void> {
    if (!this.pauseRequested) return

    this.currentStatus = 'paused'
    onStatusChange(this.currentStatus)
    await new Promise<void>((resolve) => {
      this.resumeWaiter = resolve
    })
    this.currentStatus = 'running'
    onStatusChange(this.currentStatus)
  }
}
