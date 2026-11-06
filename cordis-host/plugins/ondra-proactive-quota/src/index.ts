/**
 * O-044 `ondra-proactive-quota`：主动消息的节律与性格化沉默。
 *
 * ## 它在投递链上的位置
 *
 * ```
 * O-043 话由（说什么） → 本插件（愿意说吗 / 今天还剩几句 / 该退场了吗）
 *                      → O-042 门控（此刻能发吗） → 发送 → 本插件记账
 * ```
 *
 * 手册 §5.2 的「时机 / 话由 / 分寸」三分：**话由**是 O-043，**时机与分寸的硬闸**
 * 是 O-042，本插件接的是分寸里最软的那一半——她今天还想不想开口。
 *
 * ## 明确不做
 *
 * - **不判断「此刻能不能发」**：静默时段、速率、冷却、内容红线、熔断全在 O-042。
 *   两处都判，就会两处说法不一样。
 * - **不生成正文**：退场句也是正文，归对话链（O-033）与她的话由池（O-043）。
 *   本插件只说「这一条该是退场句」，不说它该是什么字。
 * - **不重算额度衰减**：`≥3 天减半 / ≥7 天归零` 是 O-042 的 `budgetOf()`。
 *   我们把**未衰减**的档位额度交回去，让它算一次。
 * - **不装定时器、不订阅事件**：零常驻（§14.2）。所有时间从入参或 `now()` 取。
 * - **不存「今天说了几句」**：那是 O-042 的 `dayCount`，经 `peek()` 读。
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
import type { Config as QuotaConfig } from './settings.js'
import { ProactiveQuota } from './service.js'
import { NAME_RE, QUOTA_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  GateLike,
  IdentityLike,
  LogLike,
  PathLike,
  QuotaService,
} from './types.js'

export type * from './types.js'
export {
  QUOTA_SERVICE_KEY,
  NAME_RE,
  STATE_FILE_NAME,
  PROFILE_QUOTA,
  PLAN_GATES,
  HARD_DAILY_QUOTA,
  DEFAULT_MIN_INTERVAL_MINUTES,
  DEFAULT_GIVE_UP_RATE,
  RETREAT_AFTER_PROACTIVE,
  RETREAT_SILENT_DAYS,
  RETREAT_PER_DAY,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  PROFILE_VALUES,
  completeConfig,
} from './settings.js'
export {
  decide,
  drawOf,
  giveUpDrawOf,
  intervalOf,
  quotaFor,
  retreatOf,
  shouldGiveUp,
  silentDaysBetween,
} from './rules.js'
export type { DecideInput } from './rules.js'
export { STATE_VERSION, emptyState, normalizeState, readState, writeState } from './state.js'
export { ProactiveQuota } from './service.js'
export type { QuotaOptions } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-proactive-quota'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 向 O-005 注册配置段。
 *
 * 放进 `ctx.effect`：段是本插件的资源，卸载时必须一起撤。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 注册是否成功。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-proactive-quota: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 主动节律服务；未装载本插件时为 undefined。 */
    'ondra-proactive-quota'?: QuotaService
  }
}

/**
 * Cordis 入口：解析配置、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：`ondra-path-layout` / `ondra-proactive-gate` 缺席时，
 * 正确表现是「降级并告警」，而不是「整个插件停在 PENDING」——
 * 停在 PENDING 会让调用方拿不到 `plan()`，主动行为整块消失且没有原因码。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: QuotaConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('proactive-quota') : 'ondra.proactive-quota')

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
  }

  // 2. 补全 + 校验。任何非法值都回退默认，绝不抛。
  const settings = completeConfig(effective)

  // 3. 依赖全部用取值函数：上游晚装载时能自愈，早卸载时立刻反映。
  //    服务键都是 Cordis 的字符串重载，类型声明在别的包里，本插件不许 import（§18.5）。
  const quota = new ProactiveQuota({
    settings,
    log,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    path: () => ctx.get('ondra-path-layout') as PathLike | undefined,
    gate: () => ctx.get('ondra-proactive-gate') as GateLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(() => ctx.provide(QUOTA_SERVICE_KEY, quota), 'ondra-proactive-quota: 注册主动节律服务')

  // 4. 报一次现状。档位、额度、间隔、放弃率、落盘状态都要能被自检读到（§12.2）。
  const view = quota.quota()
  log.info(
    '主动节律就绪：档位 %s → %d 条/日（今日剩 %d）· 最小间隔 %d 分钟 · 放弃率 %d%% · 状态落盘 %s',
    settings.profile,
    view.base,
    view.remaining,
    settings.minIntervalMinutes,
    Math.round(settings.giveUpRate * 100),
    quota.stored ? '是' : '否（重启后重复开口）',
  )
  if (!settings.enable) {
    log.warn('主动节律已关闭（enable=false）：服务照常注册，plan() 一律 drop/disabled')
  }
  if (!NAME_RE.test(name)) {
    log.error('插件名不合规（%s）：服务键会被模型侧拒绝', name)
  }
  if (ctx.get('ondra-proactive-gate') === undefined) {
    log.warn(
      '主动门控（ondra-proactive-gate）未装载：拿不到「今天说了几句」，额度闸停用，只剩间隔与退场；且本插件不知道群聊红线',
    )
  }
  if (ctx.get('ondra-path-layout') === undefined) {
    log.warn('路径服务未装载：节律状态只在内存里，重启后间隔与退场计数清零')
  }
  if (ctx.get('ondra-clock') === undefined) {
    log.info('时间服务未装载：自然日键退回本机时区（跨时区部署时「退场句每天一条」可能差一天）')
  }
  if (settings.quotaOverride > 0) {
    log.info('高级模式生效：每日额度固定为 %d 条，档位 %s 不再起作用', settings.quotaOverride, settings.profile)
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: QuotaConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能被安全补全（非法值回退默认、数值夹紧），因此永远不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
