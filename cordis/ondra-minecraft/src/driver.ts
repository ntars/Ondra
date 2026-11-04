/**
 * 驱动端口与「没有驱动」的默认实现。
 *
 * ## 为什么不直接 `import mineflayer`
 *
 * 三层原因，缺一层都足以否掉这个做法：
 *
 * 1. **本仓禁装依赖**（master-plan §16.3 / 手册施工边界），`mineflayer` 不在任何 `dependencies` 里；
 *    在 `cordis/` 里直接 `import 'mineflayer'` 会让整个插件包的解析在装载期失败——
 *    而且失败发生在**别人的进程里**，症状是「装了插件之后应用起不来」。
 * 2. **跨包 import 禁令**：本仓规定插件不得 import 另一个包的源码（§6 禁令 4），
 *    而驱动实现属于「壳侧接线层」，不在本包职责内。
 * 3. **猜 API 的代价不可接受**：Mineflayer 的 `createBot`、`bot.chat`、事件名与版本协商
 *    都没有仓内依据（`grep mineflayer` 0 命中）。写一版猜参数的实现，
 *    坏形态是「连上了但什么也收不到」——与「根本没连」在界面上完全同形（纪律 101）。
 *
 * 所以：端口 + `MissingDriver` 如实报 `no-driver`。接上真驱动只需 `useDriver()`。
 *
 * ## 驱动实现的四条硬要求（写进契约，不是建议）
 *
 * 1. `connect()` 失败要回 `ok:false` 且带原因，**不要抛错**（抛了本包也会接住，但会丢原因码）；
 * 2. `chat()` / `command()` **原样发**：不许加前后缀、不许内部重试、不许拆条；
 * 3. `snapshot()` 只回事实，**不做推断**（「她大概在挖矿」这种话归 L3）；
 * 4. `disconnect()` 必须幂等，且必须在 5 秒内结束（服务端可能已经不响应）。
 */

import type {
  ChatLine,
  DriverResult,
  McSnapshot,
  MinecraftDriver,
  ServerTarget,
} from './types.js'

/**
 * 「没有驱动」的实现。
 *
 * `id === 'none'` 与 `reason === 'no-driver'` 能让面板与日志立刻分清
 * 「没接驱动」与「驱动坏了」——两者的排查方向完全相反（纪律 143）。
 */
export class MissingDriver implements MinecraftDriver {
  /** 来源名。 */
  readonly id = 'none'

  /**
   * 连接（永远失败）。
   * @param _target 目标（未使用）。
   * @param _timeoutMs 超时（未使用）。
   */
  async connect(_target: ServerTarget, _timeoutMs: number): Promise<DriverResult<McSnapshot>> {
    return {
      ok: false,
      reason: 'no-driver',
      detail: '没有 Minecraft 驱动：本包只做闸门与整形，不实现协议。',
    }
  }

  /** 断开（无事可做）。 */
  async disconnect(): Promise<DriverResult<null>> {
    return { ok: true, data: null }
  }

  /**
   * 发聊天（永远失败）。
   * @param _text 正文（未使用）。
   */
  async chat(_text: string): Promise<DriverResult<null>> {
    return { ok: false, reason: 'no-driver', detail: '没有 Minecraft 驱动，发不出去。' }
  }

  /**
   * 发指令（永远失败）。
   * @param _text 指令（未使用）。
   */
  async command(_text: string): Promise<DriverResult<null>> {
    return { ok: false, reason: 'no-driver', detail: '没有 Minecraft 驱动，发不出去。' }
  }

  /** 读状态（永远失败）。 */
  async snapshot(): Promise<DriverResult<McSnapshot>> {
    return { ok: false, reason: 'no-driver', detail: '没有 Minecraft 驱动，读不到状态。' }
  }
}

/**
 * 判驱动是否可用（有四个方法才算）。
 * @param driver 驱动。
 */
export function driverReady(driver: MinecraftDriver): boolean {
  return driver.id !== 'none'
}

/**
 * 把后端快照收成契约。**缺字段就省字段，不补默认值**。
 *
 * 「生命值没读到」与「生命值是 20」是两件事：补个 0 会让上层说「她快死了」，
 * 补个 20 会让上层说「她满血」——两种都是编造。
 * @param raw 驱动返回。
 * @param fallbackAt 驱动没给时刻时的兜底。
 * @param keep 最近聊天保留条数。
 */
