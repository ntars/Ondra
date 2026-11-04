/**
 * O-137 `ondra-lexicon`：语感统计。
 *
 * ## 它在哪一段链路上
 *
 * ```
 * 通道 / 对话链把「主人这一句」交给本插件（observe）
 *   → 本插件压成形状（句长 / 有无标点 / 句末语气词），原文当次丢弃
 *   → 要拼提示词时读一眼（compose），得到一段约 55 字、带 [语感] marker 的易变段
 *   → 调用方把它当 TailPart 追加在易变段尾部 → 她模仿节奏，而不是模仿内容
 * ```
 *
 * ## 明确不做
 *
 * - **不改人格**：人格四段归 O-023，由 O-033 冻结成前缀。本包出的是易变段，
 *   正文里没有一句「你应该」。
 * - **不自己写 system prompt**：拼装顺序归 O-033，装箱归 O-036。本包只给一段正文
 *   与一个建议排序键，**不抢别人的位置**。
 * - **不往 O-036 的八块里塞**：那八块是固定闭集（`BLOCK_IDS`），加一块要改上游；
 *   改了上游，O-142 的按块去重会静默失配。
 * - **不调模型、不装定时器、不订阅事件**：三个统计量全是确定性计算，
 *   没有一处需要「理解」语义。
 * - **不存原话**：存档里只有形状。这条是结构性的，不是承诺。
 * - **不画界面**：语感面板、曲线图归应用外壳（`desktop/`）。
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
import type { Config as LexiconConfig } from './settings.js'
import { Lexicon } from './service.js'
import { LEXICON_SERVICE_KEY, NAME_RE } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  LexiconService,
  LogLike,
  PathLike,
} from './types.js'

export type * from './types.js'
export {
  BLOCK_ORDER,
  BLOCK_REASONS,
  LEXICON_SERVICE_KEY,
  MARKER,
  NAME_RE,
  PARTICLES,
  REASON_ZH,
  SAMPLE_WINDOW,
  SOURCES,
} from './types.js'
export {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  completeConfig,
} from './settings.js'
export {
  PUNCT_COUNT,
  charsOf,
  clipToChars,
  composeText,
  confidenceOf,
  fingerprintOf,
  fnv1a64,
  hasNoPunct,
  isPunct,
  medianOf,
  rateOf,
  sentencesOf,
  shapeOf,
  stripOf,
  tailParticleOf,
  topParticlesOf,
} from './shape.js'
export type { ComposeOptions } from './shape.js'
export {
  STATE_FILE_NAME,
  STATE_VERSION,
  appendShape,
  emptyState,
  normalizeShape,
  normalizeState,
  pruneByAge,
  readState,
  writeState,
} from './state.js'
export type { LexiconState } from './state.js'
export { Lexicon } from './service.js'
export type { LexiconOptions } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-lexicon'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-lexicon: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 语感服务；未装载本插件时为 undefined。 */
    'ondra-lexicon'?: LexiconService
  }
}

/**
 * Cordis 入口：解析配置、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：`ondra-path-layout` / `ondra-clock` 都是软依赖，
 * 缺席时正确表现是「降级并告警」，而不是「整个插件停在 PENDING」——
 * 停在 PENDING 会让调用方连 `compose()` 都拿不到，而它一句话原因都说不出。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: LexiconConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('lexicon') : 'ondra.lexicon')

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
          log.warn('配置有 %d 个字段校验失败，已逐个回退默认值', resolved.fallbackCount)
        }
      }
    } catch (error) {
      log.warn('解析配置段失败，退回插件实例配置：%s', messageOf(error))
    }
  }

  // 2. 补全 + 夹紧。任何非法值都回退默认，绝不抛。
  const settings = completeConfig(effective)

  // 3. 依赖全部用取值函数：上游晚装载时能自愈，早卸载时立刻反映。
  //    服务键都是 Cordis 的字符串重载，类型声明在别的包里，本插件不许 import（§15.5）。
  const lexicon = new Lexicon({
    settings,
    log,
    path: () => ctx.get('ondra-path-layout') as PathLike | undefined,
    now: () => {
      const clock = ctx.get('ondra-clock') as ClockLike | undefined
      return clock === undefined ? Date.now() : clock.now()
    },
  })

  ctx.effect(() => ctx.provide(LEXICON_SERVICE_KEY, lexicon), 'ondra-lexicon: 注册语感服务')
  ctx.effect(() => () => lexicon.dispose(), 'ondra-lexicon: 卸载时把形状写盘')

  // 4. 报一次现状：窗口、门槛、落盘、当前的段状态都要能被自检读到。
  const block = lexicon.compose()
  log.info(
    '语感就绪：窗口 %d 条 · 门槛 %d 条 · 正文上限 %d 字 · 只统计主人 %s · 形状落盘 %s',
    settings.windowSize,
    settings.minSamples,
    settings.maxChars,
    settings.ownerOnly ? '是' : '否（群友的话也算）',
    lexicon.stored ? '是' : '否（重启要重新攒样本）',
  )
  if (!settings.enable) {
    log.warn('语感已关闭（enable=false）：服务照常注册，compose() 一律返回 disabled 的空段')
  }
  if (!NAME_RE.test(name)) {
    log.error('插件名不合规（%s）：服务键会被模型侧拒绝', name)
  }
  if (block.reason === 'too-few') {
    log.info('当前样本还不够（门槛 %d 条），暂时不出语感段', settings.minSamples)
  }
  if (ctx.get('ondra-path-layout') === undefined) {
    log.warn('路径服务未装载：形状只在内存里，重启后要重新攒样本')
  }
  if (ctx.get('ondra-clock') === undefined) {
    log.info('时间服务未装载：样本时刻退回本机时间（只影响时间窗淘汰）')
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
    ) => { readonly value: LexiconConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能被安全补全（非法值回退默认、数值夹紧），因此永远不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
