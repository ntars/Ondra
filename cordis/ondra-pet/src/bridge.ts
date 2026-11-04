/**
 * 桥接端口、缺失实现与**桥接安全**（手册 §9.2）。
 *
 * ## §9.2 只有一句话
 *
 * ```
 * 任何本地 WS 桥接必须校验 Origin + 一次性 token
 * （CSWSH 教训：coopanion-connector-dsh <0.2.9 有漏洞）。
 * ```
 *
 * 这句话容易被读成「给桥提个醒」。但 CSWSH 的形态是：本地起了一个 WS 服务，
 * 用户随便打开一个网页，那个网页里的 JS 就能连上 `ws://127.0.0.1:xxxx`——
 * 浏览器**不管**跨域，页面能连上就能发消息。桌宠桥一旦被连上，
 * 对方拿到的是「她」在这台机器上的说话通道。所以校验必须发生在**连接建立的那一刻**，
 * 而且**默认必须是拒绝**（来源清单为空 = 谁也不许连）。
 *
 * 本包能做的是在**叫出之前**把三件事判掉：
 *
 * 1. 地址必须是回环（`127.0.0.1` / `localhost` / `::1`）——允许 `0.0.0.0` 或局域网 IP
 *    等于把桌宠桥挂到路由器的另一侧；
 * 2. URL 里不许夹 token（`?token=`）——URL 会进日志、进崩溃报告、进浏览器历史。
 *    确实只能这么传的实现，由 `allowTokenInUrl` 显式打开（默认关）；
 * 3. 一次性 token 必须有形状（长度、无空白），且**只在 `summon()` 参数里过一手**，
 *    不进配置（master-plan §6 禁令 6：密钥绝不写进配置文件）。
 *
 * 真正「校验 Origin」发生在桥的服务端——本包只能**把清单交过去**，
 * 并且拒绝「清单为空却想启动」的配置（否则等于不校验）。
 */

import type {
  BridgeCheck,
  BridgeResult,
  OriginCheck,
  PetBridge,
  PetSpawnOptions,
  RenderMode,
  TokenVerdict,
} from './types.js'

/**
 * 回环主机名白名单。
 *
 * `[::1]` 与 `::1` 都列：`new URL('ws://[::1]:3001').hostname` 返回**带方括号**的形式，
 * 而手写配置常常不带。只认白名单，不做「看起来像本机」的推断——
 * `127.0.0.2` 也是回环，但它同样可能是别人机器的路由目标，不在手册授权范围内。
 */
export const LOOPBACK_HOSTS: readonly string[] = Object.freeze(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** 一次性 token 的最小长度。 */
export const TOKEN_MIN = 16

/** 一次性 token 长度上界（再长也没意义，只会被截断复制）。 */
export const TOKEN_MAX = 512

/** URL 里可能夹 token 的参数名（小写比较）。 */
export const TOKEN_PARAMS: readonly string[] = Object.freeze(['token', 'access_token', 'key', 'secret'])

/**
 * 校验桥地址。
 * @param raw 配置里的地址。
 * @param options `allowTokenInUrl` 由配置给出。
 */
export function checkBridgeUrl(raw: string, options: { readonly allowTokenInUrl: boolean }): BridgeCheck {
  const text = raw.trim()
  if (text === '') {
    return {
      ok: false,
      code: 'empty',
      detail: '桥地址是空的。',
      hint: '填桌宠桥的本地地址，形如 `ws://127.0.0.1:端口/路径`。地址由你装的那只桌宠提供。',
    }
  }

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, code: 'malformed', detail: '地址不是合法 URL。', hint: '形如 `ws://127.0.0.1:19387/pet`。' }
  }

  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return {
      ok: false,
      code: 'not-ws',
      detail: `协议是 \`${url.protocol}\`，本包只接 WebSocket。`,
      hint: '把 `http://` 换成 `ws://`，`https://` 换成 `wss://`。',
    }
  }

  if (url.username !== '' || url.password !== '') {
    return {
      ok: false,
      code: 'userinfo',
      detail: '地址里带了用户名或密码。',
      hint: '凭据走 `token` 参数，不要写进 URL——URL 会进日志与崩溃报告。',
    }
  }

  if (!LOOPBACK_HOSTS.includes(url.hostname)) {
    return {
      ok: false,
      code: 'not-loopback',
      detail: `主机是 \`${url.hostname}\`，不是本机回环地址。`,
      hint: `只允许 ${LOOPBACK_HOSTS.join(' / ')}。桌宠桥挂到局域网或 0.0.0.0，等于把它挂到路由器另一侧。`,
    }
  }

  if (url.port === '') {
    return {
      ok: false,
      code: 'bad-port',
      detail: '地址里没有写端口。',
      hint: '必须显式写端口（例 `:19387`）：不写会落到 80/443，那里通常站着别的东西。',
    }
  }

  if (!options.allowTokenInUrl) {
    for (const name of TOKEN_PARAMS) {
      if (url.searchParams.get(name) !== null) {
        return {
          ok: false,
          code: 'token-in-url',
          detail: `URL 里带了 \`${name}\` 参数。`,
          hint: 'token 只从 `summon({ token })` 传入。确实只支持 query 传 token 的桥，请在配置里打开 `allowTokenInUrl`，并接受「它会进日志」。',
        }
      }
    }
  }

  return { ok: true, code: 'ok', detail: '桥地址合规（回环、WS、显式端口、URL 内无凭据）。' }
}

