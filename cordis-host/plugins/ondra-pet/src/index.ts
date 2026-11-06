/**
 * O-074 `ondra-pet`：桌宠**能力入口**。档位〔复〕（复用生态桌宠，不自研窗口）。
 *
 * ## 这一版到底是什么
 *
 * 手册 §6.3 只有六条，且第一条就是「不自研」。所以本包不画窗口、不做立绘、不做 Live2D，
 * 只做「入口」该做的四件事：
 *
 * 1. 许可证闸门（`adapters.ts`）——把「AGPL 只能读思路」变成可执行判定，而不是一句提醒；
 * 2. 桥接安全（`bridge.ts`）——§9.2 的 Origin + 一次性 token，落成默认全拒的纯函数；
 * 3. 单实例状态机（`state.ts`）——桌面上只能有一只；
 * 4. 渲染档降级——`live2d` 如实拒绝，不黑屏。
 *
 * 桥本身（真正开窗口的那层）不在本仓：`desktop/packages/**` 按能力查
 * `pet|live2d|sprite` **0 命中**，本仓也禁装依赖。所以 `PetBridge` 端口 + `MissingBridge`
 * 如实回 `no-bridge`，接一个实现只需 `useBridge()`，本包不用改。
 *
 * ## 为什么不注册工具
 *
 * 「叫出桌宠」是**用户**的动作。给模型一个 `pet-summon`，等于允许它在你屏幕上弹一个窗口，
 * 而它会觉得「这时候她出现一下挺好」。器官的责任边界是「只能提议，不能改世界」（§8.1 C1），
 * 开窗口是改世界。所以召唤只暴露在服务对象上，由界面在用户点击后调用。
 *
 * ## 为什么 patch 里不写 config / inject
 *
 * config：默认值的唯一真源是 `settings.ts` 的 `FIELD_SPECS`，写进 patch 就是抄第二份。
 * inject：本包对 identity / config-schema 全是软依赖，声明成插件级 inject 会让上游缺席时
 * 整插件停在 PENDING（手册 §8.3 的静默失败之一）。
 */

import type { Context } from '@ntars/cordis'
import { PetHub } from './service.js'
import { PET_ADAPTERS, adapterOf, adapterUsable, licenseVerdict } from './adapters.js'
import { checkBridgeUrl, checkOrigins } from './bridge.js'
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
import { PET_SERVICE_KEY } from './types.js'
import type { ConfigSchemaLike, IdentityLike, LogLike, PetService } from './types.js'

export type * from './types.js'
export { PET_SERVICE_KEY, NAME_RE, PET_TRANSITIONS, RENDER_MODES } from './types.js'
export {
  CONFIG_SECTION_ID,
  CONFIG_SECTION,
  DEFAULT_ADAPTER,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  SCALE_FLOOR,
  SCALE_CEIL,
  TOKEN_TTL_MS,
  TTL_FLOOR,
  TTL_CEIL,
  MAX_ORIGINS,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
export { PET_ADAPTERS, adapterOf, adapterUsable, licenseVerdict } from './adapters.js'
export {
  LOOPBACK_HOSTS,
  TOKEN_MIN,
  TOKEN_MAX,
  TOKEN_PARAMS,
  MissingBridge,
  checkBridgeUrl,
  checkOrigins,
  checkToken,
} from './bridge.js'
export { STATE_LABELS, canTransition, describeState, isBusy, isRunning } from './state.js'
export { PetHub } from './service.js'
export type { PetDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-pet'

/**
 * 向 O-005 注册配置段。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-pet: 注册配置段')
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
    /** 桌宠入口；未装载本插件时为 undefined。 */
    'ondra-pet'?: PetService
  }
}

/**
 * Cordis 入口：解析配置、装服务。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  // 日志命名空间 `ondra.pet`（前缀由 O-001 给）。
  const log = ctx.logger(identity ? identity.loggerName('pet') : 'ondra.pet')

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

  const hub = new PetHub({ settings, log })

  // 2. 注册服务。撤服务时一并撤桥引用。
  ctx.effect(
    () => {
      const dispose = ctx.provide(PET_SERVICE_KEY, hub)
      return () => {
        hub.dispose()
        dispose()
      }
    },
    'ondra-pet: 注册桌宠入口服务',
  )

  // 3. 报一次现状——每条都指向一个能被执行的动作。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被夹紧或丢弃（与你设的不一样）：%s', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('桌宠入口默认关闭（enable=false）：它会开一个独立窗口，端侧能力出厂全关')
  } else {
    const usable = adapterUsable(settings.adapter)
    if (usable.usable) {
      log.info('适配器：%s', usable.detail)
    } else {
      log.warn('适配器不可用：%s', usable.detail)
    }
  }

  // 许可证这件事必须每次启动都说一遍：它是「能不能进这台机器」的问题，不是偏好。
  for (const adapter of PET_ADAPTERS) {
    if (licenseVerdict(adapter) === 'blocked') {
      log.warn('%s 的许可证是 %s，`summon()` 会拒绝它（手册 §9.1）', adapter.title, adapter.license)
    }
  }
  const chosen = adapterOf(settings.adapter)
  if (chosen !== undefined && !chosen.verified) {
    log.info('%s 的 LICENSE 本轮未逐字核对（手册 §9.1：新仓库许可需正式确认），面板会显示「未核对」', chosen.title)
  }

  if (settings.render !== 'static') {
    log.warn(
      '渲染档 `%s` 会被拒绝：Live2D 的 Cubism Core 专有且不可再分发，手册 §6.3 明确 1.0 阶段不做（静态降级）',
      settings.render,
    )
  }

  if (settings.bridgeUrl.trim() === '') {
    log.info('桥地址未配置：不会启动桌宠（不编默认地址，否则「没配」会看起来像「配好了」）')
  } else {
    const url = checkBridgeUrl(settings.bridgeUrl, { allowTokenInUrl: settings.allowTokenInUrl })
    if (url.ok) {
      log.info('桥地址合规（回环 + WS + 显式端口）。地址本身不回显：它可能带 query')
    } else {
      log.warn('桥地址不合规：%s %s', url.detail, url.hint ?? '')
    }
  }

  if (settings.allowedOrigins.length === 0) {
    log.warn(
      '允许来源清单是空的：任何来源都连不上桥。这是明确默认而非故障——不填就启动等于不校验 Origin（手册 §9.2 的 CSWSH 教训）',
    )
  } else {
    const origins = checkOrigins(settings.allowedOrigins)
    log.info('允许来源 %d 条%s', settings.allowedOrigins.length, origins.ok ? '' : `（有不合规条目：${origins.detail}）`)
  }

  log.warn(
    '本版是能力入口：窗口、立绘、Live2D 都不在本仓（按能力查 desktop/packages 0 命中），' +
      '`PetBridge` 端口已就位但没有实现——`summon()` 会如实回 `no-bridge`，不会假装她已经在桌面上',
  )
  log.info(
    '一个工具都没注册：召唤是用户动作，不是模型动作（模型能开窗口 = 越权，§8.1 C1）',
  )
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
