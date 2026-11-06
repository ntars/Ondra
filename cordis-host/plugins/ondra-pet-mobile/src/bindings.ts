/**
 * 三端绑定簿：谁是这个人的「那一只」。
 *
 * ## 为什么需要「绑」这件事
 *
 * 手册语料的痛点原话是「桌宠版、QQ 版、微信版本质是 3 种不同插件，并不是同一只鱼」。
 * 根因是**记忆各存一份**（那件事归 O-010），但还有第二层：**谁对应谁**。
 * 如果桌宠端绑的是 A 的 QQ、微信端绑的是 B 的微信号，那么即使记忆只有一个真源，
 * 三端看到的仍然是两个人。绑定簿就是把这个映射显式化，并**在冲突时拒绝**。
 *
 * ## 两条冲突规则，都是「拒绝而不是覆盖」
 *
 * 1. **同一平台绑了不同 peer** → 拒绝。静默覆盖的后果是「昨天还是她，今天换了个人」，
 *    而日志里一切正常。
 * 2. **同一 peer 绑到第二个平台** → 拒绝。这几乎总是配置抄错（把桌宠端的会话 id
 *    贴进了微信），而放过它的后果是两个端抢同一段对话。
 *
 * 想换人只有一个动作：先 `unbind(platform)`。多一步，但**换人这件事必须是显式的**。
 */

import type { Config } from './settings.js'
import type { Binding, BindingResult, MobilePlatform } from './types.js'

/** peer 标识的长度上界。 */
export const PEER_MAX = 64

/**
 * peer 标识的合法形状：**非空白、无控制字符、1–64 字符**。
 *
 * 刻意不限制成纯 ASCII：桌宠端的会话 id 可能是 UUID 之外的形态，
 * 而「看起来像什么」不该阻止用户绑定。危险的是空白与控制字符——
 * 它们会让日志分行、让 `peerId` 比较出现看不见的差异。
 */
const PEER_RE = /^[^\s\u0000-\u001f\u007f]{1,64}$/u

/**
 * 校验 peer 标识。
 * @param raw 原始值。
 */
export function checkPeerId(raw: string): 'ok' | 'empty' | 'too-long' | 'bad-shape' {
  const text = raw.trim()
  if (text === '') return 'empty'
  if (text.length > PEER_MAX) return 'too-long'
  if (!PEER_RE.test(text)) return 'bad-shape'
  return 'ok'
}

/** 绑定簿。**只在内存**：绑定关系是「这台机器上此刻谁是谁」，重启即重来。 */
export class BindingBook {
  private readonly list: Binding[] = []

  private readonly settings: Config

  private readonly now: () => number

  /**
   * @param settings 配置（看 `platforms` 与 `enable`）。
   * @param now 取时刻。
   */
  constructor(settings: Config, now: () => number) {
    this.settings = settings
    this.now = now
  }

  /**
   * 绑一个端。
   * @param platform 平台。
   * @param peerId 该平台的用户/会话标识。
   */
  bind(platform: MobilePlatform, peerId: string): BindingResult {
    if (!this.settings.enable) {
      return { ok: false, code: 'disabled', detail: '三端互通是关的。', hint: '打开 `enable`。' }
    }
    if (!this.settings.platforms.includes(platform)) {
      return {
        ok: false,
        code: 'platform-not-enabled',
        detail: `平台 \`${platform}\` 不在启用清单里。`,
        hint: `在 \`platforms\` 里加上它（可选：pet / qq / wechat）。空清单 = 一个端都不接。`,
      }
    }

    const shape = checkPeerId(peerId)
    if (shape !== 'ok') {
      const why =
        shape === 'empty' ? '是空的' : shape === 'too-long' ? `超过 ${PEER_MAX} 字符` : '含空白或控制字符'
      return {
        ok: false,
        code: 'invalid-peer',
        detail: `peer 标识${why}。`,
        hint: '填该平台的用户标识（QQ 号 / 微信 openid / 桌宠端会话 id），别带空格与换行。',
      }
    }

    const text = peerId.trim()
    const existing = this.list.find(item => item.platform === platform)
    if (existing !== undefined) {
      if (existing.peerId === text) {
        // 幂等：同一个端绑同一个人，不报错、也不刷新时刻（否则「绑了多久」会被反复重置）。
        return { ok: true, code: 'ok', detail: '本来就是这个端。', binding: existing }
      }
      return {
        ok: false,
        code: 'conflict',
        detail: `\`${platform}\` 已经绑了另一个 peer。`,
        hint: '先 `unbind` 再绑。静默覆盖的后果是「昨天还是她，今天换了个人」，而日志里一切正常。',
      }
    }

    const other = this.list.find(item => item.peerId === text)
    if (other !== undefined) {
      return {
        ok: false,
        code: 'conflict',
        detail: `这个 peer 已经绑在 \`${other.platform}\` 上了。`,
        hint: '同一个账号不该出现在两个端——这几乎总是把一端的 id 贴进了另一端。确认后再解绑原端。',
      }
    }

    const binding: Binding = Object.freeze({ platform, peerId: text, boundAt: this.now() })
    this.list.push(binding)
    return { ok: true, code: 'ok', detail: `\`${platform}\` 已绑上。`, binding }
  }

  /**
   * 解绑。
   * @param platform 平台。
   */
  unbind(platform: MobilePlatform): BindingResult {
    const index = this.list.findIndex(item => item.platform === platform)
    if (index < 0) {
      return { ok: false, code: 'not-bound', detail: `\`${platform}\` 没有绑定。` }
    }
    // 先取出再删除：`const [removed] = splice(...)` 在无 noUncheckedIndexedAccess 时
    // 会被推导成非空类型，随后的 `removed === undefined` 判空会让 TS 报「比较无重叠」（纪律 25/27）。
    const removed = this.list[index]
    this.list.splice(index, 1)
    if (removed === undefined) {
      return { ok: false, code: 'not-bound', detail: `\`${platform}\` 没有绑定。` }
    }
    return { ok: true, code: 'ok', detail: `\`${platform}\` 已解绑。`, binding: removed }
  }

  /** 全部绑定（副本）。 */
  all(): readonly Binding[] {
    return Object.freeze([...this.list])
  }

  /**
   * 查某个端。
   * @param platform 平台。
   */
  of(platform: MobilePlatform): Binding | undefined {
    return this.list.find(item => item.platform === platform)
  }

  /** 已绑定的 peer（去重、保序）。 */
  peers(): readonly string[] {
    const out: string[] = []
    for (const item of this.list) {
      if (!out.includes(item.peerId)) out.push(item.peerId)
    }
    return Object.freeze(out)
  }

  /** 条数。 */
  count(): number {
    return this.list.length
  }

  /** 清空（卸载用）。 */
  clear(): void {
    this.list.length = 0
  }
}
