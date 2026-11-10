/**
 * 一键静音（§12.12、§5.7「静音态」）。
 *
 * ## 它管什么，不管什么
 *
 * | 管 | 不管 |
 * | --- | --- |
 * | 截止时刻（`mutedUntil`） | 声音本身（§12.12 的音量、三种音效） |
 * | 到期自动解除 | 主动消息的拦截（那在宿主 O-042 的 `gate()` 里） |
 *
 * 这一层只回答一个问题：**现在是不是静音，到几点**。界面拿它显示
 * Spine 的「静音」二字与托盘菜单的文案，宿主拿它决定要不要让她开口。
 *
 * ## 为什么静音是「时刻」而不是「开关」
 *
 * 规范写的是「静音 1 小时」，不是「静音」。开关的语义是「一直关到我
 * 想起来打开」，而人一旦忘了打开，她就永远不说话了——那是**bug 的形状**，
 * 不是功能。存一个截止时刻，到期自然恢复，最坏情况是少陪一小时。
 *
 * 这也让「重复点两次」有了确定的含义：第二次把截止时刻推到下一个
 * 一小时后，而不是把静音取消。取消是单独的一步（见 `unmute()`），
 * 对应托盘菜单变成「取消静音」之后的点击——菜单文字变了，用户
 * 看到的与做出来的一致。
 *
 * ## 为什么落 localStorage 而不是交给壳
 *
 * 静音只需要主窗口知道（Spine 在主窗口），偏好窗口不显示它。
 * 落盘的目的只有「重启后仍在静音期内」，`localStorage` 足够，
 * 不必为它加一条跨进程 IPC。真正要跨进程的那一半（宿主拦不拦主动
 * 消息）由宿主自己的状态文件负责，两处不共用一个真源——它们算的是
 * 同一个事实，但一个是界面显示、一个是投递判定，串成一条链反而
 * 会让「界面显示静音、宿主照发」这类不一致更难查。
 *
 * 到期时刻是**绝对时间戳**，不是「剩余毫秒」。存剩余毫秒的话，
 * 应用关掉两小时再开，那两小时不算数，静音会变长——用户看到的是
 * 「明明过了一小时，怎么还静音」。
 */

import { useSyncExternalStore } from 'react'
import { isDesktopShell, invokeShell } from './shell.ts'

/** localStorage 的键。带命名空间前缀，与 `ondra.theme` 等并列。 */
const KEY = 'ondra.mutedUntil'

/** 一键静音的时长。规范只给了这一档（§12.10 菜单项「静音 1 小时」）。 */
export const MUTE_DURATION = 60 * 60 * 1000

/** 截止时刻（毫秒时间戳）。`0` 表示没静音。 */
let until = 0

/** 到期定时器。静音期间只挂一个，避免重复点按时越堆越多。 */
let timer: ReturnType<typeof globalThis.setTimeout> | undefined

/** 订阅者。`useSyncExternalStore` 要求引用稳定，因此只建一次。 */
const listeners = new Set<() => void>()

/** 通知订阅者。 */
function notify(): void {
  for (const listener of listeners) listener()
}

