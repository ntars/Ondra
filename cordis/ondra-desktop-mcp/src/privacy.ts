/**
 * 隐私整形层：**把端口交来的值重建成只含白名单字段的新对象**。
 *
 * 为什么不是「过滤掉不该给的字段」，而是「只挑该给的字段」：
 * 过滤是黑名单，端口哪天多塞一个 `cmdline`、`env`、`clipboardText`，
 * 过滤表没更新就会漏出去，而且**不报错**——它会安静地进对话、进上下文缓存。
 * 只挑白名单则相反：多出来的字段一律不存在，端口加什么都进不来。
 *
 * 这一层也是手册「不做推断」的落地处：整形只做截断与取整，
 * **不推断用途、不推断意图、不补默认语义**。
 */

import type { BatteryBand, BatteryInfo, ClipboardKind, ClipboardMeta, FileHit, ForegroundInfo, ProcessItem, SysInfo } from './types.js'
import { BATTERY_CRITICAL, BATTERY_LOW, NAME_MAX, TITLE_MAX } from './types.js'

/** 剪贴板形态闭集（端口给别的值一律归 `unknown`，不猜）。 */
const CLIPBOARD_KINDS: readonly ClipboardKind[] = Object.freeze(['text', 'image', 'files', 'empty', 'unknown'])

/**
 * 截断到指定长度。
 * @param text 原文。
 * @param max 上限。
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  // 末尾补一个省略号，让人看得出被截断（而不是以为名字就那么长）。
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/**
 * 取一个有限数字，否则回退。
 * @param value 原值。
 * @param fallback 回退值。
 */
function numOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 进程整形。**输出里没有命令行**——因为 `ProcessItem` 没有这个字段。
 * @param raw 端口给的进程。
 */
export function poseProcess(raw: ProcessItem): ProcessItem {
  return Object.freeze({
    name: truncate(String(raw.name), NAME_MAX),
    pid: Math.trunc(numOf(raw.pid, -1)),
    cpu: Math.round(numOf(raw.cpu, -1) * 10) / 10,
    memMb: Math.round(numOf(raw.memMb, -1)),
  })
}

/**
 * 前台应用整形。
 * @param raw 端口给的前台应用。
 * @param includeTitle 是否保留窗口标题（配置项；关掉给空串而不是删除字段，避免消费方要判键是否存在）。
 */
export function poseForeground(raw: ForegroundInfo, includeTitle: boolean): ForegroundInfo {
  return Object.freeze({
    app: truncate(String(raw.app), NAME_MAX),
    title: includeTitle ? truncate(String(raw.title), TITLE_MAX) : '',
    pid: Math.trunc(numOf(raw.pid, -1)),
    at: Math.trunc(numOf(raw.at, 0)),
  })
}

/**
 * 剪贴板整形。**输出里没有内容**——`ClipboardMeta` 没有这个字段。
 * @param raw 端口给的元信息。
 */
export function poseClipboard(raw: ClipboardMeta): ClipboardMeta {
  const kind = CLIPBOARD_KINDS.includes(raw.kind) ? raw.kind : 'unknown'
  return Object.freeze({
    kind,
    chars: Math.max(0, Math.trunc(numOf(raw.chars, 0))),
    lines: Math.max(0, Math.trunc(numOf(raw.lines, 0))),
    pieces: Math.max(0, Math.trunc(numOf(raw.pieces, 0))),
    at: Math.trunc(numOf(raw.at, 0)),
  })
}

/**
 * 文件命中整形。
 *
 * `maskPaths` 打开时只给相对根目录的路径（不带用户名）；
 * 关掉时把根目录也拼回去。**两种都只到文件名一级，不给内容**。
 * @param raw 端口给的命中。
 * @param root 根目录绝对路径。
 * @param maskPaths 是否脱敏。
 */
export function poseHit(raw: FileHit, root: string, maskPaths: boolean): FileHit {
  const rel = String(raw.path).replace(/^\/+/, '')
  return Object.freeze({
    name: truncate(String(raw.name), NAME_MAX),
    path: maskPaths ? rel : `${root}/${rel}`,
    kind: raw.kind === 'dir' ? 'dir' : 'file',
    size: Math.max(0, Math.trunc(numOf(raw.size, 0))),
    mtime: Math.trunc(numOf(raw.mtime, 0)),
  })
}

/**
 * 系统状态整形。
 * @param raw 端口给的系统状态。
 */
export function poseSysinfo(raw: SysInfo): SysInfo {
  const battery = raw.battery === null ? null : poseBattery(raw.battery)
  const load = Array.isArray(raw.loadAvg) ? raw.loadAvg.filter(item => typeof item === 'number') : []
  return Object.freeze({
    platform: String(raw.platform),
    arch: String(raw.arch),
    cores: Math.max(0, Math.trunc(numOf(raw.cores, 0))),
    totalMb: Math.max(0, Math.round(numOf(raw.totalMb, 0))),
    freeMb: Math.max(0, Math.round(numOf(raw.freeMb, 0))),
    loadAvg: Object.freeze(load.map(item => Math.round(item * 100) / 100)),
    uptimeSec: Math.max(0, Math.trunc(numOf(raw.uptimeSec, 0))),
    battery,
  })
}

/**
 * 电池整形。
 * @param raw 端口给的电池。
 */
export function poseBattery(raw: BatteryInfo): BatteryInfo {
  return Object.freeze({
    level: Math.min(100, Math.max(-1, Math.round(numOf(raw.level, -1)))),
    charging: raw.charging === true,
    at: Math.trunc(numOf(raw.at, 0)),
  })
}

/**
 * 电量档位。
 *
 * 顺序刻意是「充电优先」：一台插着电、电量 8% 的机器**不该**被当成危机事件，
 * 否则每插一次电就发一次「她慌了」。拿不到读数（`null` / -1）报 `unknown`，
 * 不报 `critical`——「不知道」不能长得像「没电了」。
 * @param battery 电池读数。
 */
export function bandOf(battery: BatteryInfo | null): BatteryBand {
  if (battery === null) return 'unknown'
  if (battery.level < 0) return 'unknown'
  if (battery.charging) return 'charging'
  if (battery.level <= BATTERY_CRITICAL) return 'critical'
  if (battery.level <= BATTERY_LOW) return 'low'
  return 'normal'
}
