/**
 * O-037 `ondra-filter-chain`：输出过滤九步链（〔研〕自研）。
 *
 * 手册 §4.1 的原话只有三行：
 *
 * ```
 * strip_draft → ai_self_expose → hard_redline → relation_redline → stage_redline
 * → narration_trim → repeat_4gram → service_tone → length_fallback
 * ```
 *
 * 加一句「逐条剥离：草稿腔 / AI 自我暴露 / 硬红线 / 关系越线 / 阶段越线 /
 * 旁白叙述 / 4-gram 复读 / 客服腔 / 长度兜底」。**一个正则、一个阈值都没给。**
 *
 * ## 为什么必须自研
 *
 * 手册 §1.8 把「输出过滤九步——复读/旁白/客服腔逐条剥离」列进自研档，P0。
 * 理由写得很直白：社区做的是「评审打分」，没人做「逐条剥离」。
 * 一个打分器只能告诉你「这段不好」，不能告诉你「第三句是旁白」。
 *
 * ## 明确不做
 *
 * - **不生成正文**：只改/拒收已有正文。生成归 O-033。
 * - **不改语气**：六态与句长系数归 O-031；本插件只在「困 / 炸毛」时收紧长度上限。
 * - **不做语义判定的越线检测**：那需要第二个模型；本插件只做字面与句式的确定性判定。
 * - **不把纠偏写进提示词**：`anchors()` 只出那句话，注入归 O-033 / O-036。
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
import type { Config as FilterConfig } from './settings.js'
import { Filter } from './service.js'
import { FILTER_SERVICE_KEY, NAME_RE } from './types.js'
import type {
  ConfigSchemaLike,
  ExpressLike,
  FilterService,
  GatewayLike,
  IdentityLike,
  LogLike,
  PersonaLike,
  StageLike,
} from './types.js'

export type * from './types.js'
export { FILTER_SERVICE_KEY, NAME_RE, STEP_IDS, STEP_SPECS } from './types.js'
export { CONFIG_SECTION_ID } from './settings.js'
export { STAGE_CROSSINGS, PASSES } from './passes.js'
export { detectAnchors, AGREEMENT_STREAK, CORRECTION_TEXT } from './anchors.js'
export { buildReviewMessages, parseFeedback, parseScore, verdictOf } from './review.js'
export { splitSentences, ngramSet, containment, trimTail } from './text.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-filter-chain'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-filter-chain: 注册配置段')
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
    /** 输出过滤服务；未装载本插件时为 undefined。 */
    'ondra-filter-chain'?: FilterService
  }
}

/**
 * Cordis 入口：解析配置、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：`inject` 里有任何一个上游缺席，整个插件会停在
 * PENDING（静默不加载）。这里全部改成取值函数——缺谁就少一步（或少一次评审），
 * 其余八步照跑。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: FilterConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('filter-chain') : 'ondra.filter-chain')

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
  //    服务键都是 Cordis 的字符串重载，类型声明在别的包里，本插件不许 import（§15.5）。
  const filter = new Filter({
    settings,
    log,
    persona: () => ctx.get('ondra-persona-core') as PersonaLike | undefined,
    stage: () => ctx.get('ondra-emotion-stage') as StageLike | undefined,
    express: () => ctx.get('ondra-emotion-express') as ExpressLike | undefined,
    gateway: () => ctx.get('ondra-llm-gateway') as GatewayLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(() => ctx.provide(FILTER_SERVICE_KEY, filter), 'ondra-filter-chain: 注册输出过滤')

  // 4. 报一次现状。可用性与依赖到位情况都要能被自检读到，不许黑箱（§12.2）。
  log.info(
    '输出过滤就绪：长度上限 %d 字（困 ×0.6 / 炸毛 ×0.7），复读 %d-gram 阈值 %s，评审 %s（%d 分及格，每轮 ≤%d 次）',
    settings.maxChars,
    settings.repeatNgram,
    settings.repeatThreshold.toFixed(2),
    settings.reviewEnabled ? '开' : '关',
    settings.reviewThreshold,
    settings.reviewMaxRounds,
  )
  if (!settings.enable) {
    log.warn('输出过滤已关闭（enable=false）：服务照常注册，但 run() 原样返回正文')
  }
  if (!NAME_RE.test(name)) {
    log.error('插件名不合规（%s）：服务键会被模型侧拒绝', name)
  }
  if (ctx.get('ondra-persona-core') === undefined) {
    log.warn('人格内核未装载：硬红线与关系越线两步不会命中（其余七步照跑）')
  }
  if (ctx.get('ondra-emotion-stage') === undefined && settings.verbose) {
    log.info('阶段未装载：阶段越线这一步不会命中（表内七条句式不判）')
  }
  if (settings.reviewEnabled && ctx.get('ondra-llm-gateway') === undefined) {
    log.warn('模型网关未装载：事后评审一律放行（degraded），九步过滤不受影响')
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
    ) => { readonly value: FilterConfig } | { readonly issues: readonly { readonly message: string }[] }
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