/**
 * 校验来源清单。
 *
 * 空清单**不是**「不限制」，是「全拒」：undefined 与 `*` 都不接受。
 * 这一条与 O-073 的指令白名单同一手法——空表是明确默认，不是忘配。
 *
 * **刻意不收 `file:`**：Electron 的 `file://` 页面发出的 `Origin` 是字符串 `null`，
 * 不是 `file://`。把 `file:` 放进白名单只会得到一条「填了却永远匹配不上」的配置，
 * 而用户会以为已经配好了。`null` 来源要不要放行是**桥**的决定（它才是校验方），
 * 本包不替它假装。写进 README「已知限制」。
 * @param list 配置里的来源清单。
 */
export function checkOrigins(list: readonly string[]): OriginCheck {
  if (list.length === 0) {
    return {
      ok: false,
      code: 'empty',
      detail: '允许来源清单是空的，等于谁也不许连。',
      hint: '填桌宠窗口自己的来源，形如 `http://localhost:5173`。不填就启动 = 不校验 Origin。',
    }
  }

  for (const raw of list) {
    const text = raw.trim()
    if (text === '') return { ok: false, code: 'bad', detail: '来源清单里有一条是空字符串。', hint: '删掉空条目。' }
    let url: URL
    try {
      url = new URL(text)
    } catch {
      return { ok: false, code: 'bad', detail: `来源 \`${text}\` 不是合法 URL。`, hint: '来源要写完整的 scheme + host（+ 端口）。' }
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return {
        ok: false,
        code: 'bad',
        detail: `来源 \`${text}\` 的协议是 \`${url.protocol}\`。`,
        hint: '只接受 http / https。`file:` 页面发出的 Origin 是字符串 `null`，写 `file://` 永远匹配不上。',
      }
    }
    if (url.search !== '' || url.hash !== '') {
      return { ok: false, code: 'bad', detail: `来源 \`${text}\` 带了查询或片段。`, hint: 'Origin 里不会有这些，写了也匹配不上。' }
    }
    // 路径只能是空或 `/`：Origin 头本身不带路径，带路径的写法说明填的是别的 URL。
    if (url.pathname !== '' && url.pathname !== '/') {
      return { ok: false, code: 'bad', detail: `来源 \`${text}\` 带了路径。`, hint: '只写到 host（和端口），不要写路径。' }
    }
  }

  return { ok: true, code: 'ok', detail: `允许来源 ${list.length} 条。` }
}

/**
 * 校验一次性 token 的形状。
 * @param token 调用方给的 token。
 * @param minLength 最小长度（默认 `TOKEN_MIN`）。
 */
export function checkToken(token: string | undefined, minLength: number = TOKEN_MIN): TokenVerdict {
  if (token === undefined) return 'missing'
  const text = token.trim()
  if (text === '') return 'missing'
  if (text.length < minLength || text.length > TOKEN_MAX) return 'weak'
  if (/\s/.test(text)) return 'weak'
  return 'ok'
}

/**
 * 缺失实现：桥没接上时的占位。
 *
 * `spawn` 如实回 `no-bridge`；`stop` 回成功——「没有任何东西在跑」时，
 * 「停下来」这件事已经是真的了。这两条**不是对称的**，刻意如此：
 * 若 `stop` 也报错，上层会以为「有一只关不掉」，而事实是一只都没起。
 */
export class MissingBridge implements PetBridge {
  /** 桥名。 */
  readonly id = 'none'

  /** 支持的渲染档：声明 `static`，但 `spawn` 恒失败。 */
  readonly renders: readonly RenderMode[] = Object.freeze(['static'] as RenderMode[])

  /**
   * 叫出（恒失败）。
   * @param options 参数（未使用，保留签名）。
   */
  async spawn(options: PetSpawnOptions): Promise<BridgeResult<null>> {
    void options
    return {
      ok: false,
      reason: 'no-bridge',
      detail: '没有桌宠桥：本仓不含任何桌宠实现（查证过，desktop/packages 里 0 命中），也禁装依赖。',
    }
  }

  /** 收起（无事可做即成功）。 */
  async stop(): Promise<BridgeResult<null>> {
    return { ok: true, data: null }
  }
}
