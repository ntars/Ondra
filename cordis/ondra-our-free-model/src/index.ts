/**
 * `ondra-our-free-model`：渠道目录与策略层。
 *
 * ## 它到底是什么（先把边界钉死）
 *
 * 本插件**不发模型请求**。它产出的是「一堆可以直接塞进 pi-ai 的 provider
 * profile」——`{ displayName, api, baseURL, apiKeyEnv, models }`。
 * 应用把这些 profile 写进 `@ntars/ondra-llm-pi-ai` 的 `providers` 配置，
 * 请求就走通了。
 *
 * 为什么这样分：pi-ai 已经把三种线协议（`openai-completions` /
 * `openai-responses` / `anthropic-messages`）、SSE 解码、工具调用配对、
 * 重试策略全做完了。本插件再写一遍就是自我复制（手册 §1.8）。
 * 上游 `dsh-our-free-model` 自己实现了 adapter，是因为它要兼容 76 家
 * 形状各异的网关；本仓已有 pi-ai 兜住这件事，就没有理由再实现一次。
 *
 * ## 默认零出站
 *
 * `freeLanes` 默认 `false`。关闭状态下：
 *
 * - 不探测模型清单；
 * - 不判定出口地区；
 * - 不生成任何车道 profile。
 *
 * 只有用户显式打开，本插件才会有第一个出站请求。这条是硬的：
 * Ondra 第十九章承诺「出站清单可枚举」，一个默认联网的插件会让那句话失真。
 */

import type { Context } from '@ntars/cordis'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
  type Config as OfmConfig,
  type ConfigSchemaLike,
} from './settings.js'
import { FREE_LANES } from './lanes.js'
import { detectRegion, probeModels } from './probe.js'
import { loadChannels } from './registry.js'
import {
  OFM_SERVICE_KEY,
  OurFreeModelError,
  type Channel,
  type FreeLane,
  type OurFreeModelService,
  type ProbeOutcome,
  type ProviderProfile,
  type RegionOutcome,
} from './types.js'

export type * from './types.js'
export { OFM_SERVICE_KEY, OurFreeModelError } from './types.js'
export { FREE_LANES } from './lanes.js'
export { loadChannels } from './registry.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-our-free-model'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** O-001 身份服务的结构对位（只取日志命名空间）。 */
interface IdentityLike {
  loggerName(feature: string): string
}

/** 日志门面的最小形状。 */
interface LogLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

declare module '@ntars/cordis' {
  interface Context {
    /** 免费模型渠道服务；未装载本插件时为 undefined。 */
    'ondra-our-free-model'?: OurFreeModelService
  }
}

/** 把渠道翻成 pi-ai profile。 */
function profileFromChannel(channel: Channel, selected: readonly string[] | undefined): ProviderProfile {
  const keep = selected === undefined ? undefined : new Set(selected)
  const models = channel.models
    .filter(model => keep === undefined || keep.has(model.id))
    .map(model => (model.contextWindow === null
      ? { id: model.id, name: model.name }
      : { id: model.id, name: model.name, contextWindow: model.contextWindow }))
  return {
    displayName: channel.name,
    api: channel.api,
    baseURL: channel.baseUrl,
    // 无认证方式的渠道（Ollama / LM Studio / llama.cpp）不写 apiKeyEnv：
    // 写了会让 pi-ai 在请求前先解析凭据，解析不到直接 MISSING_CREDENTIAL。
    ...channel.authEnv === null ? {} : { apiKeyEnv: channel.authEnv },
    models,
  }
}

/** 把免费车道翻成 pi-ai profile。 */
function profileFromLane(lane: FreeLane): ProviderProfile {
  return {
    displayName: lane.name,
    api: lane.api,
    baseURL: lane.baseUrl,
    // 公开免密车道的认证头不是「用户凭据」，所以不走 apiKeyEnv，
    // 直接写成固定请求头——它本来就不是秘密。
    ...lane.bearer === null ? {} : { headers: { Authorization: `Bearer ${lane.bearer}` } },
    // 模型清单不硬编码：车道会换模型，写死一份快照只会让选择器显示已下线的项。
    models: [],
  }
}

/**
 * 构造服务。
 * @param settings 已补全的配置。
 * @param log 日志。
 * @returns 服务实现。
 */
function createService(settings: OfmConfig, log: LogLike): OurFreeModelService {
  const loaded = loadChannels()
  for (const issue of loaded.issues) log.warn('渠道注册表：%s', issue)
  const byId = new Map(loaded.channels.map(channel => [channel.id, channel]))

  return {
    channels(): readonly Channel[] {
      return loaded.channels
    },
    lanes(): readonly { readonly lane: FreeLane; readonly enabled: boolean }[] {
      return FREE_LANES.map(lane => ({
        lane,
        enabled: settings.freeLanes && settings.laneIds.includes(lane.id),
      }))
    },
    channel(id: string): Channel | undefined {
      return byId.get(id)
    },
    profileOf(id: string, selectedModels?: readonly string[]): ProviderProfile | undefined {
      const channel = byId.get(id)
      if (channel === undefined) return undefined
      return profileFromChannel(channel, selectedModels)
    },
    laneProfiles(): Readonly<Record<string, ProviderProfile>> {
      if (!settings.freeLanes) return Object.freeze({})
      const out: Record<string, ProviderProfile> = {}
      for (const lane of FREE_LANES) {
        if (settings.laneIds.includes(lane.id)) out[lane.id] = profileFromLane(lane)
      }
      return Object.freeze(out)
    },
    async probe(
      id: string,
      signal?: AbortSignal,
      headers?: Readonly<Record<string, string>>,
    ): Promise<ProbeOutcome> {
      const lane = FREE_LANES.find(entry => entry.id === id)
      if (lane !== undefined) {
        if (!settings.freeLanes) {
          throw new OurFreeModelError('免密车道总开关未打开，不探测也不发请求', 'lanes-off')
        }
        if (!settings.laneIds.includes(id)) {
          throw new OurFreeModelError(`车道 ${id} 未在 laneIds 里启用`, 'disabled')
        }
        const laneHeaders = lane.bearer === null ? undefined : { Authorization: `Bearer ${lane.bearer}` }
        return probeModels(id, lane.baseUrl, lane.modelsPath, laneHeaders, signal)
      }
      const channel = byId.get(id)
      if (channel === undefined) throw new OurFreeModelError(`没有名为 ${id} 的渠道`, 'unknown-channel')
      if (!settings.channels.includes(id)) {
        throw new OurFreeModelError(`渠道 ${id} 未在 channels 白名单里，拒绝探测`, 'disabled')
      }
      // 凭据由调用方持有：本插件不读 credentials 域，也不能替用户保管 Key。
      return probeModels(id, channel.baseUrl, '/models', headers, signal)
    },
    async region(): Promise<RegionOutcome> {
      // 没开免密车道就不该有任何出站流量，包括地区判定。
      if (!settings.freeLanes) return { known: false, country: '', source: 'none' }
      return detectRegion()
    },
  }
}

