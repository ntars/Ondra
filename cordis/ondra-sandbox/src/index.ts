/**
 * O-119 `ondra-sandbox`：能力分级沙箱（〔研〕自研，L9 扩展池，〔薄〕档）。
 *
 * ## 它到底做什么
 *
 * 把「这只插件这一次能干多大的事」分成四级（read / suggest / act / spend），
 * 发一张**有期限、有次数**的票；越权就拒绝。
 *
 * 四条主要裁决：
 *
 * 1. **默认拒绝。** 没有票就没有任何能力。`check()` 从不「默认放行」。
 * 2. **票会过期，也会用完。** 过期时刻就是 `expiresAt`，用完时刻就是最后一次调用的时刻；
 *    两个时刻都记进票据档，`snapshot()` 与拒绝信息里都能查到。
 * 3. **`spend` 要二次确认。** 调用方必须把动作名原样放进 `confirm`——
 *    布尔值太容易被复制粘贴成 `true`，而重写一遍动作名至少要求知道自己在做什么。
 * 4. **与 `ondra-organ-gate` 分得开**（见 `src/types.ts` 文件头的边界表）：
 *    那边管「能不能用宿主门面」，本包管「这一次该不该放行」。错误类因此叫
 *    `SandboxDeniedError`，**不叫** `CapabilityDeniedError`。
 *
 * ## 它刻意不做什么（五条）
 *
 * - **不接管宿主权限系统。** 不调 `ctx.tools.restrict`，不改任何插件的注册表；
 *   本包拒了就是拒了，不负责让上游也拒。
 * - **不实现器官 ABI。** 不碰 `ondra-organ-host` 的门面，也不假装自己是器官。
 * - **不做界面。** 状态走服务键，渲染归应用外壳（`desktop/`）。
 * - **不装定时器。** 过期是算出来的（`at >= expiresAt`），不需要后台扫描；
 *   装了定时器，一个没人用的插件也在偷偷烧 CPU。
 * - **不存调用内容。** 盘上只有票据，没有参数、返回值、调用理由。
 *
 * ## 依赖纪律
 *
 * 四项全是**软依赖**（身份 / 时钟 / 路径 / 配置），故不声明插件级 `inject`。
 * 任一缺席都能跑，只是降级——降级处各有一行日志，不静默。
 */

import type { Context } from '@ntars/cordis'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as SandboxConfig } from './settings.js'
import { Sandbox } from './service.js'
import { SANDBOX_SERVICE_KEY } from './types.js'
import type { ClockLike, ConfigSchemaLike, IdentityLike, LogLike, PathLike, SandboxService } from './types.js'

export type * from './types.js'
export {
  SANDBOX_SERVICE_KEY,
  KEY_RE,
  ACTION_RE,
  SUBJECT_RE,
  STATE_FILE_NAME,
  STATE_VERSION,
  LEVELS,
  LEVEL_RANK,
  LEVEL_SPECS,
  SandboxDeniedError,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  CONFIG_SECTION,
  TTL_FLOOR_HOURS,
  TTL_CEILING_HOURS,
  USES_FLOOR,
  USES_CEILING,
  TICKETS_FLOOR,
  TICKETS_CEILING,
  completeConfig,
} from './settings.js'
export {
  isLevel,
  rankOf,
  levelSpecOf,
  checkSubject,
  checkAction,
  normalizeGrant,
  normalizeCheck,
  newTicketId,
  makeTicket,
  stateOf,
  isLive,
  settle,
  pickTicket,
  explainEnded,
  judge,
  consume,
  revokeRecord,
  toView,
  prune,
  normalizeRecord,
  codeOf,
  reasonZh,
  toDecision,
  atZh,
} from './tickets.js'
export { readTickets, writeTickets } from './store.js'
export { Sandbox } from './service.js'
export type { SandboxDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-sandbox'

/**
 * 本插件**不声明** `inject`：四项依赖全是软依赖，缺谁都能跑。
 *
 * 写在这里是给未来的自己看的：沙箱最顺手的一步是「接管所有工具调用」。
 * 那一步之后就变成了权限系统，而权限系统一旦接管，任何一次误判都会
 * 让整台机器上的插件同时失灵——那不是这个〔薄〕档包该背的责任。
 */

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-sandbox: 注册配置段')
    return true
  } catch (error) {
    log.warn(
      '向 ondra-config-schema 注册配置段失败（四层合并与来源追溯不可用，退回插件实例配置）：%s',
      messageOf(error),
    )
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 能力分级沙箱服务；未装载本插件时为 undefined。 */
    'ondra-sandbox'?: SandboxService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: SandboxConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('sandbox') : 'ondra.sandbox')
  if (identity === undefined) {
    // 身份缺席只影响日志命名空间，不影响判定；但仍要说一声，否则排查时会对不上号。
    log.debug?.('ondra-identity 缺席：日志命名空间退回 ondra.sandbox')
  }

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  // 1. 有 O-005 就让配置走四层合并（出问题时能说出「哪一层的哪个字段」）。
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  if (schema !== undefined && registerSection(ctx, schema, log)) {
    try {
      const resolved = schema.resolve(CONFIG_SECTION_ID, { user: normalizeUserLayer(raw) })
      if (resolved !== undefined) {
        effective = valuesToConfigShape(resolved.values)
        if (resolved.fallbackCount > 0) {
          // 回退是静默的危险动作：不报数等于埋雷（O-005 原话）。
          log.warn('配置有 %d 个字段校验失败，已逐个回退默认值', resolved.fallbackCount)
        }
      }
    } catch (error) {
      log.warn('解析配置段失败，退回插件实例配置：%s', messageOf(error))
    }
  } else if (schema === undefined) {
    // 缺席也要留一行：没有四层合并时，配置只有一个来源，出问题无法说清「哪一层的哪个字段」。
    log.debug?.('ondra-config-schema 缺席：用插件实例配置与内置默认值（无四层合并与来源追溯）')
  }

  // 2. 补全。任何非法值都回退默认，绝不抛。
  const settings = completeConfig(effective)

  // 3. 建服务。时钟与路径都用取值函数：上游晚装载时能自愈，早卸载时立刻退回降级。
  const service = new Sandbox({
    settings,
    log,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    path: () => ctx.get('ondra-path-layout') as PathLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(() => ctx.provide(SANDBOX_SERVICE_KEY, service), 'ondra-sandbox: 注册能力分级沙箱服务')

  // 4. 报一次现状。四个数必须能被自检读到，不许黑箱。
  log.info(
    '能力分级沙箱就绪：%s（默认票期 %dh / 上限 %dh，默认 %d 次 / 上限 %d 次，票据档 %d 张；默认拒绝，spend 需二次确认）',
    service.available ? '可用' : '不可用',
    settings.defaultTtlHours,
    settings.maxTtlHours,
    settings.defaultUses,
    settings.maxUses,
    settings.maxTickets,
  )
  if (!settings.enable) {
    log.warn('能力分级沙箱已关闭（enable=false）：服务照常注册，grant() / check() / revoke() 一律抛 disabled')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。数值越界会被夹到区间内，
 * 两个上限会被抬到不低于对应默认值，因此永远不产 issue——配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: SandboxConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      return { value: completeConfig(value) }
    },
  },
}
