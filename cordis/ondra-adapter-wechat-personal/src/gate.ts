/**
 * 双闸门 + 白名单 + 冷却。**纯计算，不读盘、不碰网络、不发消息。**
 *
 * ## 为什么判序是「开关 → 确认 → 档案 → 拉黑 → 白名单空 → 白名单 → 冷却」
 *
 * 前三条是**资格**，后四条是**礼貌**：
 *
 * - 资格问题（她根本被允许存在吗）必须最先判，且失败时要能指名道姓说缺哪一条；
 * - 礼貌问题（这一次该不该回）放在后面，因为它们的处理方式不同（等一会 vs 永久不答）。
 *
 * 把冷却放在最前面，会让「没确认」的人看到 `cooldown` 这个原因，
 * 然后去查一个根本不存在的频控问题——这是最容易浪费时间的一种错。
 *
 * ## 白名单空 = 全拒（与 O-055「注册不参与判定」不矛盾）
 *
 * 手册 §6.2 原文：**白名单外不发信息**。空名单意味着「没有任何人在名单内」，
 * 所以默认行为必须是「谁也不理」，而不是「谁都能来」。
 * O-055 那条讲的是**便利信息**（注册的通道能力）不能当通行证；
 * 白名单是**安全闸**，两者不是同一件事，因此这里分成两个原因码：
 * `not-whitelisted`（名单非空但没他）与 `blocked`（被拉黑）。
 *
 * ## 冷却为什么不是限流器
 *
 * 它不是令牌桶，不压总量，只压「同一个会话连续两次回答的间隔」。
 * 目的只有一个：一个人连发五条时，不要出现五行回复挤在一起。
 * 所以它是 per-会话的、可配的、可关的（`cooldown-ms: 0`）。
 */

import type { GateInput, GateVerdict } from './types.js'
import { COOLDOWN_LIMIT, LOOPBACK_ADDRESSES } from './types.js'

/** 回环地址集合（由常量派生，不手抄第二份）。 */
const LOOPBACK_SET: ReadonlySet<string> = new Set(LOOPBACK_ADDRESSES.map(item => item.trim().toLowerCase()))

/**
 * 这个对端地址是不是本机。
 *
 * 三种写法都要认，否则「仅回环」会在某些客户端上变成「谁都不许连」：
 *
 * - `127.0.0.1`（IPv4）与 `127.x.x.x`（整个 127/8，宿主文档也是这个口径）；
 * - `::1` 与它的完整写法 `0:0:0:0:0:0:0:1`（IPv6）；
 * - `::ffff:127.0.0.1` 这类 IPv4-mapped 形式（Node 在双栈 socket 上给的就是它）。
 *
 * 地址缺失一律判**否**：拿不到对端地址时说「大概是本机吧」，就是把门焊死在地上。
 * @param address `req.socket.remoteAddress`。
 */
export function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false
  const raw = address.trim().toLowerCase()
  if (raw === '') return false
  // 有些实现会带方括号或端口，这里只取地址本体。
  const bare = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']') === -1 ? undefined : raw.indexOf(']')) : raw
  if (LOOPBACK_SET.has(bare)) return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)) return true
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)) return true
  return false
}

/**
 * 过闸。
 * @param input 判定输入。
 */
export function checkGate(input: GateInput): GateVerdict {
  // 1. 资格：开关。单独打开它不够，但它是第一道。
  if (!input.enable) return { ok: false, reason: 'disabled' }

  // 2. 资格：配置里的确认位。只认字面量 true（上游已保证）。
  if (!input.confirmed) return { ok: false, reason: 'not-confirmed' }

  // 3. 资格：确认档案。文件不在与「写着未确认」是两件事，分开报。
  if (!input.recordExists) return { ok: false, reason: 'no-confirm-record' }
  if (!input.record.confirmed) return { ok: false, reason: 'not-confirmed' }

  // 4. 群：默认不回（群聊不主动）。放在名单之前，因为「这是群」比「谁在群里」更根本。
  if (input.isGroup && !input.allowGroups) return { ok: false, reason: 'group-blocked' }

  // 5. 拉黑优先于白名单。
  if (input.block.includes(input.contact)) return { ok: false, reason: 'blocked' }

  // 6. 白名单：**空 = 全拒**。
  if (input.allow.length === 0) return { ok: false, reason: 'not-whitelisted' }
  if (!input.allow.includes(input.contact)) return { ok: false, reason: 'not-whitelisted' }

  // 7. 冷却：per-会话的最小间隔。
  if (input.cooldownMs > 0 && input.lastAnsweredAt > 0) {
    const span = input.now - input.lastAnsweredAt
    // 时钟回拨（span < 0）不算冷却：把「时间倒了一点」判成「她在冷却」没法解释。
    if (span >= 0 && span < input.cooldownMs) return { ok: false, reason: 'cooldown' }
  }

  return { ok: true }
}

/**
 * 记一次「答过了」。超过容量按最久没答的淘汰。
 * @param table 冷却表（就地修改）。
 * @param contact 会话对象。
 * @param at 时刻（毫秒）。
 */
export function markAnswered(table: Record<string, number>, contact: string, at: number): void {
  if (contact === '') return
  table[contact] = at
  const keys = Object.keys(table)
  if (keys.length <= COOLDOWN_LIMIT) return
  const ordered = keys.sort((left, right) => (table[left] ?? 0) - (table[right] ?? 0))
  for (const key of ordered.slice(0, keys.length - COOLDOWN_LIMIT)) delete table[key]
}

/**
 * 清掉已经过了冷却的条目。
 *
 * 冷却表不是账本：过了窗口的记录留着只是占内存，而容量一旦满，
 * 淘汰逻辑就得靠「最久没答」来猜——那还不如过期就删。
 * @param table 冷却表（就地修改）。
 * @param at 当前时刻。
 * @param cooldownMs 冷却（0 = 关闭，此时全部清掉）。
 */
export function pruneCooldown(table: Record<string, number>, at: number, cooldownMs: number): void {
  const span = Math.max(cooldownMs, 1_000)
  for (const [key, lastAt] of Object.entries(table)) {
    if (at - lastAt >= span) delete table[key]
  }
}

/**
 * 从任意输入解析冷却表。**永不抛错**，坏就回空表。
 * @param raw 已 `JSON.parse` 的输入。
 */
export function parseCooldown(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  const record = raw as Record<string, unknown>
  const table = record['cooldown']
  if (typeof table !== 'object' || table === null || Array.isArray(table)) return out
  for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[key] = value
  }
  return out
}