/**
 * 向 O-005 注册配置段。失败不致命。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 是否注册成功。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-our-free-model: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败，退回插件实例配置：%s', messageOf(error))
    return false
  }
}

/**
 * Cordis 入口：加载注册表、注册服务、按需起定时探测。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: OfmConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('our-free-model') : 'ondra.our-free-model') as unknown as LogLike

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  if (schema !== undefined && registerSection(ctx, schema, log)) {
    try {
      const resolved = schema.resolve(CONFIG_SECTION_ID, { user: normalizeUserLayer(raw) })
      if (resolved !== undefined) {
        effective = valuesToConfigShape(resolved.values)
        if (resolved.fallbackCount > 0) {
          log.warn('配置有 %d 个字段校验失败，已逐个回退默认值', resolved.fallbackCount)
        }
      }
    } catch (error) {
      log.warn('解析配置段失败，退回插件实例配置：%s', messageOf(error))
    }
  }
  const completed = completeConfig(effective)
  for (const issue of completed.issues) log.warn('配置问题（%s）：%s', issue.field, issue.message)
  const settings = completed.config

  if (!settings.enabled) {
    log.info('免费模型插件已关闭（enabled=false）：不加载渠道、不注册服务')
    return
  }

  const service = createService(settings, log)
  ctx.effect(() => ctx.provide(OFM_SERVICE_KEY, service), 'ondra-our-free-model: 注册服务')

  const channels = service.channels()
  const lanes = service.lanes()
  log.info(
    '免费模型就绪：聚合渠道 %d 家（共 %d 个模型），免密车道 %d 条（%s）',
    channels.length,
    channels.reduce((sum, channel) => sum + channel.models.length, 0),
    lanes.filter(entry => entry.enabled).length,
    lanes.map(entry => `${entry.lane.id}${entry.enabled ? '✓' : '×'}`).join(' / '),
  )

  if (!settings.freeLanes) {
    log.info('免密车道总开关关闭（默认值）：不探测模型清单、不判定地区、不产生任何出站请求')
    log.info('开启方式：设置里打开「免密车道」，并确认已读过风险说明。上游会记录 prompt，只适合闲聊')
  }
  if (settings.channels.length === 0) {
    log.info('聚合渠道白名单为空：%d 家渠道可查但都不生成 profile。要用哪家就把渠道键写进 channels', channels.length)
  }

  // 启动探测：默认不做。开了才探，且只探免费车道——聚合渠道要 Key，
  // 而本插件不持有凭据，自动去探只会换回一串 401，把日志刷成噪声。
  if (settings.probeOnStart && !settings.freeLanes) {
    log.warn('probeOnStart 已打开但免密车道总开关关着：没有可探测的车道（聚合渠道需凭据，不自动探测）')
  }
  if (settings.probeOnStart && settings.freeLanes) {
    for (const id of settings.laneIds) {
      void service.probe(id).then(outcome => {
        if (outcome.reachable) {
          log.info('探测 %s：可达，上游公布 %d 个模型', id, outcome.modelCount)
        } else {
          log.warn('探测 %s：不可达（%s），保持上一状态，不从选择器移除', id, outcome.failure ?? 'unknown')
        }
      }).catch((error: unknown) => {
        log.warn('探测 %s 失败：%s', id, messageOf(error))
      })
    }
  }

  // 定时探测：0 表示不探。用 ctx.effect 注册，卸载时自动清掉，不留野定时器。
  // 同样只探车道：这是本插件唯一能在不持有凭据时发起的探测。
  if (settings.probeIntervalMinutes > 0 && settings.freeLanes) {
    const intervalMs = settings.probeIntervalMinutes * 60_000
    ctx.effect(() => {
      const timer = setInterval(() => {
        for (const id of settings.laneIds) {
          void service.probe(id).catch((error: unknown) => {
            log.warn('定时探测 %s 失败：%s', id, messageOf(error))
          })
        }
      }, intervalMs)
      // Node 的定时器不该拖住进程退出。
      timer.unref?.()
      return () => { clearInterval(timer) }
    }, 'ondra-our-free-model: 定时探测')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: OfmConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      const done = completeConfig(value)
      const issues = done.issues.map(issue => ({ message: `${issue.field}: ${issue.message}` }))
      if (issues.length > 0) return { issues }
      return { value: done.config }
    },
  },
}
