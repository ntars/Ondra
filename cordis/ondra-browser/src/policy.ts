/**
 * 护栏判定：**这里只有纯函数**，不碰 ctx、不记日志、不计数。
 *
 * 三件事各一个函数：
 *
 * 1. `isBrowserTool()` —— 这个名字算不算浏览器的活儿；
 * 2. `checkUrl()` —— 这个地址能不能去；
 * 3. `scanArgs()` —— 这次调用的参数里有没有一个过不去的地址。
 *
 * ## 为什么判定要能单独调
 *
 * 面板要显示「这个网址会不会被拦」、测试要能逐条对拍、上游要能预检——
 * 三条需求都指向同一件事：**判定必须是一个可以直接传参调用的纯函数**。
 * 写死在事件处理器里，就只能靠「真的点一次」来验证，那不是验证。
 *
 * ## 一个刻意的取舍：`not-url` 不算「拦」
 *
 * `browser_type` 的 `text` 参数是「你好」，它长得不像 URL。
 * 如果把它判成 `not-url` 然后拒绝，打字功能就废了。
 * 所以 `scanArgs()` **只检查长得像 URL 的字符串**；`checkUrl()` 单独调用时
 * 才把「不是 URL」当成拒绝（那时调用方的意图明确是「去某个地址」）。
 */

import type { UrlCode, UrlVerdict, ToolCode, ToolVerdict } from './types.js'
import { PRIVATE_HOSTS, PRIVATE_SUFFIXES } from './types.js'
import type { Config } from './settings.js'

/** 解析出的目标。 */
interface Target {
  /** 协议（小写，不含冒号）。 */
  readonly scheme: string
  /** 主机名（小写；IPv6 保留方括号）。 */
  readonly host: string
}

/**
 * 从字符串里认出 URL 目标。
 * @param text 原文。
 * @returns 认不出为 `null`（不是「非法」，是「不是 URL」）。
 */
export function parseTarget(text: string): Target | null {
  const value = text.trim()
  if (value === '') return null
  // 先按「有没有协议头」粗筛：这一步挡住绝大多数普通文本，也避免 new URL 抛异常。
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return null
  try {
    const url = new URL(value)
    return { scheme: url.protocol.replace(/:$/, '').toLowerCase(), host: url.hostname.toLowerCase() }
  } catch {
    // 有协议头但解析不了（如 `http://` 后为空）：仍算「像 URL」，交给 checkUrl 判。
    const scheme = value.slice(0, value.indexOf(':')).toLowerCase()
    return { scheme, host: '' }
  }
}

/**
 * 判一个主机是不是私有/本地。
 * @param host 主机名（小写）。
 */
export function isPrivateHost(host: string): boolean {
  if (host === '') return true
  if (PRIVATE_HOSTS.includes(host)) return true
  for (const suffix of PRIVATE_SUFFIXES) {
    if (host.endsWith(suffix)) return true
  }
  // 方括号 = IPv6 字面量。`[::1]` / `[fe80::]` / `[fd00::]` / `[::ffff:127.0.0.1]`
  // 全是本机或内网；公网 IPv6 字面量极少作为浏览目标，一律按私有处理更安全。
  if (host.startsWith('[')) return true

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4 === null) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true
  return false
}

/**
 * 判主机是否在拒绝名单里。
 *
 * 名单项按「整名或后缀」两种理解：填 `example.com` 会同时拒 `a.example.com`，
 * 填 `.example.com` 只拒子域。这样一条规则覆盖两种常见的写法。
 * @param host 主机名（小写）。
 * @param list 拒绝名单。
 */
export function isDeniedHost(host: string, list: readonly string[]): boolean {
  for (const entry of list) {
    const item = entry.trim().toLowerCase()
    if (item === '') continue
    if (host === item) return true
    if (item.startsWith('.') && host.endsWith(item)) return true
    if (!item.startsWith('.') && host.endsWith(`.${item}`)) return true
  }
  return false
}

/** 造一个拒绝结论。 */
function deny(code: UrlCode, reason: string): UrlVerdict {
  return Object.freeze({ kind: 'deny' as const, code, reason })
}

/**
 * 判一个 URL 能不能去。
 * @param url 待判 URL。
 * @param settings 配置（协议表 / 私有主机开关 / 拒绝名单）。
 */
