/**
 * O-140 `ondra-evidence-gate`：记忆写入门控（手册 §2.2）。
 *
 * ## 档位：〔薄〕薄封装（手册 §1.8），台账标〔研〕——两者冲突，按手册执行
 *
 * 手册 §1.8 把「证据门控」列在**薄封装**档，原话是「distill-kura 思路自写闸门」：
 * 思路是人家的，闸门是自写的，机制不重写。台账 O-140 那一格标的是〔研〕。
 * 按「手册优先」，本插件按〔薄〕实现，并且**刻意薄**：
 *
 * - 存储、写入、寿命、墓碑全部复用（O-006 / O-007 / O-010），一个字不重写；
 * - 引文归一化逐字对齐 O-011 的 `verify.ts`（跨插件禁 import 的代价，见 `text.ts`）；
 * - 真正自写的只有两样生态里没有的东西：**四类来源的许可判定**与**数字的剥离**。
 *
 * 为什么这两样必须自写：distill-kura 是 Python、面向工程 agent，它的「数字」几乎
 * 全来自命令输出；而本产品的数字大量来自用户自述。照抄它的策略会把
 * 「我今年 28 岁」整句剥空——那不是防幻觉，那是按规则删掉最该记住的东西。
 *
 * ## 为什么这道闸不是模型
 *
 * 手册原话：「自我强化幻觉污染整库是提示词拦不住的，必须确定性代码闸门。」
 * 用模型去检查模型的编造，等于用一把会伸缩的尺子去量长度。故本插件
 * **零模型调用、零网络、零定时器**，`judge()` 是同步纯函数。
 *
 * ## 为什么服务照常注册，即使依赖全缺席
 *
 * 门控的判定不依赖任何上游：它只要「正文 + 引文 + 素材」三样东西。
 * 内核缺席只影响墓碑闸（如实报 `tombstoneGate: 'absent'`），存储缺席只影响审计日志。
 * 所以这里**不声明插件级 `inject`**——声明了会让上游缺席时整插件停在 PENDING，
 * 而门控本该是最先能用的那一层。
 */

import type { Context } from '@ntars/cordis'
import { GateLog } from './log.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as GateConfig } from './settings.js'
import { EvidenceGate } from './service.js'
import { EVIDENCE_GATE_SERVICE_KEY } from './types.js'
import type {
  ConfigSchemaLike,
  EvidenceGateService,
  IdentityLike,
  LogLike,
  MemoryCoreLike,
  StoreLike,
} from './types.js'

// 契约里既有纯类型也有运行时值（服务键、来源表、原因码表），分开导出才不违背
// 「类型导入不得混入运行时值」这条自检项。
export type * from './types.js'
export {
  EVIDENCE_GATE_SERVICE_KEY,
  EVIDENCE_SOURCES,
  GATE_REASON_CODES,
  SOURCE_PERMITS,
} from './types.js'
export { judgeCandidate, locateQuote } from './gate.js'
export {
  allowedDigitSources,
  coveringSource,
  digitRuns,
  stripUncoveredClauses,
} from './digits.js'
export type { DigitSourcePolicy, StripResult } from './digits.js'
export {
  asSource,
  ATTRIBUTION_VERBS,
  isAttributionClaim,
  resolveSubject,
  SOURCE_PRIORITY,
  USER_MARKERS,
} from './sources.js'
export {
  charCount,
  containsVerbatim,
  cutByCodepoints,
  joinClauses,
  normalizeForMatch,
  normalizeQuote,
  splitClauses,
} from './text.js'
export type { Clause } from './text.js'
export { GateLog, TABLE_EVIDENCE_GATE_LOG } from './log.js'
export type { GateLogEntry } from './log.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-evidence-gate'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 向 O-005 注册配置段。
 *
 * 注册放进 `ctx.effect` 里：段是本插件的资源，卸载时必须一起撤，
 * 否则重载后第二次注册会撞「段键已被占用」。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 注册是否成功。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-evidence-gate: 注册配置段')
    return true
  } catch (error) {
    // 注册失败不是致命：四层合并与来源追溯用不上，插件实例配置照样能跑。
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 证据门控服务；未装载本插件时为 undefined。 */
    'ondra-evidence-gate'?: EvidenceGateService
  }
}

