/**
 * O-038 `ondra-rhythm`：分条与停顿的纯函数（〔研〕自研）。
 *
 * ## 为什么必须自研
 *
 * 手册 §1.8 把「节奏参数（已实现 272 行纯函数）」列为旧项目可直接复用的资产，
 * 而 §1.9 的待迁清单里没有它——它属于**已经跑通过、但生态里没有对应实现**的那一类。
 * 社区里的「打字机效果」都是前端动画（一个字一个字显示），与这里要做的
 * 「分几条发、每条之间等多久、深夜要不要更慢」是两件事：前者是渲染，
 * 后者是**行为**。故〔研〕。
 *
 * ## 手册给了什么、没给什么
 *
 * 给了全部**参数**（§9.2 + §3.3 第 396 行）：4 条 / 40 字 / 6 字每秒 /
 * 标点 300·500·150 / 300–6000ms / 深夜 1.6（23:00–06:00）/ 首字 800–2000 /
 * 长停顿 0.20 × 3000–9000、整轮一次 / 自我修正 0.05、3 句模板、默认不插入 /
 * 超限保留前 3 条 + 尾部合并成第 4 条。
 *
 * **没给算法**：怎么切句、超长句怎么拆、合并后超 40 字怎么办、长停顿插在哪。
 * 这四件事在本插件里全部自定，逐条登记 README「待裁决」。
 *
 * ## 明确不做
 *
 * - **不计时、不发消息**：那是 O-039 `ondra-rhythm-typing`。本插件连
 *   `setTimeout` 都不 import——纯函数才可能被预览与调试逐字复现。
 * - **不判情绪**：六态归 O-031，本插件只消费 `rhythm()` 的三项。
 * - **不改正文**：分条只切、不删、不改写。删与改写归 O-037。
 * - **不做呼吸感**：「（伸了个懒腰）」单日 ≤2 次归 O-041。
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
import type { Config as RhythmConfig } from './settings.js'
import { Rhythm } from './service.js'
import { NAME_RE, RHYTHM_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  ExpressLike,
  IdentityLike,
  LogLike,
  RhythmService,
} from './types.js'

export type * from './types.js'
export { RHYTHM_SERVICE_KEY, NAME_RE, HARD_MAX_MESSAGES, PUNCT_SPECS } from './types.js'
export { CONFIG_SECTION_ID, parseHhmm } from './settings.js'
export { countChars, splitSentences, splitLong, packMessages, capMessages } from './text.js'
export { extraPauseMs, clampMs, inWindow, typingDelay } from './delay.js'
export { Rhythm } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-rhythm'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-rhythm: 注册配置段')
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
    /** 节奏服务；未装载本插件时为 undefined。 */
    'ondra-rhythm'?: RhythmService
  }
}

/**
 * Cordis 入口：解析配置、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：本插件对上游是「可选增强」——
 * 没有 O-031 就用默认语速与句形，没有 O-003 就本地算深夜。
 * 写进 `inject` 反而会让「上游缺席」变成「整个插件不加载」。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: RhythmConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('rhythm') : 'ondra.rhythm')

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
  const rhythm = new Rhythm({
    settings,
    log,
    express: () => ctx.get('ondra-emotion-express') as ExpressLike | undefined,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(() => ctx.provide(RHYTHM_SERVICE_KEY, rhythm), 'ondra-rhythm: 注册节奏服务')

  // 4. 报一次现状。可用性与依赖到位情况都要能被自检读到，不许黑箱（§12.2）。
  log.info(
    '节奏就绪：≤%d 条 / 每条 ≤%d 字 / %d 字每秒；停顿 %d–%dms（深夜 %s×%s）；首字 %d–%dms；长停顿 %s%% × %d–%dms（整轮一次）；自我修正 %s',
    settings.maxMessages,
    settings.maxCharsPerMessage,
    settings.charsPerSecond,
    settings.minDelayMs,
    settings.maxDelayMs,
    settings.nightEnabled ? settings.nightStart + '–' + settings.nightEnd : '关',
    settings.nightFactor,
    settings.firstDelayMinMs,
    settings.firstDelayMaxMs,
    Math.round(settings.longPauseP * 100),
    settings.longPauseMinMs,
    settings.longPauseMaxMs,
    settings.selfCorrectEnabled ? '开（' + Math.round(settings.selfCorrectP * 100) + '%）' : '关',
  )
  if (!settings.enable) {
    log.warn('分条已关闭（enable=false）：服务照常注册，但 plan() 退回一次性整段发出')
  }
  if (!NAME_RE.test(name)) {
    log.error('插件名不合规（%s）：服务键会被模型侧拒绝', name)
  }
  if (settings.selfCorrectEnabled) {
    log.warn('自我修正已开启：只做「形态」修正（逗号处断开 + 补一句改口），不改内容——改内容需要模型知道错在哪')
  }
  if (ctx.get('ondra-emotion-express') === undefined) {
    log.info('表达档未装载：按默认语速与句形分条（不跟情绪变化）')
  }
  if (ctx.get('ondra-clock') === undefined) {
    log.info('时间服务未装载：深夜判定退回本机时区（跨时区部署时可能差几小时）')
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
    ) => { readonly value: RhythmConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能被安全补全（非法元素丢弃、越界夹紧），因此永远不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
