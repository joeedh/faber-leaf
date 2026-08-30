/**
 * Async work an addon needs finished before the app builds its UI or reads a
 * file — the seam that replaced core's hardcoded `await sculptcore.getWasm()`
 * in `entry_point.js` (P16 W3b step 4).
 *
 * `AddonManager.start()` awaits every registered task after the enable pass, so
 * a task may be registered from `register(api)` and is guaranteed to have run
 * before `startAddons()` resolves. A task that rejects is reported and skipped:
 * one addon failing to warm up must not take the whole boot down.
 */

export type BootTask = () => Promise<void>

const tasks = new Map<BootTask, string>()

/** `label` names the task in the console when it fails. */
export function registerBootTask(fn: BootTask, label: string): void {
  tasks.set(fn, label)
}

export function unregisterBootTask(fn: BootTask): void {
  tasks.delete(fn)
}

export function listBootTasks(): readonly string[] {
  return [...tasks.values()]
}

/**
 * Runs every registered task concurrently and resolves once all have settled.
 * Tasks registered while this is running are not picked up — call it again.
 */
export async function runBootTasks(): Promise<void> {
  const pending = [...tasks].map(async ([fn, label]) => {
    try {
      await fn()
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`boot task "${label}" failed:`, err)
    }
  })
  await Promise.all(pending)
}
