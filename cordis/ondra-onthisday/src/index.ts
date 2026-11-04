/**
 * O-049 `ondra-onthisday`：那年今日。
 *
 * ## 它做什么
 *
 * 手册 §2.6 八块装配的第 ④ 块是 `【那年今日】`，上限 3 条。本插件决定
 * 「今天该从记忆库里翻出哪三件旧事」——只决定，不拼字。
 *
 * ## 它刻意不做什么
 *
 * - **不拼注入行。** 「3 年前记下、提过 2 次」的措辞归 O-036 的 `formatLine()`。
 * - **不算清晰度。** 「记不太清了」的三档话术归 O-013 的 `clarityOfRecord()`。
 *   本插件只把 `clarity` 原样透传，让面板与注入看到同一个档位。
 * - **不在 21:05 自己开口。** 那是 ⑧ 固定回忆，归 O-018；本插件零定时器。
 * - **不写记忆。** 只在「真的带出去」时记「被提起」账（`markSeen` + `reinforce`）。
 *
 * ## 为什么没有定时器也不需要
 *
 * ④ 是**注入块**，跟着对话走，不是定时任务。装配链每轮问一次「今天有什么旧事」，
 * 本插件按自然日冻结一次答案，此后直接命中冻结点——扫库一天只发生一次。
 * 卸载即停，没有任何东西需要收尾（`ctx.effect` 只管服务注册）。
 */

import type { Context } from '@ntars/cordis'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as OnThisDayConfig } from './settings.js'
import { OnThisDay } from './service.js'
import { NAME_RE, ONTHISDAY_SERVICE_KEY, STATE_FILE } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  DecayLike,
  GraphLike,
  IdentityLike,
  LogLike,
  MemoryCoreLike,
  OnThisDayService,
  PathLike,
} from './types.js'

