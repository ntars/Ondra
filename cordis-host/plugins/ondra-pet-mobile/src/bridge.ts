/**
 * 中继端口、缺失实现与**中继地址判据**。
 *
 * ## 为什么这里**不抄** O-074 的回环白名单
 *
 * 桌宠桥是两个同机进程之间的通道，只该连回环。但**手机端不在这台机器上**：
 * 它要走局域网才能连到宿主。若本包照抄「只允许 127.0.0.1」，手机端永远连不上，
 * 而症状是「配了、也连了、就是没反应」——比不配更难查。
 *
 * 同一条安全直觉在两个场景里给出不同答案，区别只在**事实**（谁和谁通信），
 * 不在直觉。所以这里换一条判据：
 *
 * - 回环 → `ws` / `wss` 都行（数据没出这台机器）；
 * - 非回环 → **必须 `wss`**。明文 WS 跨设备等于把记忆摊在同一张 wifi 上，
 *   而咖啡馆、共享办公、宿舍都是这种 wifi。
 *
 * ## 为什么不定义帧
 *
 * O-058 的教训：手册只给协议轮廓、仓内 0 命中、禁装依赖，就**不写假握手**。
 * 三端中继的帧格式本包一个字节都拿不到依据，所以端口只有 `connect` / `disconnect`——
 * 连帧的形状都不定，免得后来的人以为「这里已经有协议了」。
 */

import type { BridgeResult, PetMobileBridge, RelayOptions } from './types.js'
import { PORT_CEIL, PORT_FLOOR } from './types.js'

/**
 * 回环主机名（**与 O-074 的 `LOOPBACK_HOSTS` 逐字一致**）。
 *
 * 刻意不 import：§18.5 禁止同轮包之间互相 import。代价是上游改一处要手工同步两处，
 * 这条已写进 README「已知限制」。
 */
export const LOOPBACK_HOSTS: readonly string[] = Object.freeze(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** 地址判据结论。 */
export interface RelayCheck {
  /** 过没过。 */
  readonly ok: boolean
  /** 结论码。 */
  readonly code: 'ok' | 'empty' | 'malformed' | 'not-ws' | 'plaintext-remote' | 'bad-port'
  /** 说明。 */
  readonly detail: string
  /** 指路。 */
  readonly hint?: string
}

/**
 * 取地址里的端口（解析失败或没写端口时返回 `null`）。
 * @param raw 地址。
 */
export function relayPortOf(raw: string): number | null {
  const text = raw.trim()
  if (text === '') return null
  try {
    const url = new URL(text)
    if (url.port === '') return null
    const port = Number(url.port)
    if (!Number.isInteger(port) || port < PORT_FLOOR || port > PORT_CEIL) return null
    return port
  } catch {
    return null
  }
}

/**
 * 判中继地址（见文件头的两条判据）。
 * @param raw 配置里的地址。
 */
export function checkRelayUrl(raw: string): RelayCheck {
  const text = raw.trim()
  if (text === '') {
    return {
      ok: false,
      code: 'empty',
      detail: '中继地址是空的。',
      hint: '填 WS 中继地址，形如 `ws://127.0.0.1:3001/…`（手机端要走局域网时用 `wss://`）。',
    }
  }

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, code: 'malformed', detail: '地址不是合法 URL。', hint: '形如 `ws://127.0.0.1:3001/relay`。' }
  }

  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return {
      ok: false,
      code: 'not-ws',
      detail: `协议是 \`${url.protocol}\`，中继只走 WebSocket。`,
      hint: '`http://` 换 `ws://`，`https://` 换 `wss://`。',
    }
  }

  if (relayPortOf(text) === null) {
    return {
      ok: false,
      code: 'bad-port',
      detail: '地址没有显式写合法端口（1–65535）。',
      hint: '补上端口，例 `:3001`。不写会落到 80/443，那里通常站着别的东西。',
    }
  }

  if (url.protocol === 'ws:' && !LOOPBACK_HOSTS.includes(url.hostname)) {
    return {
      ok: false,
      code: 'plaintext-remote',
      detail: `\`${url.hostname}\` 不是本机，却用明文 \`ws://\`。`,
      hint: '跨设备必须 `wss://`。明文 WS 会把对话摊在同一张 wifi 上，而咖啡馆与共享办公都是这种 wifi。',
    }
  }

  return { ok: true, code: 'ok', detail: '中继地址合规。' }
}

/**
 * 缺失实现：中继没接上时的占位。
 *
 * `connect` 如实回 `no-bridge`；`disconnect` 回成功（没有连接时，「断开」已经是真的）。
 */
export class MissingRelay implements PetMobileBridge {
  /** 桥名。 */
  readonly id = 'none'

  /**
   * 连接（恒失败）。
   * @param options 参数（未使用，保留签名）。
   */
  async connect(options: RelayOptions): Promise<BridgeResult<null>> {
    void options
    return {
      ok: false,
      reason: 'no-bridge',
      detail: '没有 WS 中继实现：本仓不含三端中继，禁装依赖，也没有帧格式依据（与 O-058 同一处理）。',
    }
  }

  /** 断开（无事可做即成功）。 */
  async disconnect(): Promise<BridgeResult<null>> {
    return { ok: true, data: null }
  }
}
