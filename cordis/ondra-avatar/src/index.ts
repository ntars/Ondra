/**
 * O-054 `ondra-avatar`：立绘的接线层（静态降级 + Live2D 接线点）。
 *
 * ## 装载期只做三件事
 *
 * 1. 解析配置（有 O-005 就走四层合并，没有就用本地校验）；
 * 2. 扫一遍素材目录；
 * 3. `provide` 服务，并把「此刻能显示什么、缺什么」逐条打出来。
 *
 * **装载期不取帧**：此刻 O-031 可能还没起来，算出的「脸上是平静」
 * 会被当成结论，而它其实只是「那会儿还没装好」（与 O-049 / O-052 同一条纪律）。
 *
 * ## 刻意不声明插件级 `inject`
 *
 * 消费 `ondra-emotion-express`（软）/ `ondra-expression-decide`（软）/
 * `ondra-path-layout`（软）/ `ondra-persona-core`（软）/
 * `ondra-config-schema`（软）/ `ondra-clock`（软）/ `ondra-identity`（软）。
 * 全软。声明 `inject` 会让缺一个就整包停 PENDING，面板连
 * 「为什么立绘是空的」都读不到——而那个答案恰恰就在缺席里。
 *
 * ## 刻意不注册工具、不碰 DOM
 *
 * 注册 `set_expression` 这类工具，模型就能自己决定"我该摆什么脸"，
 * 那等于让被观察者写观察结果。碰 DOM 更不行：§12.4 明令禁止
 * 独立前端工程，插件的成品形态只有 `apply(ctx)`。
 * 渲染归界面层（L8）或外部 Live2D 运行时，本插件只交帧。
 */

import type { Context } from '@ntars/cordis'
import { Avatar } from './service.js'
import { nodeFs } from './fs.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as AvatarConfig } from './settings.js'
import { AVATAR_SERVICE_KEY, NAME_RE, REASON_ZH } from './types.js'
import type {
  AvatarService,
  ClockLike,
  ConfigSchemaLike,
  ExpressLike,
  IdentityLike,
  LogLike,
  PathLayoutLike,
  PersonaCoreLike,
} from './types.js'

export type * from './types.js'
export {
  AVATAR_SERVICE_KEY,
  NAME_RE,
  AVATAR_STATES,
  ASSET_KEYS,
  FALLBACK_KEYS,
  STATE_ZH,
  REASON_ZH,
  PROVIDER_PREFS,
  isAssetKey,
  isAvatarState,
  isFrameSource,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  MIN_HOLD_FLOOR,
  MIN_HOLD_CEIL,
  DIR_MAX,
  completeConfig,
  configDriftOf,
  isSafeDir,
} from './settings.js'
export { scanAvatar } from './scan.js'
export type { ScanInput, ScanTarget } from './scan.js'
export { assetFor, providerOf, buildFrame } from './resolve.js'
export type { FrameShape, ProviderQuery, ProviderState } from './resolve.js'
export { Avatar } from './service.js'
export type { AvatarDeps } from './service.js'
export { nodeFs } from './fs.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-avatar'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 向 O-005 注册配置段。放进 `ctx.effect`：段是本插件的资源，卸载时必须一起撤。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 注册是否成功。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-avatar: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 立绘服务；未装载本插件时为 undefined。 */
    'ondra-avatar'?: AvatarService
  }
}

/**
 * Cordis 入口：解析配置、扫素材、注册服务、报一次现状。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: AvatarConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('avatar') : 'ondra.avatar')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  // 1. 有 O-005 就让配置走四层合并。
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

  // 2. 补全 + 校验。任何非法值都回退默认，绝不抛。
  const settings = completeConfig(effective)

  const service = new Avatar({
    settings,
    log,
    now: (): number => {
      const live = ctx.get('ondra-clock') as ClockLike | undefined
      return live === undefined ? Date.now() : live.now()
    },
    fs: nodeFs,
    layout: () => ctx.get('ondra-path-layout') as PathLayoutLike | undefined,
    persona: () => ctx.get('ondra-persona-core') as PersonaCoreLike | undefined,
    express: () => ctx.get('ondra-emotion-express') as ExpressLike | undefined,
  })

  // 3. 注册服务。
  ctx.effect(() => ctx.provide(AVATAR_SERVICE_KEY, service), 'ondra-avatar: 注册立绘服务')

  // 4. 报一次现状。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值非法已回退（%s）：与你设的不一样', drift.join(' / '))
  }

  const scan = service.lastScan()
  if (scan.issues.length > 0) {
    log.warn('立绘素材有 %d 处需要注意：%s', scan.issues.length, scan.issues.join(' / '))
  }

  if (!settings.enable) {
    log.warn('立绘已关闭（enable=false）：frame() 一律给"已关闭"的空帧，服务照常注册')
  } else if (!service.available) {
    const reason = service.reason
    log.warn('立绘现在显示不了：%s', reason === undefined ? '原因未知' : REASON_ZH[reason])
  } else {
    log.info(
      '立绘就绪：通道 %s · 图 %d 张 · 模型 %d 个 · 渲染器 %s · 素材在 %s',
      service.provider,
      service.assets().length,
      service.models().length,
      service.renderer ?? '（未注册，装有 Live2D 运行时的实现需自行注册）',
      scan.dirs.length === 0 ? '（未知）' : scan.dirs.map(dir => dir.path).join(' , '),
    )
  }

  // 「此刻」的上游。后装载是正常的，因此只用 info。
  if (ctx.get('ondra-emotion-express') === undefined) {
    log.info('此刻没有 ondra-emotion-express：只能给默认表情（装好之后自动恢复，无需重启插件）')
  }
  if (ctx.get('ondra-expression-decide') === undefined) {
    log.info('此刻没有 ondra-expression-decide：脸上只跟内态走，不会按正文换脸')
  }
  if (ctx.get('ondra-path-layout') === undefined) {
    log.warn('此刻没有 ondra-path-layout：不知道素材目录在哪，立绘只会出态不会出图')
  }
  if (!NAME_RE.test(name)) {
    log.error('插件名不合规（%s）：服务键会被模型侧拒绝', name)
  }
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
    ) => { readonly value: AvatarConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能被安全补全（越界夹紧、非法枚举回退），因此永远不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