export type * from './types.js'
export {
  ONTHISDAY_SERVICE_KEY,
  NAME_RE,
  STATE_FILE,
  STATE_VERSION,
  SHELVES,
  SHELF_ZH,
  SHELF_ORDER,
  CAP_MAX,
  PAGE_SIZE_MAX,
  SCAN_LIMIT_MAX,
  YEAR_DAY,
  MONTH_DAY_SPAN,
  LEAP_FOLD_TARGET,
  GRAPH_DEDUPE_WEIGHT,
  GRAPH_DEDUPE_WINDOW,
  TEXT_KEY_CHARS,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  CAP_MIN,
  PAGE_SIZE_MIN,
  SCAN_LIMIT_MIN,
  completeConfig,
  configDriftOf,
} from './settings.js'
export {
  DAY_KEY_RE,
  dayKeyAt,
  dayKeyOf,
  dayNumberOf,
  daysInMonth,
  elapsedMs,
  isLeapYear,
  isValidDate,
  matchShelf,
  parseDayKey,
  partsAt,
} from './calendar.js'
export { compareCandidate, scan, select, textKeyOf } from './pick.js'
export type { Candidate, ScanInput, ScanOutput, SelectInput, SelectOutput } from './pick.js'
export { ACCOUNTED_MAX, emptyState, isFrozenFor, normalizeState, readState, writeState } from './store.js'
export type { FrozenItem, OnThisDayState } from './store.js'
export { OnThisDay } from './service.js'
export type { OnThisDayDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-onthisday'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-onthisday: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

/**
 * 解析状态文件路径。
 *
 * 路径服务缺席时返回 `undefined`（纯内存模式），**绝不自己拼 `~/.ondra`**：
 * 数据根可以被 `$ONDRA_HOME` 改写，自己拼会写到另一处去，
 * 症状是「面板上有内容、重启后没了」。
 * @param path 路径服务（调用方已判空）。
 * @param log 日志。
 */
function stateFileOf(path: PathLike, log: LogLike): string | undefined {
  try {
    const file = path.fileIn('user', STATE_FILE)
    // 顺手把权限收到 0600：这个文件里有「她今天想起了哪几件事」，
    // 属于隐私边缘——不含正文，但含 id 与日期，足够拼出时间线。
    try {
      path.prepareFile(file)
    } catch (error) {
      log.warn('状态文件权限没能收紧（继续用现有权限）：%s', messageOf(error))
    }
    return file
  } catch (error) {
    log.warn('拼不出状态文件路径（改走纯内存）：%s', messageOf(error))
    return undefined
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 那年今日服务；未装载本插件时为 undefined。 */
    'ondra-onthisday'?: OnThisDayService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: OnThisDayConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('onthisday') : 'ondra.onthisday')

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

  // 2. 补全 + 校验。任何非法值都回退默认，绝不抛。
  const settings = completeConfig(effective)

  // 3. 五个依赖，全部软：缺席时服务照常注册，面板能说清缺谁。
  const clock = ctx.get('ondra-clock') as ClockLike | undefined
  const core = ctx.get('ondra-memory-core') as MemoryCoreLike | undefined
  const decay = ctx.get('ondra-memory-decay') as DecayLike | undefined
  const graph = ctx.get('ondra-memory-graph') as GraphLike | undefined
  const path = ctx.get('ondra-path-layout') as PathLike | undefined

  // 判空写在调用点，而不是藏进 `stateFileOf()` 里：
  // 自检要能一眼看出「每个 ctx.get 之后都有 undefined 判断」。
  const file = path === undefined ? undefined : stateFileOf(path, log)

  const service = new OnThisDay({
    settings,
    log,
    clock,
    core,
    decay,
    graph,
    file,
  })

  ctx.effect(() => ctx.provide(ONTHISDAY_SERVICE_KEY, service), 'ondra-onthisday: 注册那年今日服务')

  // 4. 报一次现状：能不能用、缺什么、上限多少。没有定时器，
  //    所以这行日志就是「装载成功」的唯一凭据。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值越界已回退（%s）：条数与扫描上限可能因此不是你设的数', drift.join(' / '))
  }

  const reason = service.reason
  if (reason !== undefined) {
    log.warn('那年今日不可用（%s）：服务已注册，today() 会如实返回原因', reason)
    // 三种不可用的处理方式不同，说清楚是哪一种：关掉是主人的选择，缺内核是装配问题。
    if (core === undefined) {
      log.warn('记忆内核未装载：那年今日没有取材来源（其余八块不受影响）')
    }
  } else {
    // **装载期刻意不算一次。** 此刻记忆库可能还没开好（或退回了空的内存兜底），
    // 算出来的「今天没有旧事」会被冻结点固定一整天，而日志里一切正常。
    // 第一次被问的时候再算——那时代价已经付过（宿主首屏已过）。
    log.info(
      '那年今日就绪：上限 %d 条 · 扫描上限 %d 条 · 三档 %s · 状态 %s · 首次被问时才计算',
      settings.cap,
      settings.scanLimit,
      [settings.shelfAnniversary ? '周年' : null, settings.shelfYearDay ? '整年' : null, settings.shelfMonthDay ? '整月' : null]
        .filter((item): item is string => item !== null)
        .join('/') || '全关',
      file === undefined ? '仅内存（重启后当天重算）' : 'user/' + STATE_FILE,
    )
  }

  if (clock === undefined) {
    log.warn('时间服务未装载：「今天」按本机时区判定，跨时区配置的地区会差一天')
  }
  if (decay === undefined) {
    log.info('衰减服务未装载：不带清晰度话术（条目本身照常给出）')
  }
  if (graph === undefined) {
    log.info('图谱未装载：只做字面去重（同一件事的不同措辞可能各占一条）')
  }
  if (path === undefined) {
    log.warn('路径服务未装载：状态只在内存，重启后当天会重算')
  }
  if (!settings.enable) {
    log.warn('那年今日已关闭（enable=false）：服务照常注册，today() 一律 disabled')
  }
  if (!NAME_RE.test(name)) {
    log.error('插件名不合规（%s）：服务键会被模型侧拒绝', name)
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
    ) =>
      | { readonly value: OnThisDayConfig }
      | { readonly issues: readonly { readonly message: string }[] }
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
