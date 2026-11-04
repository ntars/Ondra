/**
 * O-109 `ondra-screen-sense`：屏幕感知（〔薄〕薄封装，L9 扩展池）。
 *
 * ## 它到底做什么
 *
 * 回答一句话：**「她大概知道主人正在跟什么东西打交道吗？」**
 *
 * 只到**类目**这一级（写代码 / 写东西 / 看东西 / 开会 / 看片 / 翻网页 / 玩游戏 /
 * 没在动 / 读不到），且只在能把类目说准的时候才说。
 *
 * ## 为什么是「薄」而不是「研」
 *
 * 按 §3.8，视觉与 OCR 属**复用档**。但复用的前提是「有东西可复用」：
 *
 * - O-126 `ondra-vision` 的输入是**图片地址**，也就是画面得先落成文件再发出去；
 * - 截屏需要系统权限与原生模块，属于应用外壳，不属于 Cordis 插件。
 *
 * 所以本插件既不复用也不自研「看见」这件事，只承接**已经被归好类的枚举**：
 * 节流、抖动吸收、在场判定、以及「什么不能说」。这就是薄封装的应有形态——
 * 包一层适配与护栏，不重写机制。
 *
 * ## 它刻意不做什么（五条）
 *
 * - **不截屏、不 OCR、不录屏。** 一个陪伴插件没有理由拥有读屏权限。
 * - **不存标题 / 应用名 / 文件路径 / 网址。** 存档只有时刻与计数。
 * - **不自己算时长。** 连续使用分钟数读 O-105 的快照，避免第二个真源。
 * - **不装定时器。** 采样节奏属于外壳；自己挂 `setInterval` 就成了常驻后台任务。
 * - **不做界面。** L8 界面插件已整批下线，渲染归应用外壳（`desktop/`）。
 *
 * ## 依赖纪律
 *
 * 五项全是**软依赖**（身份 / 时钟 / 路径 / 配置 / 健康），故不声明插件级 `inject`。
 * 任一缺席都能跑，只是降级——降级处各有一行日志，不静默。
 */

import type { Context } from '@ntars/cordis'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as ScreenSenseConfig } from './settings.js'
import { ScreenSense } from './service.js'
import { SCREEN_CATEGORIES, SCREEN_SENSE_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  HealthLike,
  IdentityLike,
  LogLike,
  PathLike,
  ScreenSenseService,
} from './types.js'

export type * from './types.js'
export {
  SCREEN_SENSE_SERVICE_KEY,
  NAME_RE,
  STATE_FILE_NAME,
  STATE_VERSION,
  SCREEN_CATEGORIES,
  CATEGORY_ZH,
  PRESENCE_STATES,
  ScreenError,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  CONFIG_SECTION,
  INTERVAL_FLOOR,
  INTERVAL_CEILING,
  completeConfig,
  policyOf,
} from './settings.js'
export {
  MAX_HANDOVERS,
  emptyState,
  normalizeState,
  normalizeCategory,
  normalizeStamps,
  readSignal,
  advance,
  handoversWithin,
  presenceOf,
  viewOf,
  hintOf,
  LINES,
  MUST_NOT,
} from './classify.js'
export type { ScreenState, AdvanceResult } from './classify.js'
export { ScreenSense } from './service.js'
export type { ScreenSenseDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-screen-sense'

/**
 * 本插件**不声明** `inject`：五项依赖全是软依赖，缺谁都能跑。
 *
 * 写在这里是给未来的自己看的：屏幕感知最容易顺手接上「主动说一句」，
 * 接上之后它就多了一条能自己开口的路径，而那条路径不经过 O-042 的六道闸。
 */

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 判断是否是普通对象（配置行可能为空）。 */
function isObjectLike(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object'
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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-screen-sense: 注册配置段')
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
    /** 屏幕感知服务；未装载本插件时为 undefined。 */
    'ondra-screen-sense'?: ScreenSenseService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: ScreenSenseConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('screen-sense') : 'ondra.screen-sense')

  const raw: unknown = isObjectLike(config) ? config : {}
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

  // 3. 建服务。时钟 / 路径 / 健康都用取值函数：上游晚装载时能自愈。
  const service = new ScreenSense({
    settings,
    log,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    path: () => ctx.get('ondra-path-layout') as PathLike | undefined,
    health: () => ctx.get('ondra-digital-health') as HealthLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(
    () => ctx.provide(SCREEN_SENSE_SERVICE_KEY, service),
    'ondra-screen-sense: 注册屏幕感知服务',
  )

  // 4. 报一次现状。四道阈值必须能被自检读到，不许黑箱。
  log.info(
    '屏幕感知就绪：%s（采样 %ds / 抖动窗 %ds / 专注 %dmin / 离开 %dmin；%d 类目，只有「在做一件事」才出声）',
    service.available ? '可用' : '不可用',
    settings.minIntervalSec,
    settings.stabilitySec,
    settings.focusMin,
    settings.idleMin,
    SCREEN_CATEGORIES.length,
  )
  if (!settings.enable) {
    log.warn('屏幕感知已关闭（enable=false）：服务照常注册，note() 抛 disabled，view() 恒为 unknown')
  }
  if (!settings.followSession) {
    log.warn('已关闭 followSession：不再读 O-105 的时长，sessionMinutes 恒为 null')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。所有数值越界都会被夹到区间内，
 * `idleMin` 小于 `focusMin` 会被向下压回去，因此永远不产 issue——
 * 配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: ScreenSenseConfig }
      | { readonly issues: readonly { readonly message: string }[] }
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
