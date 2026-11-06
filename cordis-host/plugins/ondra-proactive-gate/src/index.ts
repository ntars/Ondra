/**
 * O-042 `ondra-proactive-gate`：主动消息的门控（〔薄〕）。
 *
 * ## 为什么是〔薄〕
 *
 * 手册 §1.8 把「心跳引擎」列在薄封装档：`dsh-proactive 改造 + 墓碑折叠`。
 * 本仓里没有 `dsh-proactive`，但有 `@ntars/ondra-schedule`——宿主级持久提醒、
 * 五种时间选择器、到期恢复冷会话、投递历史。**定时与投递归它**，
 * 本插件只做它没有的那半件事：**投递前问一句「现在真的该说吗」**。
 *
 * ## 六道闸从哪来
 *
 * 手册 §5.3 给了六条防封闸（实测 12 拦截 0 误伤），§5.5 又给了三道
 * （静默时段 / 每日预算 / `min_idle_seconds`）。九道合起来正好是
 * 「时机 / 话由 / 分寸」里的**时机与分寸**——话由归 O-043。
 *
 * ## 明确不做
 *
 * - **不排闹钟、不发送。** 那归 `dsh-schedule` 与通道层。
 * - **不生成内容。** 门控只看正文，不改正文。
 * - **不装定时器、不订阅事件。** 零常驻（§14.2）。
 * - **不做 `proactive_reclaim` 与墓碑折叠。** 那是会话上下文层的事
 *   （O-033 / O-036 的地盘）；本插件连 `session_log` 都不读。详见 README 已知限制。
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
import type { Config as GateConfig } from './settings.js'
import { ProactiveGate } from './service.js'
import { GATE_SERVICE_KEY, NAME_RE } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  GateService,
  IdentityLike,
  LogLike,
  PathLike,
} from './types.js'

export type * from './types.js'
export {
  GATE_SERVICE_KEY,
  NAME_RE,
  STATE_FILE_NAME,
  GATE_NAMES,
  HARD_PER_MINUTE,
  HARD_PER_HOUR,
  HARD_PER_DAY,
  HARD_DAILY_QUOTA,
  BACKOFF_SECONDS,
  RISK_CODES,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  completeConfig,
} from './settings.js'
export {
  formatHhmm,
  inWindow,
  minutesToMs,
  minutesToWindowEnd,
  parseHhmm,
  silentDaysOf,
} from './window.js'
export { BLOCK_PATTERNS, blockedHit, isEmptyText, normalizeForMatch, sameText } from './content.js'
export {
  bucketDeferMs,
  cooldownDeferMs,
  countWithin,
  findDuplicate,
  hourDeferMs,
  minuteDeferMs,
  trimConversations,
  trimRecords,
} from './bucket.js'
export { STATE_VERSION, compactState, emptyState, normalizeState, readState, writeState } from './state.js'
export { budgetOf, evaluate } from './gate.js'
export type { GateInput } from './gate.js'
export { ProactiveGate } from './service.js'
export type { GateOptions } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-proactive-gate'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-proactive-gate: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 主动门控服务；未装载本插件时为 undefined。 */
    'ondra-proactive-gate'?: GateService
  }
}

/**
 * Cordis 入口：解析配置、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：`ondra-path-layout` 缺席时正确表现是
 * 「状态只在内存里（并告警）」，而不是「整个插件停在 PENDING」——
 * 停在 PENDING 会让调用方拿不到 `gate()`，主动行为直接消失且没有原因码。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: GateConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('proactive-gate') : 'ondra.proactive-gate')

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
  const gate = new ProactiveGate({
    settings,
    log,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    path: () => ctx.get('ondra-path-layout') as PathLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(() => ctx.provide(GATE_SERVICE_KEY, gate), 'ondra-proactive-gate: 注册主动门控服务')

  // 4. 报一次现状。可用性、落盘状态、闸参数都要能被自检读到，不许黑箱（§12.2）。
  log.info(
    '主动门控就绪：额度 %d/日（静默 %s–%s，深夜 %s–%s）· 速率 %d/分 %d/时 %d/日 · 状态落盘 %s',
    settings.dailyQuota,
    settings.quietStart,
    settings.quietEnd,
    settings.antiBanQuietStart,
    settings.antiBanQuietEnd,
    settings.perMinute,
    settings.perHour,
    settings.perDay,
    gate.stored ? '是' : '否（重启清零）',
  )
  if (!settings.enable) {
    log.warn('主动门控已关闭（enable=false）：服务照常注册，gate() 一律 drop/disabled')
  }
  if (!NAME_RE.test(name)) {
    log.error('插件名不合规（%s）：服务键会被模型侧拒绝', name)
  }
  if (ctx.get('ondra-clock') === undefined) {
    log.info('时间服务未装载：静默时段与自然日退回本机时区（跨时区部署时可能差几小时）')
  }
  if (ctx.get('ondra-path-layout') === undefined) {
    log.warn('路径服务未装载：门控状态只在内存里，重启会清零（= 重启绕过防封）')
  }
  if (gate.stats().budget.quota === 0 && settings.dailyQuota > 0) {
    log.info('今日主动额度为 0：已连续沉默 ≥7 天（或额度配置为 0），按 §9.3 归零')
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
    ) => { readonly value: GateConfig } | { readonly issues: readonly { readonly message: string }[] }
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
