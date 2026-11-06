/**
 * O-051 `ondra-tts-gate`：四道闸门 + 连读上限。
 *
 * ## 装载期只做三件事
 *
 * 1. 解析配置（有 O-005 就走四层合并，没有就用本地校验）；
 * 2. `provide` 闸门服务；
 * 3. 打一行现状：门槛各是多少、此刻缺哪些上游。
 *
 * **不在装载期判定任何一句话**：`decide()` 需要读情绪与合成器状态，
 * 而装载时它们可能都还没就位——那时判出的「不该念」会被当成结论，
 * 而它其实只是「那会儿还没装好」（与 O-049 那条「装载期不要预计算」同一条纪律）。
 *
 * ## 刻意不声明插件级 `inject`
 *
 * 三个依赖（`ondra-tts` / `ondra-emotion-core` / `ondra-emotion-express`）全软。
 * 声明 `inject` 会让缺一个就整包停 PENDING，而缺的那一个恰恰是
 * 「为什么不出声」的答案——面板读不到闸门，就永远查不出来。
 *
 * ## 刻意不注册工具、不发声
 *
 * 本插件只回答「要不要出声」。把它做成工具，模型就能自己决定「我要说话」，
 * 四道闸门立刻形同虚设；让它自己去调 O-050，则把「判定」与「执行」缝在了一起，
 * 以后想换成「先出气泡再出声」就得改闸门。
 */

import type { Context } from '@ntars/cordis'
import { Gate } from './service.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as GateConfig } from './settings.js'
import { GATE_SERVICE_KEY, NAME_RE } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  EmotionLike,
  ExpressLike,
  GateService,
  IdentityLike,
  LogLike,
  TtsLike,
} from './types.js'

export type * from './types.js'
export { GATE_SERVICE_KEY, NAME_RE } from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  MIN_CHARS_FLOOR,
  MIN_CHARS_CEIL,
  MAX_CHARS_FLOOR,
  MAX_CHARS_CEIL,
  COOLDOWN_CEIL,
  STREAK_FLOOR,
  STREAK_CEIL,
  completeConfig,
  configDriftOf,
} from './settings.js'
export { EMOTIVE_WORDS, hasEmotive } from './lexicon.js'
export { charCount, intensityOf, lengthReason, emotionReason, cooldownReason, streakReason, rateOf } from './gate.js'
export { Gate } from './service.js'
export type { GateDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-tts-gate'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-tts-gate: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 语音闸门服务；未装载本插件时为 undefined。 */
    'ondra-tts-gate'?: GateService
  }
}

/**
 * Cordis 入口：解析配置、注册服务、报一次现状。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: GateConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('tts-gate') : 'ondra.tts-gate')

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

  // 3. 时间：现取 O-003，缺席退回系统时钟。每次判定都现取一次（装载顺序不定）。
  const now = (): number => {
    const live = ctx.get('ondra-clock') as ClockLike | undefined
    return live === undefined ? Date.now() : live.now()
  }

  const gate = new Gate({
    settings,
    log,
    now,
    emotion: () => ctx.get('ondra-emotion-core') as EmotionLike | undefined,
    express: () => ctx.get('ondra-emotion-express') as ExpressLike | undefined,
    tts: () => ctx.get('ondra-tts') as TtsLike | undefined,
  })

  ctx.effect(() => ctx.provide(GATE_SERVICE_KEY, gate), 'ondra-tts-gate: 注册语音闸门服务')

  // 4. 报一次现状。这里说的是「此刻」，三个上游随时可能后装载，
  //    所以缺谁只用 info，不用 warn——装载顺序不是故障。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值越界已回退（%s）：门槛与你设的不一样', drift.join(' / '))
  }

  if (!settings.enable) {
    log.warn('语音闸门已关闭（enable=false）：decide() 一律 disabled，服务照常注册')
  } else {
    log.info(
      '语音闸门就绪：%d–%d 字 · 强度 ≥%s · 频控 %dms · 连读上限 %d 条',
      settings.minChars,
      settings.maxChars,
      settings.intensityMin.toFixed(2),
      settings.cooldownMs,
      settings.maxConsecutive,
    )
  }

  // 「此刻」的三条上游。后装载是正常的，因此逐条 info，不聚合、不告警。
  if (ctx.get('ondra-tts') === undefined) {
    log.info('此刻没有 ondra-tts：判定一律 unavailable（装好之后会自动恢复，无需重启插件）')
  }
  if (ctx.get('ondra-emotion-core') === undefined) {
    log.info('此刻没有 ondra-emotion-core：情绪强度闸按降级放行（degraded 里会标 no-emotion）')
  }
  if (ctx.get('ondra-emotion-express') === undefined) {
    log.info('此刻没有 ondra-emotion-express：拿不到六态语速，也判不出「炸毛不朗读」')
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
    ) => { readonly value: GateConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能被安全补全（越界夹紧、上下界互相夹住），因此永远不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
