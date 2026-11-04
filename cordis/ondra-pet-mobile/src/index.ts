/**
 * O-075 `ondra-pet-mobile`：三端技术前提的**能力入口**。档位〔复〕，本版 `skeleton`。
 *
 * ## 它为什么不是「移动端窗口」
 *
 * 台账写的是「占位，钉住三端技术前提」，不是「做手机客户端」。手册 §1.11-07 对手机端的
 * 原话是「即将适配」——一个还没发布的东西，插件里做出一个窗口只会得到「装了但什么都没有」。
 *
 * 所以本包做的是把手册里散在三处的原始事实钉成**七条可判定前提**：
 *
 * | 前提 | 出处 |
 * |---|---|
 * | 三端共用同一份记忆 | §6.2 / 语料庚-7「并不是同一只鱼」 |
 * | 桌宠端入口在位 | §6.3 |
 * | 本机 HTTP 出口 | 语料庚-5/庚-7「HTTP API 3000」+ 上游 `ctx.webServer` |
 * | WS 中继已接入 | 语料庚-5/庚-7「WS 3001」+ §9.2 |
 * | 允许来源已配置 | §9.2（CSWSH） |
 * | 两侧 token 一致 | 语料庚-7 三坑之三 |
 * | 手机客户端已发布 | §1.11-07「即将适配」 |
 *
 * 前五条是 **required**（缺一条 `ready=false`），后两条一条**结构上判不了**、
 * 一条**还没发布**——它们不阻塞 `ready`，但必须在面板上显示出来。
 * 把它们压成 `false` 会让人去修一个没坏的东西；压成 `true` 会让人以为配好了。
 *
 * ## 为什么不注册工具、不做移动端窗口、不定义帧
 *
 * 三端互通是**基础设施**，不是模型动作：让模型「连一下中继」没有任何意义。
 * 帧格式一个字节的依据都没有（手册只给端口，不给协议），所以端口只有
 * `connect` / `disconnect`——连帧的形状都不定（与 O-058 的处理一致）。
 */

import type { Context } from '@ntars/cordis'
import { PetMobileHub } from './service.js'
import { checkRelayUrl, relayPortOf } from './bridge.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as Settings } from './settings.js'
import { PET_MOBILE_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  PetLike,
  PetMobileService,
  WebServerLike,
} from './types.js'

export type * from './types.js'
export {
  PET_MOBILE_SERVICE_KEY,
  NAME_RE,
  PLATFORMS,
  PORT_FLOOR,
  PORT_CEIL,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  CONFIG_SECTION,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  API_PORT,
  MAX_ORIGINS,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
export { PEER_MAX, BindingBook, checkPeerId } from './bindings.js'
export { LOOPBACK_HOSTS, MissingRelay, checkRelayUrl, relayPortOf } from './bridge.js'
export { PREREQUISITES, evaluatePrereqs, prereqOf } from './prereq.js'
export { PetMobileHub } from './service.js'
export type { PetMobileDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-pet-mobile'

/**
 * 向 O-005 注册配置段。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-pet-mobile: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', textOf(error))
    return false
  }
}

/**
 * 把异常折成一句文本。
 * @param error 异常。
 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

declare module '@ntars/cordis' {
  interface Context {
    /** 三端互通入口；未装载本插件时为 undefined。 */
    'ondra-pet-mobile'?: PetMobileService
  }
}

/**
 * Cordis 入口：解析配置、装服务。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  // 日志命名空间 `ondra.pet-mobile`（前缀由 O-001 给）。
  const log = ctx.logger(identity ? identity.loggerName('pet-mobile') : 'ondra.pet-mobile')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  // 1. 配置：有 O-005 就走四层合并。
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  const onBad = (text: string, kind: string): void => {
    log.warn('配置条目已丢弃（%s）：%s', kind, text)
  }
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
      log.warn('解析配置段失败，退回插件实例配置：%s', textOf(error))
    }
  }
  const settings = completeConfig(effective, onBad)

  // 2. 时钟：每次现取（上游晚装载能自愈）。
  const now = (): number => {
    const clock = ctx.get('ondra-clock') as ClockLike | undefined
    return clock === undefined ? Date.now() : clock.now()
  }

  // 3. 四个上游探测：每次现取，不缓存（缓存会让「刚装好的 O-010」一直显示缺）。
  const hub = new PetMobileHub({
    settings,
    log,
    now,
    hasMemoryCore: () => ctx.get('ondra-memory-core') !== undefined,
    hasPet: () => ctx.get('ondra-pet') !== undefined,
    // 上游 `webServer`：只判存在，不注册路由、不调用成员。
    // 用 `WebServerLike` 收窄一下，免得把宿主上那个完整对象漏进本包的类型里。
    hasWebServer: () => (ctx.get('webServer') as WebServerLike | undefined) !== undefined,
    petState: () => {
      const pet = ctx.get('ondra-pet') as PetLike | undefined
      if (pet === undefined) return 'unknown'
      return pet.status().state
    },
  })

  // 4. 注册服务。
  ctx.effect(
    () => {
      const dispose = ctx.provide(PET_MOBILE_SERVICE_KEY, hub)
      return () => {
        hub.dispose()
        dispose()
      }
    },
    'ondra-pet-mobile: 注册三端互通入口服务',
  )

  // 5. 报一次现状：逐条把阻塞项说出来，并明确手机端还没发布。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被夹紧或丢弃（与你设的不一样）：%s', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('三端互通默认关闭（enable=false）：它会把同一份记忆接到别的设备上')
  } else if (settings.platforms.length === 0) {
    log.warn('`platforms` 是空的：一个端都不接（**不是全接**）。可选 pet / qq / wechat')
  } else {
    log.info('启用的端：%s', settings.platforms.join(' / '))
  }

  // 前提清单跑一遍，但只报结论——具体每条在 `check()` 里。
  const report = hub.check()
  if (report.ready) {
    log.info('三端互通的服务端侧前提已齐（%d 条通过）', report.passed.length)
  } else {
    for (const blocker of report.blockers) {
      log.warn('前提没齐：%s —— %s', blocker.title, blocker.hint ?? blocker.detail)
    }
  }
  for (const warning of report.warnings) {
    log.info('不阻塞但要知道：%s（%s）', warning.title, warning.detail)
  }

  if (settings.relayUrl.trim() !== '') {
    const relay = checkRelayUrl(settings.relayUrl)
    if (relay.ok) {
      const port = relayPortOf(settings.relayUrl)
      log.info('中继地址合规（端口 %s）。地址本身不回显', port === null ? '?' : String(port))
      if (port !== null && port === settings.apiPort) {
        log.warn(
          '本机 API 端口与中继端口都是 %d：两个服务会抢同一个监听口，一个起来另一个静默失败（手册链路是 3000 / 3001）',
          port,
        )
      }
    } else {
      log.warn('中继地址不合规：%s %s', relay.detail, relay.hint ?? '')
    }
  }

  if (settings.allowedOrigins.length === 0) {
    log.warn(
      '允许来源清单是空的：任何来源都连不上中继。这是明确默认——不填就启动等于不校验 Origin（§9.2）',
    )
  }

  log.warn(
    '本版是能力入口：不做移动端窗口（手册 §1.11-07 手机端「即将适配」），' +
      '也没有 WS 中继实现（本仓无三端中继、无帧格式依据）——`connect()` 会如实回 `no-bridge`',
  )
  log.info('不注册任何工具：三端互通是基础设施，不是模型动作')
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: Settings } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能安全补全（越界夹紧、坏条目回退并计数），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
