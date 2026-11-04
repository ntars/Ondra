/**
 * O-116 `ondra-study`：学伴（〔薄〕薄封装，L9 扩展池）。
 *
 * ## 它到底做什么
 *
 * 陪人学习时的**节奏推进**：把「专注段 / 休息段」这条线维护住，回答两个问题——
 * 「这一段还在不在？」「要不要歇一下？」
 *
 * 推进只有两个入口：外部调 `tick(now)`，或低频调 `checkpoint()`。
 * **本插件没有任何一处自己数时间**：不装 `setInterval`、不装 `setTimeout`、
 * 不读文件时间戳推断「过了多久」。这看起来是最麻烦的做法，其实是唯一诚实的做法：
 * 常驻定时器在没人看着的时候照样加时长，于是「关掉窗口八小时、回来读今天学了八小时」，
 * 而那八小时里她一秒都没学。
 *
 * ## 它刻意不做什么（五条）
 *
 * - **不测评、不打分。** 没有正确率、没有得分、没有「今日学习分」。
 *   一旦有分数，就会有人为了让分数好看而让插件替她记时长。
 * - **不存学了什么。** 落盘只有时刻与毫秒数。`start(subject)` 收下科目名，
 *   然后**丢掉**——存它就等于存学习内容。
 * - **不强制休息。** 提示的 `declinable` 是字面量 `true`、`mandatory` 是字面量
 *   `false`，类型层面就没有「必须」这条分支。不锁屏、不弹窗、不打断。
 * - **不做界面。** L8 界面插件已整批下线，渲染归应用外壳（`desktop/`）。
 * - **不做打卡日历与连续天数。** 那是考勤。考勤第一天就开始撒谎（断一天就归零，
 *   于是人会为了不断而伪造），而学伴的第一职责是不撒谎。
 *
 * ## 依赖纪律
 *
 * 四项全是**软依赖**（时钟 / 身份 / 路径 / 配置真源），故不声明插件级 `inject`。
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
import type { Config as StudyConfig } from './settings.js'
import { Study } from './service.js'
import { STUDY_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  PathLike,
  StudyService,
} from './types.js'

export type * from './types.js'
export {
  STUDY_SERVICE_KEY,
  NAME_RE,
  STATE_FILE_NAME,
  STATE_VERSION,
  STUDY_PHASES,
  STUDY_EVENTS,
  PHASE_ORDER,
  REST_ACTIONS,
  StudyError,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  CONFIG_SECTION,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  completeConfig,
} from './settings.js'
export {
  emptyState,
  normalizeState,
  rollTo,
  beginFocus,
  advance,
  endFocus,
  markRest,
  judgeRest,
  derivePhase,
  minutesOf,
  noteOf,
  snapshotOf,
} from './session.js'
export type { StudyState, AdvanceResult, EndResult } from './session.js'
export { readState, writeState } from './store.js'
export type { LoadResult } from './store.js'
export { Study } from './service.js'
export type { StudyDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-study'

/**
 * 本插件**不声明** `inject`：四项依赖全是软依赖，缺谁都能跑。
 *
 * 写在这里是给未来的自己看的：学伴最容易被顺手接上三条线——键鼠活动（判断在不在学）、
 * 屏幕感知（判断在学什么）、主动消息（催她回来学）。三条都不该接：
 * 前两条都要系统授权且默认关闭，第三条归 O-042 的六道闸。
 * 一旦成了硬依赖，关掉它们就等于把学伴也一起关掉。
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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-study: 注册配置段')
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
    /** 学伴服务；未装载本插件时为 undefined。 */
    'ondra-study'?: StudyService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: StudyConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('study') : 'ondra.study')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  // 1. 有 O-005 就让配置走四层合并（出问题时能说出「哪一层的哪个字段」）。
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  if (schema === undefined) {
    // 降级必须看得见：没有配置真源时，主人改了配置也不会出现「哪一层被覆盖」的解释。
    log.info('配置真源未装载：按插件实例配置与 FIELD_SPECS 默认值运行')
  } else if (registerSection(ctx, schema, log)) {
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

  // 3. 建服务。时钟与路径都用取值函数：上游晚装载时能自愈，早卸载时立刻退回降级。
  const service = new Study({
    settings,
    log,
    path: () => ctx.get('ondra-path-layout') as PathLike | undefined,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(() => ctx.provide(STUDY_SERVICE_KEY, service), 'ondra-study: 注册学伴服务')

  // 4. 报一次现状。阈值必须能被自检读到，不许黑箱。
  log.info(
    '学伴就绪：%s（间隔门槛 %d 分钟，连续 %d 分钟允许提一句休息，休息段 %d 分钟；不装定时器、不强制）',
    service.available ? '可用' : '不可用（enable=false）',
    settings.gapLimitMinutes,
    settings.restAfterMinutes,
    settings.restMinutes,
  )
  if (ctx.get('ondra-path-layout') === undefined) {
    log.info('路径服务未装载：学伴只在内存，重启后今日累计会清零')
  }
  if (ctx.get('ondra-clock') === undefined) {
    log.info('时钟服务未装载：自然日改按本机时区算（口径相同，仅夏令时极端情形差一天）')
  }
  if (!settings.enable) {
    log.warn('学伴已关闭（enable=false）：服务照常注册，写操作抛 disabled，snapshot() 照常可读')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。五个字段都能安全补全
 * （数字夹到区间内、布尔非真即假），因此永远不产 issue——配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: StudyConfig } | { readonly issues: readonly { readonly message: string }[] }
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