export function normalizeSnapshot(raw: unknown, fallbackAt: number, keep: number): McSnapshot | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const node = raw as Record<string, unknown>

  const server = typeof node['server'] === 'string' ? node['server'] : ''
  const username = typeof node['username'] === 'string' ? node['username'] : ''
  if (server === '' || username === '') return null

  const atRaw = node['at']
  const at = typeof atRaw === 'number' && Number.isFinite(atRaw) && atRaw > 0 ? atRaw : fallbackAt

  const health = unitOf(node['health'], 20)
  const food = unitOf(node['food'], 20)
  const players = countOf(node['players'])
  const dimension = typeof node['dimension'] === 'string' && node['dimension'] !== '' ? node['dimension'] : undefined
  const position = positionOf(node['position'])
  const recentChat = chatOf(node['recentChat'], keep)

  return {
    at,
    server,
    username,
    recentChat,
    ...(health === undefined ? {} : { health }),
    ...(food === undefined ? {} : { food }),
    ...(players === undefined ? {} : { players }),
    ...(dimension === undefined ? {} : { dimension }),
    ...(position === undefined ? {} : { position }),
  }
}

/**
 * 取 0–max 的数。
 * @param value 原始值。
 * @param max 上界。
 */
function unitOf(value: unknown, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value < 0 || value > max) return undefined
  return value
}

/**
 * 取非负整数。
 * @param value 原始值。
 */
function countOf(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.trunc(value)
}

/**
 * 取坐标。
 * @param value 原始值。
 */
function positionOf(value: unknown): McSnapshot['position'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const node = value as Record<string, unknown>
  const x = node['x']
  const y = node['y']
  const z = node['z']
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return undefined
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined
  return { x, y, z }
}

/**
 * 取最近聊天（只保留尾部 N 条，且丢掉形状不对的条目）。
 *
 * **不截断正文**：正文在进上下文前会由 `describeSnapshot()` 统一截断，
 * 两处各截一次会让「显示的长度」与「实际发的长度」对不上。
 * @param value 原始值。
 * @param keep 保留条数。
 */
function chatOf(value: unknown, keep: number): readonly ChatLine[] {
  if (!Array.isArray(value)) return Object.freeze([] as readonly ChatLine[])
  const out: ChatLine[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const node = item as Record<string, unknown>
    const text = node['text']
    if (typeof text !== 'string' || text === '') continue
    const from = typeof node['from'] === 'string' && node['from'] !== '' ? node['from'] : 'system'
    const atRaw = node['at']
    const at = typeof atRaw === 'number' && Number.isFinite(atRaw) && atRaw > 0 ? atRaw : 0
    out.push({ from, text, at })
  }
  const limit = Math.max(1, Math.trunc(keep))
  return Object.freeze(out.slice(Math.max(0, out.length - limit)))
}

/**
 * 快照的模型可见正文。
 *
 * **刻意不带坐标精度**：`x/y/z` 取整到个位即可回答「在哪儿」，
 * 精确到小数位只是在上下文里多烧 token。
 * @param snapshot 快照。
 */
export function describeSnapshot(snapshot: McSnapshot): string {
  const lines: string[] = [`服务器：${snapshot.server}`, `用户名：${snapshot.username}`]
  if (snapshot.health === undefined) lines.push('生命：未读到')
  else lines.push(`生命：${Math.round(snapshot.health)}/20`)
  if (snapshot.food === undefined) lines.push('饥饿：未读到')
  else lines.push(`饥饿：${Math.round(snapshot.food)}/20`)
  if (snapshot.position !== undefined) {
    lines.push(
      `坐标：${Math.round(snapshot.position.x)}, ${Math.round(snapshot.position.y)}, ${Math.round(snapshot.position.z)}`,
    )
  }
  if (snapshot.dimension !== undefined) lines.push(`维度：${snapshot.dimension}`)
  if (snapshot.players !== undefined) lines.push(`在线人数：${snapshot.players}`)
  if (snapshot.recentChat.length === 0) {
    lines.push('最近聊天：无')
  } else {
    lines.push('最近聊天：')
    for (const line of snapshot.recentChat) {
      const text = line.text.length > 120 ? `${line.text.slice(0, 120)}…` : line.text
      lines.push(`- ${line.from}: ${text}`)
    }
  }
  return lines.join('\n')
}
