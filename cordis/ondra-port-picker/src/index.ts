/**
 * O-083 `ondra-port-picker`：**给回环挑端口**。档位〔研〕。
 *
 * ## 为什么不是〔复〕
 *
 * 上游确实有一半：`webServer` 的 `port: 0` 就是「让内核挑」，且它绑完之后
 * `webServer.port` 会把内核给的号读出来。所以**「读界面地址」这一半是纯复用**。
 *
 * 但台账要的另一半——「9060–9079 回环」——上游没有：全仓 grep
 * `findFreePort / freePort / getPort / pickPort` **0 命中**，没有任何可复用的
 * 区间扫描器。这一半只能自己写，且只有几十行（`probe.ts` + `policy.ts`），
 * 所以档位保持〔研〕，同时把能复用的那一半老老实实接上。
 *
 * ## 它做什么
 *
 * 1. `listener`（默认）：给一个**现在没人绑**的号。`system` 分支让内核分配，
 *    `fixed` 分支在区间里扫。
 * 2. `endpoint`：读出宿主 `webServer` **已经绑着**的号——这是「打开浏览器」要的那个号，
 *    和上一条正好相反。
 * 3. 进程内账本：防同一进程里两个人拿到同一个号（**不是锁**，见 `ledger.ts`）。
 *
 * ## 它刻意不做什么
 *
 * 1. **不占端口。** 探完立刻释放。接口里没有 `hold()`——「保留」等于把要交出去的号
 *    攥在自己手里，子进程就绑不上了。
 * 2. **不开公网。** 只接受回环字面量，`0.0.0.0` 一律拒绝，与上游 `webServer`
 *    拒绝通配地址的口径一致。
 * 3. **加载时不探测。** 一次都没人要用的时候去绑端口，只是白占一次内核表。
 * 4. **不拼 URL。** 拼地址是 `ondra-onboarding` 的事（它才知道 token 从哪来），
 *    本包只给号。两处各拼一份，迟早拼出两种形状。
 */

import type { Context } from '@ntars/cordis'
import { TcpProbe } from './probe.js'
import { PortPicker } from './service.js'
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
import { PORT_PICKER_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  PortPickerService,
  WebServerLike,
} from './types.js'

export type * from './types.js'
export { PORT_PICKER_SERVICE_KEY, NAME_RE } from './types.js'
export {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  DEFAULT_HOST,
  DEFAULT_LEDGER_TTL_MS,
  DEFAULT_MAX_SCAN,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_RANGE_END,
  DEFAULT_RANGE_START,
  FIELD_SPECS,
  SECTION_KEYS,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
export {
  candidatesOf,
  describeBranch,
  describeIntent,
  describeReason,
  formatTried,
  isLoopbackHost,
  normalizePort,
  purposeOf,
  raceOf,
  validateRange,
} from './policy.js'
export type { RangeVerdict } from './policy.js'
export { PortLedger } from './ledger.js'
export { TcpProbe } from './probe.js'
export { pickSystem } from './system.js'
export type { SystemBranchDeps } from './system.js'
export { pickFixed } from './fixed.js'
export type { FixedBranchDeps } from './fixed.js'
export { pickEndpoint } from './endpoint.js'
export type { EndpointDeps } from './endpoint.js'
export { PortPicker } from './service.js'
export type { PortPickerDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-port-picker'

/**
 * 把异常折成一句文本。
 * @param error 异常。
 */
function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 取宿主 `webServer`。
 *
 * 只读 `port` 与 `host` 两个属性，不调用它任何方法——本包不是它的消费者，
 * 只是要一个既成事实。取属性也要包 try：别的实现可能在未绑定时抛。
 * @param ctx 宿主上下文。
 */
function webServerOf(ctx: Context): WebServerLike | null {
  const raw: unknown = ctx.get('webServer')
  if (raw === undefined || raw === null) return null
  try {
    const candidate = raw as { readonly port?: unknown; readonly host?: unknown }
    const port = candidate.port
    if (typeof port !== 'number') return null
    return {
      port,
      host: typeof candidate.host === 'string' ? candidate.host : undefined,
    }
  } catch {
    return null
  }
}

/**
 * 向 O-005 注册配置段。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-port-picker: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', textOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 端口挑选；未装载本插件时为 undefined。 */
    'ondra-port-picker'?: PortPickerService
  }
}

/**
 * Cordis 入口：解析配置、装服务。**不探测任何端口**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('port-picker') : 'ondra.port-picker')

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

  const now = (): number => {
    const clock = ctx.get('ondra-clock') as ClockLike | undefined
    return clock === undefined ? Date.now() : clock.now()
  }

  // 2. 服务：探测实现与宿主端口都用「取的时候再看」的写法——
  //    `webServer` 可能比本插件晚装载，早取会把 null 缓存一辈子。
  const service = new PortPicker({
    settings: () => settings,
    log,
    now,
    probe: new TcpProbe(),
    webServer: () => webServerOf(ctx),
  })

  ctx.effect(
    () => {
      const dispose = ctx.provide(PORT_PICKER_SERVICE_KEY, service)
      return () => {
        service.dispose()
        dispose()
      }
    },
    'ondra-port-picker: 注册挑端口服务',
  )

  // 3. 报一次现状。**不探测、不占号。**
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被类型不符丢弃（与你设的不一样）：%s', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('端口挑选关着：`pick()` 会返回 `disabled`，账本仍可读')
    return
  }

  const bound = webServerOf(ctx)
  if (settings.branch === 'fixed') {
    log.info(
      '端口挑选就绪：固定区间 %d–%d，地址 %s，最多试 %d 个',
      settings.rangeStart,
      settings.rangeEnd,
      settings.host,
      settings.maxScan,
    )
    if (settings.rangeStart < 1024) {
      log.warn('固定区间下界 %d 小于 1024：绑定需要特权，`pick()` 会一直报 `bad-range`', settings.rangeStart)
    }
    if (settings.rangeStart > settings.rangeEnd) {
      log.warn(
        '固定区间下界 %d 大于上界 %d：`pick()` 会报 `bad-range`（不自动交换，免得配置页与实际不一致）',
        settings.rangeStart,
        settings.rangeEnd,
      )
    }
  } else {
    log.info('端口挑选就绪：系统分配（等价 `--port 0`），地址 %s', settings.host)
  }

  if (bound === null || bound.port === undefined) {
    log.info('宿主 `webServer` 尚未绑定：`endpoint` 请求会报 `no-endpoint`，`listener` 请求不受影响')
  } else {
    log.info('宿主 `webServer` 已绑定 %d：`endpoint` 请求可直接取用', bound.port)
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
    ) => { readonly value: Settings } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能安全补全（越界夹紧、类型不符回退并计数），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