/**
 * Cordis 入口：解析配置、接上可选的墓碑与审计、注册服务。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: GateConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('evidence-gate') : 'ondra.evidence-gate') as unknown) as LogLike

  // 1. 配置：有 O-005 就走四层合并（并能说出「哪一层的哪个字段」）。
  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  if (schema !== undefined && registerSection(ctx, schema, log)) {
    try {
      // 用户层用 kebab 键交给 O-005（§8.4 只认小写），回来再换成 camel 键。
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

  // 2. 记忆内核是**软依赖**：只用来查墓碑。缺席时墓碑闸如实报 absent，判定照常。
  const core = ctx.get('ondra-memory-core') as MemoryCoreLike | undefined
  if (core === undefined) {
    log.warn('找不到记忆内核（ondra-memory-core）：门控照常工作，但墓碑闸不跑（被忘记的事可能被重新写进来）')
  } else if (!core.available) {
    log.warn('记忆内核在位但不可用：墓碑闸暂时不跑')
  }

  // 3. 存储端口是**软依赖**：只用来落审计日志。
  const store = (ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')) as StoreLike | undefined
  let gateLog: GateLog | undefined
  if (store !== undefined) {
    const created = new GateLog(store, settings, log, () => Date.now())
    ctx.effect(() => {
      created.ensure()
      return () => undefined
    }, 'ondra-evidence-gate: 建门控日志表')
    gateLog = created
  } else {
    log.warn('没有可用存储端口：门控照常，但不落审计日志（事后查不到「为什么这条没记住」）')
  }

  // 4. 内核用延迟取值：构造时取一次的话，内核晚装载会让墓碑闸永久关闭且只留一句 warn。
  const service = new EvidenceGate(
    settings,
    log,
    () => Date.now(),
    () => ctx.get('ondra-memory-core') as MemoryCoreLike | undefined,
    gateLog,
  )
  ctx.effect(() => ctx.provide(EVIDENCE_GATE_SERVICE_KEY, service), 'ondra-evidence-gate: 注册门控服务')

  // 5. 报一次现状。可用性、墓碑闸形态、日志行数都要能被自检读到，不许黑箱（§12.2）。
  if (!service.available) {
    log.warn('证据门控被配置关掉了（enable=false）：写入路径不再检查出处，这是明确的风险选择')
    return
  }
  const stats = service.stats()
  log.info(
    '证据门控就绪：正文上限 %d 字、引文最短 %d 字、单条最多 %d 条引文；数字来源 %s；墓碑闸 %s；审计日志 %s（%d 行）',
    settings.maxTextChars,
    settings.minQuoteChars,
    settings.maxEvidence,
    settings.digitSource,
    stats.tombstoneGate === 'service' ? '开' : '关（内核缺席）',
    stats.logging ? '开' : '关',
    stats.logRows,
  )
  if (settings.digitSource === 'tool-or-user') {
    // 这是一处**与手册字面的偏离**，必须在启动时说出来，不能只写在 README 里。
    log.info(
      '数字来源为 tool-or-user：USER 逐字引文也能覆盖数字。手册字面是 tool-only，改成 tool-only 可恢复严格口径',
    )
  }
  if (settings.selfOnlyAction === 'seed') {
    log.info('只有 SELF 引文的候选会得到 seed 结论：本插件只判定，种子文件由调用方落盘')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。配置错不该让插件不加载，
 * 只该让某个字段回退默认并被记下来。
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
      // `completeConfig` 永不抛错：越界值被夹紧、类型错回退默认，都是「能补的」。
      return { value: completeConfig(value) }
    },
  },
}
