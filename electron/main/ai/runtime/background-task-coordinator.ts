export type BackgroundTaskRunner<T> = (signal: AbortSignal) => Promise<T>

type RunningTask<T = unknown> = {
  fingerprint: string
  controller: AbortController
  promise: Promise<T>
}

/**
 * 按业务键协调后台任务：相同输入复用，更新输入则取消旧任务并以最新任务为准。
 */
export class BackgroundTaskCoordinator {
  private readonly running = new Map<string, RunningTask>()

  runLatest<T>(
    key: string,
    fingerprint: string,
    runner: BackgroundTaskRunner<T>
  ): Promise<T> {
    const existing = this.running.get(key)
    if (existing?.fingerprint === fingerprint) {
      return existing.promise as Promise<T>
    }

    existing?.controller.abort(new Error(`Background task superseded: ${key}`))

    const controller = new AbortController()
    const record = {
      fingerprint,
      controller,
      promise: Promise.resolve(undefined) as Promise<T>
    }
    record.promise = Promise.resolve()
      .then(() => runner(controller.signal))
      .finally(() => {
        if (this.running.get(key) === record) {
          this.running.delete(key)
        }
      })
    this.running.set(key, record)
    return record.promise
  }

  isRunning(key: string): boolean {
    return this.running.has(key)
  }

  cancel(key: string): boolean {
    const task = this.running.get(key)
    if (!task) return false
    task.controller.abort(new Error(`Background task canceled: ${key}`))
    return true
  }
}