/** 安全读盘。隐私模式下 localStorage 会抛，一律当作没静音。 */
function read(): number {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    if (raw === null || raw === undefined) return 0
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

/** 安全写盘。写失败只影响「重启后还在」，不影响本次生效。 */
function write(value: number): void {
  try {
    if (value > 0) globalThis.localStorage?.setItem(KEY, String(value))
    else globalThis.localStorage?.removeItem(KEY)
  } catch { /* 隐私模式：本次仍生效，只是不持久 */ }
}

/**
 * 重挂到期定时器。
 *
 * ## 为什么要定时器，而不是等界面下次渲染再判
 *
 * 判「现在是否静音」是纯比较，随时可算。但界面不会自己重算：
 * 用户静音后就去干别的了，一小时里一次渲染都不会发生，Spine 上那两个字
 * 会一直挂着。定时器是唯一能在「没人操作」时把界面推回正确状态的机制。
 *
 * 时长上限按 `setTimeout` 的 32 位限制夹一次：超过约 24.8 天会溢出成
 * 立即触发。当前只有 1 小时一档，但这不是把上限当成「不会发生」的理由。
 */
function arm(): void {
  if (timer !== undefined) globalThis.clearTimeout(timer)
  timer = undefined
  if (until <= 0) return

  const delay = until - Date.now()
  if (delay <= 0) return
  timer = globalThis.setTimeout(() => {
    timer = undefined
    // 到点了。清盘并通知，界面自己会把「静音」两个字去掉。
    // 托盘菜单文字也要跟着变回去，否则它会一直写着「取消静音」——
    // 那时点它什么都不会发生，用户会以为托盘坏了。
    until = 0
    write(0)
    notify()
    syncTray()
  }, Math.min(delay, 2_147_483_647))
}

/**
 * 读盘并落定。启动时调一次。
 *
 * 过期就清掉：存着一个过去的时刻，下次 `isMuted()` 会算出负数剩余，
 * 虽然判定仍为「没静音」，但 `mutedUntil()` 会返回一个骗人的值。
 */
export function loadMute(): void {
  const stored = read()
  until = stored > Date.now() ? stored : 0
  if (until === 0 && stored !== 0) write(0)
  arm()
}

/** 当前是否静音。 */
export function isMuted(at: number = Date.now()): boolean {
  return until > at
}

/** 静音截止时刻。没静音时为 `0`。 */
export function mutedUntil(): number {
  return until
}

/** 剩余毫秒。没静音时为 `0`。 */
export function mutedRemaining(at: number = Date.now()): number {
  return until > at ? until - at : 0
}

/**
 * 把截止时刻写成 `HH:MM`。
 *
 * 提示条用「静音到 15:20」而不是「已静音 1 小时」：前者告诉用户
 * **什么时候会自动恢复**，后者只说了刚才发生了什么。用户真正想知道的
 * 是「它什么时候自己好」，因为那是他不必再操作的条件。
 *
 * 用 24 小时制、补零：与场景层「作息」的 `HH:MM` 同形，全项目只此一种
 * 时间写法。
 *
 * @param at 毫秒时间戳。
 */
export function formatClock(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * 把静音截止时刻设为「此刻 + 时长」。
 *
 * 已经是静音状态时**照样重新计时**：用户在静音中又点了一次菜单，
 * 意思是「再给我一小时」。若做成「第二次取消」，那他想延长时长
 * 就没有任何入口——而延长比取消更常用。
 *
 * @param ms 时长，默认 1 小时。
 * @returns 新的截止时刻。
 */
export function muteFor(ms: number = MUTE_DURATION): number {
  until = Date.now() + Math.max(1000, Math.trunc(ms))
  write(until)
  arm()
  notify()
  syncTray()
  return until
}

/** 取消静音。 */
export function unmute(): void {
  if (until === 0) return
  until = 0
  write(0)
  arm()
  notify()
  syncTray()
}

/**
 * 把静音状态告诉壳，让托盘菜单文字跟着变。
 *
 * ## 为什么必须有这一步
 *
 * 托盘菜单项的字面是「静音 1 小时」。静音之后它若还写着这句话，用户
 * 想取消时没有任何入口可用——他会以为只能等一小时。文字必须变成
 * 「取消静音」，那才是当时的真实动作。
 *
 * 浏览器开发态没有托盘，静默跳过：这不是失败，是没有那个东西。
 */
function syncTray(): void {
  if (!isDesktopShell()) return
  void invokeShell<null>('set_tray_muted', { muted: isMuted() }).catch(() => {
    /* 托盘不可用（Linux 无 StatusNotifier）时命令会失败。界面仍按静音显示，
       只是菜单文字没跟上——不值得为它弹一条提示打断用户。 */
  })
}

/** 订阅静音变化。返回取消订阅函数。 */
export function subscribeMute(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * 读静音状态的 React 钩子。
 *
 * 快照返回**布尔值**而不是对象：`useSyncExternalStore` 每次渲染都比对
 * 快照引用，返回新造的对象会让它永远认为「变了」，进而无限重渲染。
 */
export function useMuted(): boolean {
  return useSyncExternalStore(subscribeMute, isMuted, () => false)
}
