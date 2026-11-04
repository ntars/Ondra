/**
 * O-101 `ondra-time-capsule`：时间胶囊（〔研〕自研，L9 扩展池）。
 *
 * ## 它到底做什么
 *
 * 让人**写一封给未来某一天的信**，封存期内一个字都读不到，到那天由人亲手拆开，
 * 拆开时把正文交进记忆库（O-010），此后它就是一条普通记忆。
 *
 * ## 它刻意不做什么（五条）
 *
 * - **不做「短期提醒」。** `MIN_HOLD_DAYS = 7` 是常量不是配置项：
 *   7 天以内的事归 O-021 `ondra-memory-prospective`（它的时间词最远是「下周」≈7 天）。
 *   两套机制时段不重叠，才不会出现「这条到底该谁提醒」。
 * - **不做到期自动开封。** 自动开封等于到期那一刻正文就进了上下文——
 *   邮箱推送、摘要生成、检索命中，用户还没自己看，秘密已经散出去了。
 * - **不给「提前开封」的口子。** 有那个口子，胶囊就退化成一条加了两步操作的便签。
 * - **不做第二份正文。** 未开封时正文只有本地这一份；开封成功后本地立即置空，
 *   真源搬到 O-010。存两份就意味着用户点「忘记」时有一份不会跟着消失。
 * - **不做推送提醒、不做渲染。** 提醒归主动域（O-042~O-049），
 *   清单怎么画归应用外壳——L8 界面插件已整批下线，插件只交结构化数据。
 *
 * ## 依赖纪律
 *
 * 四项依赖**全是软依赖**，故刻意不声明插件级 `inject`：
 * 缺路径 → 只在内存；缺时钟 → 退回本机时区（同一个自然日定义）；
 * 缺记忆内核 → 胶囊能写能看，但「开封」会明确失败并保住正文。
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
import type { Config as CapsuleConfig } from './settings.js'
import { TimeCapsule } from './service.js'
import { MIN_HOLD_DAYS, TIME_CAPSULE_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  MemoryCoreLike,
  PathLike,
  TimeCapsuleService,
} from './types.js'

export type * from './types.js'
export {
  TIME_CAPSULE_SERVICE_KEY,
  CAPSULE_STATES,
  CAPSULE_ERROR_CODES,
  MIN_HOLD_DAYS,
  MAX_HOLD_DAYS,
  MIN_TEXT_CHARS,
  DEFAULT_MAX_TEXT_CHARS,
  MAX_TEXT_CHARS_CEILING,
  DEFAULT_MAX_CAPSULES,
  MAX_CAPSULES_CEILING,
  MAX_TITLE_CHARS,
  STATE_VERSION,
  STATE_FILE,
  CAPSULE_ID_RE,
  CapsuleError,
} from './types.js'
export { CONFIG_SECTION_ID, DEFAULT_CONFIG, FIELD_SPECS, SECTION_KEYS, CONFIG_SECTION, completeConfig } from './settings.js'
export {
  calendarOf,
  localDayKey,
  localDayNumber,
  localStartOfDay,
  openAtAfterDays,
  isDue,
  daysLeft,
} from './calendar.js'
export type { Calendar } from './calendar.js'
export {
  normalizeText,
  charCount,
  deriveTitle,
  makeId,
  stateOf,
  viewOf,
  sortForList,
  checkText,
  checkHoldDays,
} from './capsule.js'
export { emptyArchive, normalizeArchive, readArchive, writeArchive } from './store.js'
export type { LoadResult } from './store.js'
export { TimeCapsule } from './service.js'
export type { TimeCapsuleDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-time-capsule'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-time-capsule: 注册配置段')
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
    /** 时间胶囊服务；未装载本插件时为 undefined。 */
    'ondra-time-capsule'?: TimeCapsuleService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：四项依赖全软（见文件头）。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: CapsuleConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('time-capsule') : 'ondra.time-capsule')

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

  // 2. 补全。任何非法值都回退默认，绝不抛。
  const settings = completeConfig(effective)

  // 3. 依赖全部用取值函数：上游晚装载时能自愈，早卸载时立刻反映。
  const capsule = new TimeCapsule({
    settings,
    log,
    path: () => ctx.get('ondra-path-layout') as PathLike | undefined,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    core: () => ctx.get('ondra-memory-core') as MemoryCoreLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(() => ctx.provide(TIME_CAPSULE_SERVICE_KEY, capsule), 'ondra-time-capsule: 注册时间胶囊服务')

  // 4. 报一次现状。可用性与依赖到位情况都要能被自检读到，不许黑箱。
  //    刻意**不在 apply 里扫存档**：装载期做磁盘 IO 会拖慢启动，且那时上游可能还没就绪。
  log.info('时间胶囊就绪：%s（按自然日封存，最少 %d 天）', capsule.available ? '可用' : `不可用（${capsule.reason ?? '未知'}）`, MIN_HOLD_DAYS)
  if (ctx.get('ondra-path-layout') === undefined) {
    log.info('路径服务未装载：胶囊只在内存，重启后未开封的信会丢')
  }
  if (ctx.get('ondra-clock') === undefined) {
    log.info('时钟服务未装载：自然日改按本机时区算（定义相同，仅夏令时极端情形可能差一天）')
  }
  if (ctx.get('ondra-memory-core') === undefined) {
    log.info('记忆服务未装载：胶囊能写能看，但到期开封会明确失败并保住正文')
  }
  if (!settings.enable) {
    log.warn('时间胶囊已关闭（enable=false）：服务照常注册，写操作一律拒绝，已有胶囊不会被删')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。四个字段都能安全补全，
 * 因此永远不产 issue——配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: CapsuleConfig } | { readonly issues: readonly { readonly message: string }[] }
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
