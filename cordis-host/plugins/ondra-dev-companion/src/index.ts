/**
 * O-110 `ondra-dev-companion`：开发者陪伴（〔研〕自研，L9 扩展池）。
 *
 * ## 它到底做什么
 *
 * 回答一句话：**「主人正卡在一件事上，她该不该出声？出声说什么？」**
 *
 * 外壳报四个事实——编译挂了、测试绿了、长任务跑完了、提交了——它决定
 * **该不该开口**，以及允许开口时给一句不含数字的话。
 *
 * ## 为什么这一块是〔研〕
 *
 * 现有的开发陪伴工具（番茄钟、CI 通知、编辑器鼓励插件）几乎全是
 * 「事件到了就响」。而这里最要紧的恰好相反：**事件到了先想该不该响**。
 * 每个调门背后都是一条可被单独检查的判据，不是一句鼓励语。
 *
 * ## 它刻意不做什么（五条）
 *
 * - **不读代码、不读 diff、不点评实现。** 本包没有 `readFileSync`，只有写台账那一处 `fs`。
 * - **不报任何数字。** `DevCue` 里连一个数字字段都没有。
 * - **不装定时器。** 安静期靠时刻比较，不靠 `setTimeout`。
 * - **不直接发消息。** `cue()` 只产出文本，发不发归 O-042 六道闸。
 * - **不做界面。** L8 界面插件已整批下线，渲染归应用外壳（`desktop/`）。
 *
 * ## 依赖纪律
 *
 * 五项全是**软依赖**（身份 / 时钟 / 路径 / 配置 / 在场），故不声明插件级 `inject`。
 * 尤其**不把 O-109 写成硬依赖**：没装感知插件时它照常能说话，
 * 只是少了「开会时闭嘴」这一层门。
 */

import type { Context } from '@ntars/cordis'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as DevCompanionConfig } from './settings.js'
import { DevCompanion } from './service.js'
import { DEV_COMPANION_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  DevCompanionService,
  IdentityLike,
  LogLike,
  PathLike,
  ScreenSenseLike,
} from './types.js'

export type * from './types.js'
export {
  DEV_COMPANION_SERVICE_KEY,
  NAME_RE,
  STATE_FILE_NAME,
  STATE_VERSION,
  DEV_EVENT_KINDS,
  DEV_TONES,
  DevError,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  CONFIG_SECTION,
  QUIET_FLOOR,
  QUIET_CEILING,
  completeConfig,
  policyOf,
} from './settings.js'
export {
  RUN_RECENT_MS,
  emptyMemory,
  emptyLedger,
  normalizeLedger,
  normalizeKind,
  normalizeOutcome,
  readEvent,
  applyEvent,
  applyAck,
  presenceGate,
  decide,
  viewOf,
  SAY,
  MUST_NOT,
} from './rules.js'
export type { DevMemory, DevLedger } from './rules.js'
export { DevCompanion } from './service.js'
export type { DevCompanionDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-dev-companion'

/**
 * 本插件**不声明** `inject`：五项依赖全是软依赖，缺谁都能跑。
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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-dev-companion: 注册配置段')
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
    /** 开发者陪伴服务；未装载本插件时为 undefined。 */
    'ondra-dev-companion'?: DevCompanionService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: DevCompanionConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(
    identity ? identity.loggerName('dev-companion') : 'ondra.dev-companion',
  )

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

  // 3. 建服务。时钟 / 路径 / 在场都用取值函数：上游晚装载时能自愈。
  const service = new DevCompanion({
    settings,
    log,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    path: () => ctx.get('ondra-path-layout') as PathLike | undefined,
    screen: () => ctx.get('ondra-screen-sense') as ScreenSenseLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(
    () => ctx.provide(DEV_COMPANION_SERVICE_KEY, service),
    'ondra-dev-companion: 注册开发者陪伴服务',
  )

  // 4. 报一次现状。四道判据阈值必须能被自检读到，不许黑箱。
  log.info(
    '开发者陪伴就绪：%s（安静期 %ds / 连败 %d 次起劝放下 / 跨度 %dmin；在场门 %s）',
    service.available ? '可用' : '不可用',
    settings.quietAfterFailSec,
    settings.stuckFails,
    settings.stuckSpanMin,
    settings.respectPresence ? '开' : '关',
  )
  if (!settings.enable) {
    log.warn('开发者陪伴已关闭（enable=false）：服务照常注册，note() 抛 disabled')
  }
  if (ctx.get('ondra-screen-sense') === undefined) {
    log.info('未装载 O-109 屏幕感知：少了「开会 / 不在 / 读不到时闭嘴」这层门，其余照常')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。数值越界一律夹到区间内，
 * `cueCooldownMin` 长于 `celebrateCooldownMin` 会被压回去，因此永远不产 issue——
 * 配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: DevCompanionConfig }
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
