/**
 * O-040 `ondra-oral`：口语化塑形（〔研〕自研）。
 *
 * ## 为什么是〔研〕
 *
 * 手册 §4.2 把「口语化细则」写成一串**参数**（口头禅 12–20 条 / 单场 2 次 /
 * 不完整句 8% / 标点习惯 / 中位 8–12 字 / 贴纸间隔 3 条 / 零错别字），
 * 而生态里没有「中文口语化塑形」这类现成件——有的都是**风格迁移**（LoRA），
 * 而手册已经把 LoRA 路线判死（§4.2 四轮全部未达可用，裁决⑫）。
 * 「台词库检索 + 统计」也不是本插件：那是 O-137，做的是**学用户**；
 * 本插件做的是**守她自己的口癖**。两件事不重叠。
 *
 * ## 为什么池子是空的
 *
 * 手册说「口头禅池每人格 12–20 条」，但**没有给这 12–20 条是什么**——
 * 那是台词库（39 文件 2615 条）迁移之后才有的语料，属 §1.9 的迁移债。
 * 编 12 条「诶、那个、说真的」塞进出厂池，等于替人设写词。
 * 所以：**出厂零池，`registerPool()` 由人设包或台词库灌**；
 * 池子不到 12 条时一个字都不插，并在日志里说清楚原因。
 *
 * ## 明确不做
 *
 * - **不改语义**：删句、去客服腔、红线拦截归 O-037。本插件只加口癖与标点。
 * - **不造语气词**：`rich` 档一个字都不加（人设包有语气词白名单）。
 * - **不发贴纸**：只做「最小间隔 3 条」的闸门，发归 O-052。
 * - **不截断**：中位 8–12 字只报告，不动正文。
 * - **不装定时器**：会话账本纯内存、按需淘汰。
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
import type { Config as OralConfig } from './settings.js'
import { Oral } from './service.js'
import { NAME_RE, ORAL_SERVICE_KEY } from './types.js'
import type {
  ConfigSchemaLike,
  ExpressLike,
  IdentityLike,
  LogLike,
  OralService,
} from './types.js'

export type * from './types.js'
export {
  ORAL_SERVICE_KEY,
  NAME_RE,
  ORAL_STATES,
  HARD_MAX_HABIT_PER_SESSION,
  HARD_MIN_POOL_SIZE,
  HARD_MAX_POOL_SIZE,
  HARD_MIN_STICKER_GAP,
  MAX_HABIT_CHARS,
  isStateLike,
} from './types.js'
export { CONFIG_SECTION_ID, HABIT_PLACEMENTS, completeConfig } from './settings.js'
export {
  countChars,
  splitTail,
  trimParticles,
  dropFinalPeriod,
  doubleQuestion,
  hesitate,
  dropSubject,
  trimEnding,
  insertHabit,
  medianLength,
  PARTICLES,
} from './text.js'
export { normalizeEntries, pickHabit, SessionLedger } from './pool.js'
export { Oral } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-oral'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-oral: 注册配置段')
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
    /** 口语化塑形服务；未装载本插件时为 undefined。 */
    'ondra-oral'?: OralService
  }
}

/**
 * Cordis 入口：解析配置、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：六态语域（O-031）是可选增强。
 * 没有它就按默认标点与语气词处理；写进 `inject` 会让「上游缺席」
 * 变成「整个插件不加载」，而缺它时她只是少一点语感，不是不能说话。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: OralConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('oral') : 'ondra.oral')

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
  const oral = new Oral({
    settings,
    log,
    express: () => ctx.get('ondra-emotion-express') as ExpressLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(() => ctx.provide(ORAL_SERVICE_KEY, oral), 'ondra-oral: 注册口语化服务')

  // 4. 报一次现状。可用性与依赖到位情况都要能被自检读到，不许黑箱（§12.2）。
  log.info(
    '口语化就绪：口头禅 %s（单场 ≤%d 次，池 %d–%d 条）/ 不完整句 %s / 语气词 %s / 标点 %s / 中位 %d–%d 字 / 贴纸间隔 ≥%d 条',
    settings.habitEnabled ? '开' : '关',
    settings.habitMaxPerSession,
    settings.habitMinPoolSize,
    settings.habitMaxPoolSize,
    settings.incompleteEnabled ? Math.round(settings.incompleteP * 100) + '%' : '关',
    settings.particlesEnabled ? '按档位做减法' : '关',
    settings.punctEnabled ? '开' : '关',
    settings.medianMin,
    settings.medianMax,
    settings.stickerGap,
  )
  if (!settings.enable) {
    log.warn('口语化已关闭（enable=false）：服务照常注册，apply() 原样返回')
  }
  if (!NAME_RE.test(name)) {
    log.error('插件名不合规（%s）：服务键会被模型侧拒绝', name)
  }
  if (settings.habitEnabled) {
    log.info('口头禅池出厂为空：需 registerPool() 灌入 12–20 条（台词库迁移前不插口癖）')
  }
  if (ctx.get('ondra-emotion-express') === undefined) {
    log.info('表达档未装载：按默认标点处理（不去句号、不加问号、不换省略号）')
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
    ) => { readonly value: OralConfig } | { readonly issues: readonly { readonly message: string }[] }
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
