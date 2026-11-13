/**
 * O-043 `ondra-proactive-reason`：主动消息的「话由」（〔研〕）。
 *
 * ## 为什么是〔研〕
 *
 * 手册 §1.8 的复用档里没有「话由排序」这个东西。生态里的主动消息插件
 * （包括 §5.5 描述的心跳引擎）都是**定时 + 模板**：到点了，挑一句预设的话发出去。
 * 而这里要做的是**从她自己此刻的状态里挑一个由头**——执念、承诺、待办、
 * 情绪偏离、近期事件、时间线、环境，七类混在一起按优先级排。
 *
 * 更关键的是第三件事：**72 小时冷却**。没有它，这套排序会在「她今天最在意的那件事」
 * 上反复打转——每一轮都是同一条执念分最高，于是她每隔半小时问一次同样的问题。
 * 冷却让「同一件事」在三天内只说一次，这才是「惦记」而不是「复读」。
 *
 * ## 明确不做
 *
 * - **不判断发不发**：那是 O-042 的九道闸（静默、额度、速率、冷却、熔断）。
 * - **不生成聊天正文**：`ReasonCandidate.text` 是**由头**（一句话说明为什么找她），
 *   不是要发出去的那句话。正文归对话链与模型。
 * - **不按条数砍**（§12.1 P0）：候选全量返回，冷却只标记不剔除。
 * - **不做相似度判重**：话题键取上游稳定 id，见 `topics.ts` 文件头。
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
import type { Config as ReasonConfig } from './settings.js'
import { Reason } from './service.js'
import { NAME_RE, REASON_SERVICE_KEY } from './types.js'
import type {
  ConfigSchemaLike,
  DriveGapLike,
  ExpressLike,
  IdentityLike,
  LogLike,
  PathLike,
  ProspectiveLike,
  ReasonService,
} from './types.js'

export type * from './types.js'
export {
  COOLDOWN_HOURS,
  EMOTION_SEEDS,
  KIND_ORDER,
  KIND_STEP,
  KIND_ZH,
  NAME_RE,
  NOTE_MAX_FRAGMENT,
  NOTE_MIN_FRAGMENT,
  REASON_SERVICE_KEY,
  STATE_FILE_NAME,
  TOPIC_CHARS,
  UNKNOWN_EMOTION_WEIGHT,
} from './types.js'
export { CONFIG_SECTION_ID, DEFAULT_CONFIG, FIELD_SPECS, MAX_COOLDOWN_HOURS, SECTION_KEYS, completeConfig } from './settings.js'
export { mentions, normalizeTopic, prefixOf, textTopic, topicOf } from './topics.js'
export {
  COOLDOWN_VERSION,
  MAX_COOLDOWN_ENTRIES,
  coolingUntil,
  emptyCooldown,
  markEntry,
  normalizeCooldown,
  pruneEntries,
  readCooldown,
  writeCooldown,
} from './cooldown.js'
export type { CooldownEntry } from './cooldown.js'
export { collect } from './collect.js'
export type { CollectDeps, CollectResult } from './collect.js'
export { orderOf, pickOf, rank, scoreOf } from './rank.js'
export { Reason, SERVICE_KEY } from './service.js'
export type { ReasonOptions } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-proactive-reason'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 向 O-005 注册配置段。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-proactive-reason: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 话由服务；未装载本插件时为 undefined。 */
    'ondra-proactive-reason'?: ReasonService
  }
}

/**
 * Cordis 入口：解析配置、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：三个上游（O-016 / O-129 / O-031）任何一个缺席，
 * 正确表现是「少一类话由」而不是「整个插件停在 PENDING」。
 * 写进 `inject` 会让「少一类」升级成「一条都没有」。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: ReasonConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('proactive-reason') : 'ondra.proactive-reason')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

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

  const settings = completeConfig(effective)

  // 依赖全部用取值函数：上游晚装载能自愈，早卸载立刻反映。
  const reason = new Reason({
    settings,
    log,
    path: () => ctx.get('ondra-path-layout') as PathLike | undefined,
    now: () => Date.now(),
    prospective: () => ctx.get('ondra-memory-prospective') as ProspectiveLike | undefined,
    gap: () => ctx.get('ondra-drive-gap') as DriveGapLike | undefined,
    express: () => ctx.get('ondra-emotion-express') as ExpressLike | undefined,
  })

  ctx.effect(() => ctx.provide(REASON_SERVICE_KEY, reason), 'ondra-proactive-reason: 注册话由服务')

  const plan = reason.plan()
  log.info(
    '话由就绪：冷却 %d 小时 · 候选 %d 条 · 本轮首选 %s',
    settings.cooldownHours,
    plan.candidates.length,
    plan.pick === undefined ? '（无）' : plan.pick.kind + '「' + plan.pick.text + '」',
  )
  if (!settings.enable) {
    log.warn('话由已关闭（enable=false）：服务照常注册，plan() 返回 disabled')
  }
  if (!NAME_RE.test(name)) {
    log.error('插件名不合规（%s）：服务键会被模型侧拒绝', name)
  }
  if (settings.verbose) {
    if (!plan.sources.gap) {
      log.info('缺口池未装载（ondra-drive-gap）：少一类话由——「她自己在惦记」这类由头不会出现')
    }
    if (!plan.sources.promise) {
      log.info('承诺/待办未装载（ondra-memory-prospective）：少两类话由')
    }
    if (!plan.sources.emotion) {
      log.info('情绪表达未装载（ondra-emotion-express）：少一类话由')
    }
    if (plan.code === 'all-cooling') {
      log.info(
        '当前 %d 条候选全在冷却里：这一轮没有可说的由头（这是正常状态，不是故障）',
        plan.candidates.length,
      )
    }
  }
  if (ctx.get('ondra-path-layout') === undefined) {
    log.warn('路径服务未装载：冷却表只在内存里，重启后同一件事会被重提')
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
    ) => { readonly value: ReasonConfig } | { readonly issues: readonly { readonly message: string }[] }
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