export function checkUrl(url: string, settings: Config): UrlVerdict {
  const target = parseTarget(url)
  if (target === null) {
    return deny('not-url', '这不是一个网址（没有 http:// 或 https:// 开头）。要打开网页请给出完整地址。')
  }
  if (!settings.allowedSchemes.includes(target.scheme)) {
    return deny(
      'bad-scheme',
      `不允许 ${target.scheme}: 这类地址。只允许 ${settings.allowedSchemes.join(' / ') || '（当前为空，什么都不许）'}。`,
    )
  }
  if (target.host === '') {
    return deny('no-host', '这个地址没有主机名。')
  }
  if (isDeniedHost(target.host, settings.hostDenyList)) {
    return deny('denied-host', `${target.host} 在拒绝名单里。`)
  }
  if (!settings.allowPrivateHosts && isPrivateHost(target.host)) {
    return deny(
      'private-host',
      `${target.host} 是本机或内网地址。要看它请让用户自己打开，或显式打开 allow-private-hosts。`,
    )
  }
  return Object.freeze({ kind: 'allow' as const })
}

/**
 * 递归找参数里「长得像 URL」的字符串并逐个判。
 *
 * 深度限 3、只看字符串、只看对象/数组：够覆盖工具参数的实际形状，
 * 又不会被一个巨大参数树拖住（参数本来也只由模型生成）。
 * @param args 参数。
 * @param settings 配置。
 * @param depth 当前深度（内部用）。
 */
export function scanArgs(args: unknown, settings: Config, depth = 0): UrlVerdict {
  if (depth > 3) return Object.freeze({ kind: 'allow' as const })
  if (typeof args === 'string') {
    if (parseTarget(args) === null) return Object.freeze({ kind: 'allow' as const })
    return checkUrl(args, settings)
  }
  if (Array.isArray(args)) {
    for (const item of args) {
      const verdict = scanArgs(item, settings, depth + 1)
      if (verdict.kind === 'deny') return verdict
    }
    return Object.freeze({ kind: 'allow' as const })
  }
  if (typeof args === 'object' && args !== null) {
    for (const value of Object.values(args as Record<string, unknown>)) {
      const verdict = scanArgs(value, settings, depth + 1)
      if (verdict.kind === 'deny') return verdict
    }
  }
  return Object.freeze({ kind: 'allow' as const })
}

/**
 * 这个名字算不算浏览器的活儿。
 * @param name 工具名。
 * @param prefixes 前缀表。
 */
export function isBrowserTool(name: string, prefixes: readonly string[]): boolean {
  const value = name.toLowerCase()
  for (const prefix of prefixes) {
    if (value.startsWith(prefix.toLowerCase())) return true
  }
  return false
}

/**
 * 这个名字是不是红线工具（在页面里执行任意代码）。
 *
 * 比对前把 `-` 与 `_` 归一，这样名单里只写一种写法也够；
 * 但**不**把点号归一——`browser.evaluate` 这种命名本包按前缀就认不出来，
 * 硬猜会误伤（见 README「已知限制」3）。
 * @param name 工具名。
 * @param redline 名单。
 */
export function isScriptTool(name: string, redline: readonly string[]): boolean {
  const norm = (text: string): string => text.toLowerCase().replace(/-/g, '_')
  const value = norm(name)
  for (const item of redline) {
    if (norm(item) === value) return true
  }
  return false
}

/** 造一个放行结论。 */
function allow(): ToolVerdict {
  return Object.freeze({ kind: 'allow' as const })
}

/** 造一个跳过结论。 */
function skip(): ToolVerdict {
  return Object.freeze({ kind: 'skip' as const })
}

/**
 * 判一次工具调用。
 * @param name 工具名。
 * @param args 参数。
 * @param settings 配置。
 */
export function judgeTool(name: string, args: unknown, settings: Config): ToolVerdict {
  if (!isBrowserTool(name, settings.toolPrefixes)) return skip()

  if (!settings.allowScriptExecution && isScriptTool(name, settings.scriptTools)) {
    const veto: ToolVerdict = Object.freeze({
      kind: 'deny' as const,
      code: 'script-tool' as ToolCode,
      reason: `${name} 会在页面里执行任意代码（能读到用户已登录站点的数据）。要用请在配置里打开 allow-script-execution。`,
    })
    return veto
  }

  const target = scanArgs(args, settings)
  if (target.kind === 'deny') {
    const veto: ToolVerdict = Object.freeze({
      kind: 'deny' as const,
      code: 'bad-target' as ToolCode,
      reason: `这次调用的目标地址被拒：${target.reason}`,
    })
    return veto
  }

  return allow()
}
