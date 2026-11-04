/**
 * 通道能力注册表。**出厂为空表**——这不是没写完，是刻意的。
 *
 * ## 为什么不内置手册 §9.11 的那张实测表
 *
 * §9.11 的分条上限（telegram 4000 / discord 1900 / wecom 2000 /
 * wechat-official 800 / qq-official 1200 …）是**旧项目实读值**，
 * 而每个通道的 `Config` 才是它自己的真源（master-plan §9.12 明确要求
 * 「字段定义由各插件用 `Config` 声明」）。本插件内置一份的后果是：
 * 同一件事有两个数，用户改了适配器配置、这里还是旧数，
 * 而症状是「消息被平台截断」——查不出跟谁有关。
 *
 * 内置表的第二个毛病是新通道永远漏：加一个适配器要改两处，
 * 漏了就说「未知通道」，而它其实只是新来的。
 *
 * 所以：**空表 + 一个明确的「未注册」返回值**。适配器装载时
 * `registerChannel()`，关掉时由 disposer 撤销（手册 §3.3-4 可逆注册）。
 *
 * ## 为什么 disposer 要比对对象身份
 *
 * 同一个 id 在「先注销再注册」之后是**另一个视图**。若 disposer 只按 id
 * 删除，旧的那个会把新注册的顺手删掉——表现为「重载适配器之后能力就空了」。
 */

import type { ChannelCaps, ChannelSpec, ChannelView, RegisterResult } from './types.js'
import { CHANNEL_FEATURES, NAME_RE, isChannelFeature } from './types.js'

/**
 * 校验并冻结一份能力声明。
 * @param caps 原始声明。
 * @returns 合法时返回冻结副本，否则 `undefined`。
 */
export function normalizeCaps(caps: unknown): ChannelCaps | undefined {
  if (typeof caps !== 'object' || caps === null) return undefined
  const raw = caps as Partial<ChannelCaps>

  const maxChars = raw.maxChars
  if (typeof maxChars !== 'number' || !Number.isFinite(maxChars) || maxChars < 1) return undefined

  const given = Array.isArray(raw.features) ? raw.features : []
  const features: string[] = []
  for (const item of given) {
    if (!isChannelFeature(item)) return undefined
    if (!features.includes(item)) features.push(item)
  }

  // 只保留合法项，并按固定顺序排好：能力表要能稳定比较，不能靠调用方顺序。
  const ordered = CHANNEL_FEATURES.filter(feature => features.includes(feature))

  return Object.freeze({
    maxChars: Math.trunc(maxChars),
    privateChat: raw.privateChat === true,
    groupChat: raw.groupChat === true,
    mentionRequired: raw.mentionRequired === true,
    features: Object.freeze(ordered),
  })
}

/** 通道能力注册表。 */
export class ChannelRegistry {
  private readonly entries = new Map<string, ChannelView>()

  /**
   * 注册一个通道。
   * @param spec 声明。
   * @param at 注册时刻（毫秒）。
   */
  register(spec: ChannelSpec, at: number): RegisterResult {
    if (typeof spec !== 'object' || spec === null) return { ok: false, reason: 'bad-id' }
    if (typeof spec.id !== 'string' || !NAME_RE.test(spec.id)) return { ok: false, reason: 'bad-id' }
    if (this.entries.has(spec.id)) return { ok: false, reason: 'duplicate' }

    const caps = normalizeCaps(spec.caps)
    if (caps === undefined) return { ok: false, reason: 'bad-caps' }

    const label = typeof spec.label === 'string' && spec.label.trim() !== '' ? spec.label.trim() : spec.id
    const view: ChannelView = Object.freeze({ id: spec.id, label, caps, registeredAt: at })
    this.entries.set(spec.id, view)

    return {
      ok: true,
      dispose: () => {
        // 只删自己那一份（见文件头）。
        if (this.entries.get(spec.id) === view) this.entries.delete(spec.id)
      },
    }
  }

  /**
   * 读一个通道。
   * @param id 通道 id。
   */
  get(id: string): ChannelView | undefined {
    return this.entries.get(id)
  }

  /** 已注册的 id（按注册顺序）。 */
  ids(): readonly string[] {
    return [...this.entries.keys()]
  }

  /** 已注册数量。 */
  get size(): number {
    return this.entries.size
  }

  /** 清空（卸载时用）。 */
  clear(): void {
    this.entries.clear()
  }
}
