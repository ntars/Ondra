/**
 * 聚合渠道注册表的读取与校验。
 *
 * ## 数据来源与改动
 *
 * `registry.json` 取自 `Ebony-Vinyl/dsh-our-free-model`（MIT）的
 * `src/providers/registry.json`，76 家提供商、502 个模型。逐条保留技术字段
 * （endpoint、协议、认证方式、模型清单），**去掉 `website`**——它是各家官网，
 * 属于推广位，与「这个接口怎么调」无关。
 *
 * ## 为什么读完还要校验一遍
 *
 * 注册表是随包分发的**数据**，不是类型系统能约束的东西。上游改一个字段名、
 * 少一个 `baseUrl`，编译期发现不了，运行期会变成「选了个模型，请求发到
 * `undefined/v1`」。所以宁可在这里逐条判一遍，坏一条丢一条并记账，
 * 也不让脏数据流进 pi-ai 的配置。
 *
 * 丢弃而不是整体失败：一家渠道写坏了，不该让另外 75 家一起消失。
 * 这与 O-005「错层单独丢弃」同口径。
 */

import registryData from './registry.json' with { type: 'json' }
import type { AuthKind, Channel, ChannelCategory, ChannelModel, RegistryProtocol, WireProtocol } from './types.js'

/** 命名硬约束（手册 §8.4）：渠道键要能直接当 provider 路由名，也必须合规。 */
const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 注册表原始条目（上游形状，只声明本插件读到的字段）。 */
interface RawModel {
  readonly id?: unknown
  readonly name?: unknown
  readonly contextWindow?: unknown
}

interface RawEntry {
  readonly id?: unknown
  readonly name?: unknown
  readonly category?: unknown
  readonly baseUrl?: unknown
  readonly format?: unknown
  readonly authKind?: unknown
  readonly authEnv?: unknown
  readonly local?: unknown
  readonly models?: unknown
}

/** 上游协议名 → pi-ai 的 `api` 取值。 */
const PROTOCOL_MAP: Readonly<Record<RegistryProtocol, WireProtocol>> = Object.freeze({
  'openai-chat': 'openai-completions',
  'openai-responses': 'openai-responses',
  'anthropic-messages': 'anthropic-messages',
})

/** 合法类别。 */
const CATEGORIES: readonly ChannelCategory[] = ['apikey', 'free-tier', 'local', 'oauth']
/** 合法认证方式。 */
const AUTH_KINDS: readonly AuthKind[] = ['apiKey', 'oauth', 'adc', 'none']

/** 取字符串，非字符串返回 undefined。 */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 去掉尾部斜杠。 */
function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

/** 补全一个模型；缺 id 的整条丢弃。 */
function modelOf(raw: unknown): ChannelModel | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const entry = raw as RawModel
  const id = text(entry.id)
  if (id === undefined) return undefined
  const name = text(entry.name) ?? id
  const contextWindow = typeof entry.contextWindow === 'number' && Number.isFinite(entry.contextWindow) && entry.contextWindow > 0
    ? Math.trunc(entry.contextWindow)
    : null
  return Object.freeze({ id, name, contextWindow })
}

/** 补全一家渠道；任何一项不合法返回 `undefined` 与一条理由。 */
function channelOf(raw: unknown, index: number): { channel?: Channel; issue?: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { issue: `第 ${index + 1} 条不是对象，已跳过` }
  }
  const entry = raw as RawEntry
  const id = text(entry.id)
  if (id === undefined || !NAME_RE.test(id)) {
    return { issue: `第 ${index + 1} 条的 id 不合规（需匹配 ${NAME_RE.source}），已跳过` }
  }
  const baseUrl = text(entry.baseUrl)
  if (baseUrl === undefined || !/^https?:\/\//.test(baseUrl)) {
    return { issue: `渠道 ${id} 缺少合法 baseUrl，已跳过` }
  }
  const format = text(entry.format) as RegistryProtocol | undefined
  const api = format !== undefined ? PROTOCOL_MAP[format] : undefined
  if (api === undefined) {
    return { issue: `渠道 ${id} 的协议 ${String(format)} 不认识，已跳过` }
  }
  const categoryRaw = text(entry.category) as ChannelCategory | undefined
  const category: ChannelCategory = categoryRaw !== undefined && CATEGORIES.includes(categoryRaw) ? categoryRaw : 'apikey'
  const authRaw = text(entry.authKind) as AuthKind | undefined
  const authKind: AuthKind = authRaw !== undefined && AUTH_KINDS.includes(authRaw) ? authRaw : 'apiKey'
  const authEnv = text(entry.authEnv) ?? null
  const modelsRaw = Array.isArray(entry.models) ? entry.models : []
  const models: ChannelModel[] = []
  for (const rawModel of modelsRaw) {
    const model = modelOf(rawModel)
    if (model !== undefined) models.push(model)
  }
  return {
    channel: Object.freeze({
      id,
      name: text(entry.name) ?? id,
      category,
      baseUrl: trimSlash(baseUrl),
      api,
      authKind,
      authEnv,
      local: entry.local === true,
      models: Object.freeze(models),
    }),
  }
}

/**
 * 读取并校验整张注册表。
 * @returns 可用渠道与丢弃理由。**结果按 id 去重**，重复时保留第一条。
 */
export function loadChannels(): { channels: readonly Channel[]; issues: readonly string[] } {
  const issues: string[] = []
  const channels: Channel[] = []
  const seen = new Set<string>()
  const raw = Array.isArray(registryData) ? registryData : []
  for (let index = 0; index < raw.length; index += 1) {
    const result = channelOf(raw[index], index)
    if (result.channel === undefined) {
      if (result.issue !== undefined) issues.push(result.issue)
      continue
    }
    if (seen.has(result.channel.id)) {
      issues.push(`渠道 ${result.channel.id} 重复出现，保留第一条`)
      continue
    }
    seen.add(result.channel.id)
    channels.push(result.channel)
  }
  return { channels: Object.freeze(channels), issues: Object.freeze(issues) }
}
