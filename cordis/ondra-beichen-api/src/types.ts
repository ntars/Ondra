/**
 * `ondra-beichen-api` 的对外契约。
 *
 * 定位：**北辰注册入口的唯一签发方**。把「去注册」这件事收成一次本地铸币，
 * 目标链接与邀请码都不出现在任何界面文本里，也不作为配置项暴露。
 *
 * ## 为什么是「本地铸币 + 服务端验签」而不是「直接拼 URL」
 *
 * 直接拼 `https://beichenapi.com/register?aff=...` 有三个问题：
 *
 * 1. 地址会出现在地址栏、历史记录、剪贴板与截图里，邀请码等于随手可抄；
 * 2. 任何人改一下 `aff` 参数就能把归因换成自己，而签发方无从察觉；
 * 3. 链接一旦发出就永久有效，无法回收。
 *
 * 换成 token 之后，界面从头到尾只有一个本地地址；真正带邀请码的 302
 * 发生在服务端一跳之内，用户既看不见也改不了。
 *
 * ## 与 `docs/website.md` 的关系（必读）
 *
 * 该文档描述了 EdgeOne 边缘函数版的同一套格式，但**仓库里从未存在过
 * `edge-functions/` 或 `server/index.mjs`**（2026-11-03 核实：两者均不存在）。
 * 因此本文件是当前**唯一**的 v1 实现，格式以 `docs/website.md` 的文字描述为准：
 *
 * ```
 * master    = sha256(MASTER_SECRET)
 * 分钟密钥   = HMAC(master, "beichen-entry-v1|<分钟序号>")
 * token     = v1.<分钟序号>.<过期毫秒>.<12 字节 nonce>.<签名前 22 字符>
 * ```
 *
 * 未来的边缘函数必须逐字复刻这三行，并跑通 `README.md` 里的自检向量，
 * 才谈得上「两边签发的 token 互验」。
 */

/** 本插件注册的服务键（连字符，非 `ondra:beichen`）。全仓唯一归属。 */
export const BEICHEN_SERVICE_KEY = 'ondra-beichen-api'

/** 签名格式版本。改签法必须换版本号，否则新旧 token 会被误判为合法。 */
export const TOKEN_VERSION = 'v1'

/** 分钟密钥的派生用途串。带用途串是为了让同一主密钥在不同功能间不可复用。 */
export const KEY_PURPOSE = 'beichen-entry-v1'

/** 币种长度上限：`v1.` + 分钟 + 过期 + nonce + 签名，留足余量但拒绝超长输入。 */
export const MAX_TOKEN_LENGTH = 128

/**
 * 邀请码。
 *
 * **刻意硬编码，不做配置项**：主人要求「不能改链接」。做成配置项等于把它
 * 变成可编辑字段，也就等于允许改归因。代价必须说清楚——仓库是公开的，
 * 拿到源码的人依然能读出这串字符；所以它防的是「误触与随手转发」，
 * 不是「有心人抓包」。真正的防护在服务端：邀请码只在 302 那一跳拼出来。
 */
export const AFFILIATE_CODE = 'S2D8YVDP9RFR'

/** 北辰站点根地址（不含尾部斜杠）。 */
export const DEFAULT_SITE_BASE_URL = 'https://beichenapi.com'

/** 注册页路径。 */
export const DEFAULT_REGISTER_PATH = '/register'

/** 令牌默认有效期（分钟）。与边缘版默认值一致。 */
export const DEFAULT_TTL_MINUTES = 30

/**
 * 验签失败的原因。
 *
 * 每一条都对应一种真实会发生的输入，且**刻意不合并**：把「过期」和
 * 「签名不符」都报成 410 会让排查变成猜谜，而这两者的处置完全不同
 * （前者让用户重新点一次，后者说明有人在改参数）。
 */
export type VerifyFailure =
  /** 令牌为空。 */
  | 'empty'
  /** 超过长度上限，或段数不对。 */
  | 'malformed'
  /** 版本号不是 `v1`。 */
  | 'bad-version'
  /** 分钟序号不是正整数。 */
  | 'bad-minute'
  /** 过期毫秒不是正整数。 */
  | 'bad-expiry'
  /** nonce 段不是 16 个 base64url 字符（12 字节）。 */
  | 'bad-nonce'
  /** 签名段长度不是 22。 */
  | 'bad-signature'
  /** 已过期。 */
  | 'expired'
  /** 分钟序号偏离当前时间过多（防「超长有效期令牌」与跨版本重放）。 */
  | 'stale-minute'
  /** 重算签名与令牌不符。 */
  | 'mismatch'

/** 验签结果。成功时带出重算后的字段，调用方不必再解析一遍。 */
export type VerifyResult =
  | { readonly ok: true; readonly minute: number; readonly expiresAt: number }
  | { readonly ok: false; readonly reason: VerifyFailure }

/** 一枚已签发的令牌及其可读元数据。 */
export interface IssuedToken {
  /** 完整令牌串，形如 `v1.29xxxxxxx.17xxxxxxxxxx.xxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxxxxxxxx`。 */
  readonly token: string
  /** 签发时的分钟序号。 */
  readonly minute: number
  /** 过期时刻（毫秒）。 */
  readonly expiresAt: number
}

/** 入口页地址与令牌。界面只拿这个，拿不到最终的注册链接。 */
export interface EntryHandle {
  /** 本地入口页地址，形如 `http://127.0.0.1:<端口>/beichen/entry`。 */
  readonly entryUrl: string
  /** 本次铸出的令牌。 */
  readonly token: string
  /** 过期时刻（毫秒）。 */
  readonly expiresAt: number
}

/**
 * 本插件提供的服务。
 *
 * 注意**没有** `registerUrl()` 这类方法：任何能直接拿到带邀请码链接的接口
 * 都等于把「不显示链接」这条要求作废。跳转只发生在 HTTP 路由里。
 */
export interface BeichenService {
  /** 是否已就绪（路由已注册、密钥已加载）。 */
  readonly ready: boolean
  /** 服务端持有的主公钥摘要（sha256 十六进制前 16 位），供界面核对两处是否同一密钥。 */
  readonly fingerprint: string
  /** 铸一枚令牌。 */
  issue(): IssuedToken
  /** 验一枚令牌。 */
  verify(token: string, now?: number): VerifyResult
  /** 生成一份入口句柄（含本地入口页地址）。 */
  entry(): EntryHandle
  /** 读取主密钥原文，供用户在 EdgeOne 环境变量里填同一个值。 */
  secret(): string
}

/** 本插件自己产生的错误。 */
export class BeichenError extends Error {
  /**
   * @param message 人话描述。
   * @param code 机器可读原因。
   */
  constructor(message: string, readonly code: 'no-secret' | 'io' | 'route') {
    super(message)
    this.name = 'BeichenError'
  }
}
