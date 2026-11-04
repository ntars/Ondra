/**
 * O-111 `ondra-ambient`：键鼠反应（〔薄〕薄封装，L9 扩展池）。
 *
 * ## 它到底做什么
 *
 * 把「主人此刻在不在、手是不是在动」翻译成**最低限度的存在感**：
 * `quiet`（别打扰）/ `near`（在，但不用说话）/ `ready`（可以接一句）。
 *
 * ## 为什么是「薄」而不是「研」
 *
 * 按 §3.8，输入监听属**复用档**，但复用的前提是「有东西可复用」，而这一层的现实是：
 *
 * - 真实键鼠监听要 macOS 辅助功能授权，一旦给出就收不回来；
 * - 它是**常驻监听**，属于应用外壳（`desktop/`），不属于一个可热插拔的 Cordis 插件；
 * - 生态里的成熟实现（ActivityWatch 等）是独立常驻进程 + 本地数据库，
 *   与本项目「插件只做接线与护栏」的形态冲突。
 *
 * 所以本插件既不复用也不自研「听见键鼠」，只承接**外壳喂进来的三类事件**：
 * 节流、密度判定、静默判定、三态裁决、以及「什么不能说」。这就是薄封装该有的样子。
 *
 * ## 它刻意不做什么（五条）
 *
 * - **不监听真实键鼠。** 需要授权，且是常驻任务；归应用外壳。
 * - **不接收任何内容。** 事件里只有 `key` / `mouse` / `idle` 与时刻，
 *   没有键值、没有坐标、没有窗口名、没有应用名。
 * - **不存按键明细。** 存档只有三个计数与两个时刻。存了间隔序列，
 *   击键动力学就足以反推内容。
 * - **不装定时器。** 推进由外壳的 `tick` 或下一次事件驱动；
 *   自己挂 `setInterval` 就成了常驻后台任务。
 * - **不做界面。** L8 界面插件已整批下线，渲染归应用外壳（`desktop/`）。
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
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as AmbientConfig } from './settings.js'
import { Ambient } from './service.js'
import { AMBIENT_SERVICE_KEY, AMBIENT_STATES } from './types.js'
import type {
  AmbientService,
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  PathLike,
} from './types.js'

export type * from './types.js'
export {
  AMBIENT_SERVICE_KEY,
  NAME_RE,
  STATE_FILE_NAME,
  STATE_VERSION,
  AMBIENT_EVENT_TYPES,
  AMBIENT_STATES,
  STATE_ZH,
  AmbientError,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  CONFIG_SECTION,
  BUSY_FLOOR,
  BUSY_CEILING,
  EVENT_FLOOR_MS,
  completeConfig,
  policyOf,
} from './settings.js'
export {
  MAX_STAMPS,
  DENSITY_WINDOW_MS,
  SETTLE_HYSTERESIS_MS,
  emptyRecord,
  emptyMemory,
  normalizeRecord,
  normalizeEventType,
  readEvent,
  stampsWithin,
  isBusy,
  wasBusyBefore,
  acceptEvent,
  decideOf,
  snapshotOf,
  reactionOf,
  nudgeOf,
  MUST_NOT,
} from './react.js'
export type { AmbientRecord, AmbientMemory, AcceptResult, Decision, NudgeQuota } from './react.js'
export { Ambient } from './service.js'
export type { AmbientDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-ambient'

/**
 * 本插件**不声明** `inject`：四项依赖全是软依赖，缺谁都能跑。
 *
 * 写在这里是给未来的自己看的：键鼠反应最容易顺手接上「刚停下来就说一句」，
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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-ambient: 注册配置段')
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
    /** 键鼠反应服务；未装载本插件时为 undefined。 */
    'ondra-ambient'?: AmbientService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: AmbientConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('ambient') : 'ondra.ambient')
  if (identity === undefined) {
    // 不静默：命名空间降级说一句，否则日志里会出现一个没人认领的前缀。
    log.warn('未装载 ondra-identity，日志命名空间退回 ondra.ambient')
  }

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

  // 3. 建服务。时钟 / 路径都用取值函数：上游晚装载时能自愈。
  const service = new Ambient({
    settings,
    log,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    path: () => ctx.get('ondra-path-layout') as PathLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(
    () => ctx.provide(AMBIENT_SERVICE_KEY, service),
    'ondra-ambient: 注册键鼠反应服务',
  )

  // 4. 报一次现状。三道阈值必须能被自检读到，不许黑箱。
  log.info(
    '键鼠反应就绪：%s（密度 %d 次/分 / 停稳 %ds / 可接话窗 %ds / 静默 %ds；%d 态，只有「刚停下来」才建议开口）',
    service.available ? '可用' : '不可用',
    settings.busyPerMin,
    settings.settleSec,
    settings.readyWindowSec,
    settings.idleSec,
    AMBIENT_STATES.length,
  )
  if (!settings.enable) {
    log.warn('键鼠反应已关闭（enable=false）：服务照常注册，observe() 抛 disabled，decide() 恒为 quiet')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。所有数值越界都会被夹到区间内，
 * `idleSec` 小于「停稳 + 可接话窗」会被抬回去，因此永远不产 issue——
 * 配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: AmbientConfig }
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
