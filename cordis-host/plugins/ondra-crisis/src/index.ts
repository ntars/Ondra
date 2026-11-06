/**
 * O-106 `ondra-crisis`：危机干预分级（〔研〕自研，L9 扩展池）。
 *
 * ## 它到底做什么
 *
 * 回答一个问题：**「这一句话里，有没有需要我停下来认真对待的信号？」**
 *
 * 五类信号（间接 / 直接 / 计划 / 告别 / 自伤）各自映射到四档之一，
 * 再过一遍语境标记，最后给出三个**布尔建议**：要不要暂停人设、
 * 要不要给求助资源、要不要直接问一句。说什么话、怎么切、要不要停，
 * 全归 O-033 / O-037 / 通道层。
 *
 * ## 它刻意不做什么（七条，每条都否掉一种「更顺手」的做法）
 *
 * - **不诊断、不打分。** 「危机风险 72 分」会被当成结论，而它只是正则的命中结果。
 * - **不承诺保密。** 承诺保密是危机干预里最典型的新手错误——它会让对方
 *   放弃找真正能到场的人。
 * - **不落盘、不写记忆。** 把人的至暗时刻存成可检索记忆，等于让她日后
 *   随时可能提起那件事（O-014 会检索、O-036 会注入），那是二次伤害。
 * - **不内置热线号码。** 号码有地区差异且会变更，写死错号在危机时刻是灾难。
 * - **不因情绪低落判危机。** 刻意不读 O-028 的 PAD：悲伤不是危机；
 *   把低落反复当危机，人就会学会隐藏情绪。
 * - **不返回原文。** 只回命中下标 —— 命中的那句话本身就是最敏感的内容。
 * - **不装定时器、不做界面。** 判定是拉取式的；渲染归应用外壳。
 *
 * ## 依赖纪律
 *
 * 零上游服务依赖（只有可选的 O-005 与 O-001），故不声明插件级 `inject`：
 * 天然可静态判定，不联网、不读情绪、不碰存储。
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
import type { Config as CrisisConfig } from './settings.js'
import { CrisisGuard, messageOf } from './service.js'
import { CRISIS_SERVICE_KEY } from './types.js'
import type { ConfigSchemaLike, CrisisService, IdentityLike, LogLike } from './types.js'

export type * from './types.js'
export {
  CRISIS_SERVICE_KEY,
  CRISIS_GROUPS,
  CRISIS_LEVELS,
  LEVEL_ORDER,
  MAX_HITS,
  NAME_RE,
  CrisisError,
} from './types.js'
export {
  BASE_GUIDANCE,
  CrisisGuard,
} from './service.js'
export type { CrisisDeps } from './service.js'
export {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  MAX_SCAN_CHARS,
  SECTION_KEYS,
  completeConfig,
  normalizeHotlines,
} from './settings.js'
export { assessText, compileRules, flagsOf, levelOf, maxLevel, noteOf, scanText } from './assess.js'
export type { AssessInput, CompileResult, CompiledRule, ScanOptions, ScanResult } from './assess.js'
export {
  FLAG_WINDOW,
  HYPOTHETICAL_WORDS,
  NEGATION_WINDOW,
  NEGATION_WORDS,
  PAST_WORDS,
  RULES,
  THIRD_PARTY_WORDS,
} from './rules.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-crisis'

/**
 * 本插件**不声明** `inject`：没有任何硬依赖。
 *
 * 这一点写在代码里是给未来的自己看的：危机判定最容易被顺手加上
 * 「情绪服务」当依赖——而情绪读数与危机不是一回事（悲伤不是危机），
 * 一旦成了硬依赖，缺情绪服务就等于把护栏也关掉。
 */

/**
 * 向 O-005 注册配置段。放进 `ctx.effect`：段是本插件的资源，卸载时必须一起撤。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 注册是否成功。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-crisis: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 危机分级服务；未装载本插件时为 undefined。 */
    'ondra-crisis'?: CrisisService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: CrisisConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('crisis') : 'ondra.crisis')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  // 1. 有 O-005 就走四层合并（能说出「哪一层的哪个字段」）。
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

  // 2. 补全。任何非法值都回退默认，绝不抛。
  const settings = completeConfig(effective)

  // 3. 建服务（构造期即编译判据，编译失败只跳过单条并报错日志）。
  const guard = new CrisisGuard({ settings, log, now: () => Date.now() })

  ctx.effect(() => ctx.provide(CRISIS_SERVICE_KEY, guard), 'ondra-crisis: 注册危机分级服务')

  // 4. 报一次现状：判据条数、可用性、号码是否配过。全都可被自检读到。
  const signalCount = guard.signals.length
  log.info(
    '危机分级就绪：%s，判据 %d 条（纯规则，不联网、不落盘、不打分）',
    guard.available ? '可用' : '已关闭（enable=false）',
    signalCount,
  )
  if (!guard.resources().configured) {
    // 必须说出来：没配号码时它只能给通用指引，而部署方常常以为「插件自带热线」。
    log.info('未配置求助号码：判定照常，resources() 只返回通用指引，请部署方在配置段 crisis.hotlines 里填本地号码')
  }
  if (signalCount === 0) {
    log.error('没有任何可用判据：危机判定此刻形同未装')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补**。号码表里坏一条丢一条、数字夹到区间、
 * 文本超长截断——因此永远不产 issue：配置写错不该让护栏不加载
 * （不加载等于在最需要它的时候它不在）。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: CrisisConfig } | { readonly issues: readonly { readonly message: string }[] }
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
