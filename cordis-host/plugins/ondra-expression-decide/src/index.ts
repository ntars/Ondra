/**
 * O-052 `ondra-expression-decide`：正文 → 表情标记（规则版）。
 *
 * ## 装载期只做三件事
 *
 * 1. 解析配置（有 O-005 就走四层合并，没有就用本地校验）；
 * 2. `provide` 判定服务；
 * 3. 打一行现状：门槛多少、语料自检有没有问题、此刻缺哪个上游。
 *
 * **不在装载期判定任何一句话**：装载时 O-031 可能还没起来，
 * 那时判出的「脸上该是平静」会被当成结论，而它其实只是
 * 「那会儿还没装好」（与 O-049 / O-051 同一条纪律）。
 *
 * ## 刻意不声明插件级 `inject`
 *
 * `ondra-emotion-express` 是**软依赖**：它缺席时本插件按正文线索照常工作，
 * 只是拿不到回落用的六态。声明 `inject` 会让缺一个就整包停 PENDING，
 * 而"为什么表情总是平静"的答案恰恰就在那个缺席里。
 *
 * ## 刻意不注册工具、不碰文本
 *
 * 做成工具，模型就能自己决定"我这句该配什么脸"——那等于让被观察者写观察结果。
 * 碰文本更不行：手册 §4.3 内感受铁律禁命名，把「雀跃」这类词写进正文
 * 就是把内部词汇泄进她要说的话里；而往话里插标记的另一条路
 * 会与 O-040 `ondra-oral`（只加不删的塑形层）抢同一段字符串。
 */

import type { Context } from '@ntars/cordis'
import { ExpressionDecider } from './service.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as DecideConfig } from './settings.js'
import { lexiconIssues } from './lexicon.js'
import { DECIDE_SERVICE_KEY, NAME_RE } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  ExpressionService,
  ExpressLike,
  IdentityLike,
  LogLike,
} from './types.js'

export type * from './types.js'
export { DECIDE_SERVICE_KEY, NAME_RE, EXPRESS_STATES, STATE_ZH, STATE_PRIORITY, isExpressionState } from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  MIN_SCORE_FLOOR,
  MIN_SCORE_CEIL,
  completeConfig,
  configDriftOf,
} from './settings.js'
export {
  STRONG_WORDS,
  MID_WORDS,
  WEIGHT_STRONG,
  WEIGHT_MID,
  WEIGHT_PUNCT,
  WEIGHT_SHAPE,
  SHORT_CHARS,
  LONG_CHARS,
  charCount,
  matchWords,
  matchPunct,
  matchShape,
  lexiconIssues,
} from './lexicon.js'
export { collectCues, scoreOf, rankOf, markOf, dominantOf } from './decide.js'
export type { MarkInput } from './decide.js'
export { ExpressionDecider } from './service.js'
export type { DeciderDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-expression-decide'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-expression-decide: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 表情判定服务；未装载本插件时为 undefined。 */
    'ondra-expression-decide'?: ExpressionService
  }
}

/**
 * Cordis 入口：解析配置、注册服务、报一次现状。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: DecideConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('expression-decide') : 'ondra.expression-decide')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  // 1. 有 O-005 就让配置走四层合并。
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

  // 3. 时间：现取 O-003，缺席退回系统时钟。
  const now = (): number => {
    const live = ctx.get('ondra-clock') as ClockLike | undefined
    return live === undefined ? Date.now() : live.now()
  }

  const service = new ExpressionDecider({
    settings,
    log,
    now,
    express: () => ctx.get('ondra-emotion-express') as ExpressLike | undefined,
  })

  ctx.effect(() => ctx.provide(DECIDE_SERVICE_KEY, service), 'ondra-expression-decide: 注册表情判定服务')

  // 4. 报一次现状。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值越界已回退（%s）：门槛与你设的不一样', drift.join(' / '))
  }

  if (!settings.enable) {
    log.warn('表情判定已关闭（enable=false）：decide() 一律给"没有依据"的默认表情，服务照常注册')
  } else {
    log.info(
      '表情判定就绪：门槛 %d 分 · 回落六态 %s · 默认表情 %s',
      settings.minScore,
      settings.useStateFallback ? '开' : '关',
      settings.fallbackState,
    )
  }

  // 语料自检：词表写错不会让代码报错，只会让表情慢慢偏，所以每次装载都数一遍。
  const issues = lexiconIssues()
  if (issues.length > 0) {
    log.warn('线索词表自检发现 %d 个问题：%s', issues.length, issues.join(' / '))
  }

  // 「此刻」的上游。后装载是正常的，因此只用 info。
  if (ctx.get('ondra-emotion-express') === undefined) {
    log.info('此刻没有 ondra-emotion-express：正文无线索时只能给默认表情（装好之后自动恢复，无需重启插件）')
  }
  if (!NAME_RE.test(name)) {
    log.error('插件名不合规（%s）：服务键会被模型侧拒绝', name)
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: DecideConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能被安全补全（越界夹紧、非法枚举回退），因此永远不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
