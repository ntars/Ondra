/**
 * O-057 `ondra-channel-health`：每通道一个独立探针，只读已落地的痕迹。
 *
 * ## 装载期只做四件事
 *
 * 1. 解析配置（有 O-005 就走四层合并，没有就用本地校验）；
 * 2. 定记录目录（`user/channels/health/`）；
 * 3. `provide` 服务；
 * 4. 把「今天的证据从哪来、缺什么」逐条讲清楚。
 *
 * **装载期不探测任何通道。** 通道适配器可能晚于本插件装载，装载期探测
 * 拿到的必然是「一个都没有」，而这个结论会被面板当成事实记住一整天。
 *
 * ## 刻意不声明插件级 `inject`
 *
 * 消费 `ondra-config-schema` / `ondra-path-layout` / `ondra-clock` / `ondra-identity`
 * 四个，全软。声明 `inject` 会让缺一个就整包停 PENDING——
 * 而「某个通道为什么不回消息」恰恰要从探针读出来，探针自己没装载就无从查起。
 *
 * ## 刻意不读日志文件
 *
 * 手册 §8.3 要求日志命名空间 `channel.<id>`，但 O-004 `ondra-log-zh` 的契约
 * **没有按命名空间读取的接口**（只有 `tailHuman(limit)`，读单份中文日志的纯文本尾部）。
 * 本插件因此不碰文件，只留一个可选端口 `attachLogFeed()`。
 * 这条缺口已写进 README「已知限制」，并在台账登记——不偷偷绕过去。
 */

import type { Context } from '@ntars/cordis'
import { HealthProbe } from './service.js'
import { RecordStore } from './store.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  RECORD_DIR_SEGMENTS,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as HealthConfig } from './settings.js'
import { HEALTH_SERVICE_KEY, NAME_RE } from './types.js'
import type {
  ChannelHealthService,
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  PathLayoutLike,
} from './types.js'

export type * from './types.js'
export {
  HEALTH_SERVICE_KEY,
  NAME_RE,
  EVIDENCE_KINDS,
  HEALTH_STATES,
  HEALTH_REASONS,
  HEALTH_REASON_ZH,
  EVIDENCE_SOURCES,
  channelNamespace,
  isEvidenceKind,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  RECORD_DIR_SEGMENTS,
  EXPECT_MS_FLOOR,
  EXPECT_MS_CEIL,
  STALE_FACTOR_FLOOR,
  STALE_FACTOR_CEIL,
  ERROR_WINDOW_FLOOR,
  ERROR_WINDOW_CEIL,
  RECONNECT_LIMIT_FLOOR,
  RECONNECT_LIMIT_CEIL,
  MAX_CHANNELS_FLOOR,
  MAX_CHANNELS_CEIL,
  FLUSH_MS_FLOOR,
  FLUSH_MS_CEIL,
  completeConfig,
  configDriftOf,
  expectMsOf,
} from './settings.js'
export {
  RECONNECT_KEEP,
  CLOCK_SKEW_MS,
  isChannelId,
  emptyRecord,
  applyEvent,
  evaluate,
  sourcesOf,
  toHealth,
  severityOf,
  worstOf,
} from './probe.js'
export type { ChannelRecord, Thresholds, Verdict } from './probe.js'
export { RecordStore } from './store.js'
export type { StoreStats } from './store.js'
export { HealthProbe, reasonText } from './service.js'
export type { ServiceDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-channel-health'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 让定时器不阻止进程退出。
 * 不直接 `handle.unref()`：浏览器/Worker 里 `setInterval` 返回数字，直接调会抛错。
 * @param handle 定时器句柄。
 */
function unrefTimer(handle: ReturnType<typeof setInterval>): void {
  const maybe = handle as unknown as { unref?: () => void }
  if (typeof maybe.unref === 'function') maybe.unref()
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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-channel-health: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 通道探针服务；未装载本插件时为 undefined。 */
    'ondra-channel-health'?: ChannelHealthService
  }
}

/**
 * Cordis 入口：解析配置、备好记录目录、注册服务、报一次现状。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: HealthConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('channel-health') : 'ondra.channel-health')

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

  // 3. 定记录目录。没有 path-layout 就只在内存里，并说清代价。
  let recordDir = ''
  if (settings.persist) {
    const layout = ctx.get('ondra-path-layout') as PathLayoutLike | undefined
    if (layout === undefined) {
      log.warn(
        '未装载 ondra-path-layout：通道探针记录只在内存里，重启后会显示「从没上报过」（与真的没跑过同形）',
      )
    } else {
      try {
        recordDir = layout.ensure('user', ...RECORD_DIR_SEGMENTS)
      } catch (error) {
        log.warn('记录目录创建失败，转仅内存：%s', messageOf(error))
      }
    }
  }

  const store = new RecordStore(recordDir, log)
  const service = new HealthProbe({
    settings,
    log,
    now: (): number => {
      const clock = ctx.get('ondra-clock') as ClockLike | undefined
      return clock === undefined ? Date.now() : clock.now()
    },
    store,
  })

  // 4. 注册服务 + 落盘定时器。卸载时一起撤，不留半条定时器。
  ctx.effect(
    () => {
      const dispose = ctx.provide(HEALTH_SERVICE_KEY, service)
      const flushTimer = setInterval(() => {
        try {
          service.flush()
        } catch {
          // 落盘失败由 store 内部计数并降级，这里不重复处理。
        }
      }, settings.flushMs)
      unrefTimer(flushTimer)
      return () => {
        clearInterval(flushTimer)
        service.dispose()
        dispose()
      }
    },
    'ondra-channel-health: 注册通道探针服务',
  )

  // 5. 报一次现状。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值非法已回退（%s）：与你设的不一样', drift.join(' / '))
  }

  if (!settings.enable) {
    log.warn('通道探针已关闭（enable=false）：所有通道一律报「探针已关闭」，服务照常注册')
  } else {
    log.info(
      '通道探针就绪：心跳期望 %dms · 判「很久没动静」×%d（%dms）· 错误窗口 %dms · 上限 %d 个通道',
      settings.expectMs,
      settings.staleFactor,
      settings.expectMs * settings.staleFactor,
      settings.errorWindowMs,
      settings.maxChannels,
    )
  }

  if (store.available) {
    log.info('探针记录落盘到 %s（一通道一份，0600）', recordDir)
  } else {
    log.info('探针记录不落盘：重启后无法说明「上次活到几时」')
  }

  // 日志端口缺口：这条必须说出来，否则用户会以为「探针在只读日志」。
  log.info(
    '未接日志端口：O-004 的契约没有「按命名空间读取」的接口（只有 tailHuman），' +
      '本插件不读日志文件、不解析行格式；证据一律由适配器 report() 推来',
  )

  if (service.size() > 0) {
    log.info('已恢复 %d 个通道的记录，可用 probeAll() 看它们的最后活动时刻', service.size())
  } else {
    log.info('还没有任何通道上报：probeAll() 会是空表（不是「全部健康」）')
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
    ) => { readonly value: HealthConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能被安全补全（越界夹紧、非法项逐项丢弃），因此永远不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
