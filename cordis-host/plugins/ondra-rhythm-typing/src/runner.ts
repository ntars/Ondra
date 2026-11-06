/**
 * 等待一个「可被中途打断」的时长。
 *
 * 为什么不用 `await new Promise(r => setTimeout(r, ms))`：
 * 一个 9 秒的长停顿里用户又说话了，或者插件被卸载，那 9 秒必须**立刻结束**，
 * 而不是「等它自己醒过来再发现已经取消」。所以定时器与 `AbortSignal` 双通道：
 * 谁先到谁结束，且两条路径都保证只结束一次。
 *
 * 定时器句柄交给调用方登记（`timers` 集合），卸载时统一清——
 * 这是 O-003 的做法，全仓一致。
 */

/** 定时器句柄集合。 */
export type TimerSet = Set<ReturnType<typeof setTimeout>>

/**
 * 等一会儿，可被打断。
 *
 * **永不 reject**：打断是正常路径（取消 / 顶掉 / 卸载），不是异常。
 * @param ms 等待毫秒。≤0 时立即返回。
 * @param signal 打断信号。
 * @param timers 定时器登记表（由调用方在卸载时统一清）。
 */
export function sleep(ms: number, signal: AbortSignal | undefined, timers: TimerSet): Promise<void> {
  if (!(ms > 0)) return Promise.resolve()

  return new Promise<void>(resolve => {
    let finished = false

    const finish = (): void => {
      if (finished) return
      finished = true
      clearTimeout(handle)
      timers.delete(handle)
      if (signal !== undefined) signal.removeEventListener('abort', finish)
      resolve()
    }

    const handle = setTimeout(finish, Math.floor(ms))
    timers.add(handle)

    if (signal !== undefined) {
      if (signal.aborted) {
        finish()
        return
      }
      signal.addEventListener('abort', finish, { once: true })
    }
  })
}
