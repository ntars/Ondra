/**
 * O-113 `ondra-weekly`：周报骨架（〔薄〕，L9 扩展池）。
 *
 * ## 它到底做什么
 *
 * 把「这一周发生过什么」整理成**一份可读骨架**：分几段、每段写什么、
 * 哪些必须提、哪些可以省。四段是「留下的事 / 悬着的事 / 她自己写的 / 安静的地方」。
 *
 * ## 它刻意不做什么（五条）
 *
 * - **不出成稿。** 骨架交的是段名、段意、写作口径与素材片段；把它拼成一篇周记，
 *   是应用外壳与人格层的事。这里一句成句的话都不给——给了就等于插件决定了周报的口气。
 * - **不出分数、不评价。** 没有「本周幸福度」「关系升温 12%」。周报是最容易破
 *   「禁报数铁律」的地方，一旦有了分数，下一次就会有人为分数调人格参数。
 * - **不用 0 顶替缺失值。** 上游缺席时 `state` 是 `not-available`，不是 `0`。
 *   0 会被读成「这周她一句话都没记住」，而真相是「这个数这会儿读不出来」。
 * - **不发消息、不做界面、不装定时器。** 发消息归 O-042 的静默与额度；
 *   渲染归应用外壳（`desktop/`）；什么时候出报是人的选择，不是插件的时钟。
 * - **不做统计口径真源。** 每个数都标了取自哪个服务的哪个方法（`sources`），
 *   口径归上游。本插件连 `countFacts()` 都不用来算「本周」——它没有时间条件，
 *   拿它算本周会撒谎。
 *
 * ## 依赖纪律
 *
 * 六项依赖（时钟 / 身份 / 记忆 / 承诺 / 日记 / 配置）**全是软依赖**，故刻意不声明插件级 `inject`：
 * 缺哪项就少一段并在 `missing` 里点名，其余照常出骨架。
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
import type { Config as WeeklyConfig } from './settings.js'
import { Weekly } from './service.js'
import { messageOf } from './skeleton.js'
import { WEEKLY_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  DiaryLike,
  IdentityLike,
  LogLike,
  MemoryCoreLike,
  ProspectiveLike,
  WeeklyService,
} from './types.js'

export type * from './types.js'
export {
  WEEKLY_SERVICE_KEY,
  NAME_RE,
  DAY_MS,
  MIN_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  SECTION_IDS,
  SECTION_STATES,
  SECTION_SPECS,
  WEEKLY_ERROR_CODES,
  WeeklyError,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  CONFIG_SECTION,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  MIN_ITEMS,
  MAX_ITEMS,
  MIN_SCAN,
  MAX_SCAN,
  completeConfig,
} from './settings.js'
export { localDayKey, startOfLocalDay, spanOf, windowOf, withinRange, dayKeyInRange } from './window.js'
export {
  messageOf,
  snippetOf,
  sourceOf,
  countOf,
  momentSectionOf,
  promiseSectionOf,
  diarySectionOf,
  quietSectionOf,
  tallyOf,
  isQuiet,
  summaryOf,
  diaryRefsInRange,
} from './skeleton.js'
export type { DiaryMaterial, MomentsMaterial, PromiseMaterial } from './skeleton.js'
export { Weekly } from './service.js'
export type { WeeklyDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-weekly'

/**
 * 向 O-005 注册配置段。放进 `ctx.effect`：段是本插件的资源，卸载时必须一起撤。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 注册是否成功。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-weekly: 注册配置段')
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
    /** 周报骨架服务；未装载本插件时为 undefined。 */
    'ondra-weekly'?: WeeklyService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：六项依赖全软（见文件头）。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: WeeklyConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('weekly') : 'ondra.weekly')

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

  // 2. 补全。任何非法值都回退默认或夹到区间内，绝不抛。
  const settings = completeConfig(effective)

  // 3. 依赖全部用取值函数：上游晚装载时能自愈，早卸载时立刻反映。
  const weekly = new Weekly({
    settings,
    log,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    core: () => ctx.get('ondra-memory-core') as MemoryCoreLike | undefined,
    prospective: () => ctx.get('ondra-memory-prospective') as ProspectiveLike | undefined,
    diary: () => ctx.get('ondra-diary') as DiaryLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(() => ctx.provide(WEEKLY_SERVICE_KEY, weekly), 'ondra-weekly: 注册周报骨架服务')

  // 4. 报一次现状。可用性与依赖到位情况都要能被自检读到，不许黑箱。
  //    刻意**不在 apply 里出骨架**：装载期上游可能还没就绪，那时出报会得到一份全是「读不到」的骨架。
  log.info('周报骨架就绪：%s（只读投影，不出成稿）', weekly.available ? '可用' : `不可用（${weekly.reason ?? '未知'}）`)
  const absent: string[] = []
  if (ctx.get('ondra-clock') === undefined) absent.push('时钟（日界退回本机时区，窗口可能差一天）')
  if (ctx.get('ondra-memory-core') === undefined) absent.push('记忆（「这周留下的事」读不到）')
  if (ctx.get('ondra-memory-prospective') === undefined) absent.push('承诺（「这周悬着的事」读不到）')
  if (ctx.get('ondra-diary') === undefined) absent.push('日记（「她自己写的」读不到）')
  if (absent.length > 0) {
    log.info('以下上游未装载，对应段落会标 not-available 而不是「这周没有」：%s', absent.join('；'))
  }
  if (!settings.enable) {
    log.warn('周报骨架已关闭（enable=false）：服务照常注册，draft() 一律抛 disabled')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。五个字段都能安全补全，
 * 因此永远不产 issue——配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: WeeklyConfig } | { readonly issues: readonly { readonly message: string }[] }
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
