/**
 * O-135 `ondra-narrative-log`：回复决策解释。
 *
 * ## 它回答的问题
 *
 * 「她为什么这么回？」——不是问她，是问日志。所以她看不见这份记录。
 *
 * ```
 * 择档 / 情绪 / 九步过滤 / 证据门控 …（各自判断）
 *      └→ record({turnId, chosen, factors, gates, refs, excerpt})
 *            └→ 面板 / 审计：recent() · explain(turnId) · read(dayKey)
 * ```
 *
 * ## 明确不做
 *
 * - **不进提示词**：没有 `prompt()` / `inject()` 出口。这份记录天然带计数
 *   （「拦了 2 处」），拼进上下文会直接撞上禁止报数铁律，也会让「解释自己」
 *   变成一种表演。
 * - **不推断理由**：因子由上游交进来，本包不知道 `emotion.tension` 的语义，
 *   只负责收下、脱敏、截断、按权重排序、说成人话。自己推断就会写出
 *   没人说过的话。
 * - **不改不删**：对外只有 `record()` 一个写入口，文件以追加方式打开。
 *   审计日志一旦可改，就不再是审计。
 * - **不存正文全文**：只留她说出口那一小段（默认 60 字，可关）与结构化因子。
 *   用户原话、记忆正文、提示词一律不存。
 * - **不自动清理**：`retentionDays` 只在 `prune()` 被显式调用时生效，没有定时器。
 * - **不画界面**：日志视图、筛选、时间轴、折叠、Toast 全归应用外壳（`desktop/`），
 *   本包只交出 `recent()` / `explain()` / `read()` 的数据。
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
import type { Config as NarrativeConfig } from './settings.js'
import { NarrativeLog } from './service.js'
import { LOG_DIR } from './store.js'
import { NARRATIVE_LOG_SERVICE_KEY, NAME_RE } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  NarrativeLogService,
  PathLike,
} from './types.js'

export type * from './types.js'
export {
  NARRATIVE_LOG_SERVICE_KEY,
  NAME_RE,
  TRACE_VERSION,
  GATE_VERDICTS,
  VERDICT_ZH,
  TRACE_REASONS,
  TRACE_REASON_ZH,
} from './types.js'
export {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  completeConfig,
} from './settings.js'
export {
  charsOf,
  clipText,
  explainOf,
  maskSensitive,
  normalizeFactor,
  normalizeGate,
  normalizeTrace,
  sortFactors,
  squeeze,
} from './trace.js'
export type { NormalizeOptions, TraceLimits } from './trace.js'
export { LOG_DIR, appendEntry, dayFileName, listDays, pruneDays, readDay, reviveEntry } from './store.js'
export { NarrativeLog } from './service.js'
export type { NarrativeLogOptions } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-narrative-log'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-narrative-log: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 决策日志服务；未装载本插件时为 undefined。 */
    'ondra-narrative-log'?: NarrativeLogService
  }
}

/**
 * Cordis 入口：解析配置、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：`ondra-path-layout` 缺席时正确表现是
 * 「只在内存环里记并告警」，而不是「整个插件停在 PENDING」——
 * 停在 PENDING 会让所有上游的 `record()` 变成 `undefined` 调用。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: NarrativeConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('narrative-log') : 'ondra.narrative-log')

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
          log.warn('配置有 %d 个字段校验失败，已逐个回退默认值', resolved.fallbackCount)
        }
      }
    } catch (error) {
      log.warn('解析配置段失败，退回插件实例配置：%s', messageOf(error))
    }
  }

  // 2. 补全 + 夹紧。任何非法值都回退默认，绝不抛。
  const settings = completeConfig(effective)

  // 3. 依赖全部用取值函数：上游晚装载时能自愈，早卸载时立刻反映。
  //    服务键都是 Cordis 的字符串重载，类型声明在别的包里，本插件不许 import（§15.5）。
  const narrative = new NarrativeLog({
    settings,
    log,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    path: () => ctx.get('ondra-path-layout') as PathLike | undefined,
    now: () => {
      const clock = ctx.get('ondra-clock') as ClockLike | undefined
      return clock === undefined ? Date.now() : clock.now()
    },
  })

  ctx.effect(() => ctx.provide(NARRATIVE_LOG_SERVICE_KEY, narrative), 'ondra-narrative-log: 注册决策日志服务')

  // 4. 报一次现状。上限、保留期、脱敏、落盘都要能被自检读到（§12.2）。
  const view = narrative.stats()
  log.info(
    '决策日志就绪：内存环 %d 条 · 保留 %d 天（只由 prune() 触发）· 脱敏 %s · 摘录 %s · 落盘 %s',
    view.capacity,
    settings.retentionDays,
    settings.maskSensitive ? '开' : '关',
    settings.storeExcerpt ? `留 ${settings.maxExcerptChars} 字` : '不存',
    view.stored ? `是（${view.dir === '' ? LOG_DIR : view.dir}）` : '否（只在内存环里）',
  )
  if (!settings.enable) {
    log.warn('决策日志已关闭（enable=false）：服务照常注册，record() 一律返回 disabled')
  }
  if (!NAME_RE.test(name)) {
    log.error('插件名不合规（%s）：服务键会被模型侧拒绝', name)
  }
  if (ctx.get('ondra-path-layout') === undefined) {
    log.warn('路径服务未装载：决策日志只在内存环里，重启即丢（record() 返回 no-store）')
  }
  if (ctx.get('ondra-clock') === undefined) {
    log.info('时间服务未装载：日期分片退回本机时区（跨时区部署时「当天」可能差一天）')
  }
  if (!settings.storeExcerpt) {
    log.info('已关闭摘录：只记结构化因子，追查时看不到「她当时到底说了什么」')
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
    ) => { readonly value: NarrativeConfig } | { readonly issues: readonly { readonly message: string }[] }
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
