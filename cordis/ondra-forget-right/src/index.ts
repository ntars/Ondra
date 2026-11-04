/**
 * O-103 `ondra-forget-right`：被遗忘权（〔研〕自研，L9 扩展池）。
 *
 * ## 它到底做什么
 *
 * 用户说「把这件事忘掉」时，**把要清的地方一次数清**：正文、钉子、图边、向量、待办、
 * 承诺、胶囊、台词样本、日记、叙事日志、快照——十一面。
 * 能删的删（并逐面报「动了几条」），删不掉的**如实说删不掉**（并尽量数出还剩多少）。
 *
 * ## 它刻意不做什么（五条）
 *
 * - **不做单一「删除」按钮。** 两阶段：`plan()` 只读出清单，`execute()` 必须带
 *   `{ confirm: 'forget' }`。没有令牌的删除入口，迟早会被某个循环顺手调用一次。
 * - **不报「已清干净」当只删了一半。** 任何一面失败、或本该删的却跳过了，
 *   `complete` 就是 `false`。被遗忘权只有全对与没做到两种结果，
 *   中间那档叫「还以为删干净了」。
 * - **不直连任何数据表、不自己删文件。** 每一面只调上游公开方法。
 *   日记删不掉、图边数不出来，就如实写进「已知限制」——
 *   绕过服务边界一次，边界就再也说不清了。
 * - **不自动清台词库。** `lexicon` 只有整份 `reset()`，会连带清掉别人说的话，
 *   必须由人当次点名开 `clear-lexicon`。
 * - **不做界面。** L8 界面 14 个插件已整批下线，渲染归应用外壳（`desktop/`）。
 *   本插件只交 `ForgetPlan` / `ForgetRun` / `ResidueReport` 三份结构化数据。
 *
 * ## 依赖纪律
 *
 * 十一面全部是软依赖，故刻意不声明插件级 `inject`：
 * 缺哪一面就少清一面并在计划里点名，其余照常。
 * 唯一例外是执行期：`ondra-memory-core` 不在位时 `execute()` 抛 `no-core`——
 * **正文真源都删不了，这次「忘记」没有意义**，不该假装成功。
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
import type { Config as ForgetConfig } from './settings.js'
import { ForgetRight } from './service.js'
import { FORGET_RIGHT_SERVICE_KEY } from './types.js'
import type {
  AuditLike,
  CapsuleLike,
  ClockLike,
  ConfigSchemaLike,
  DiaryLike,
  ForgetRightService,
  GraphLike,
  IdentityLike,
  LexiconLike,
  LogLike,
  MemoryCoreLike,
  NarrativeLogLike,
  ProspectiveLike,
  SnapshotLike,
  VectorLike,
} from './types.js'

export type * from './types.js'
export {
  FORGET_RIGHT_SERVICE_KEY,
  SURFACE_IDS,
  SURFACE_SPECS,
  CAPABILITIES,
  SCRUB_STATUSES,
  SCRUB_ORDER,
  TARGET_KINDS,
  FORGET_ERROR_CODES,
  ForgetRightError,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  CONFIG_SECTION,
  completeConfig,
} from './settings.js'
export {
  MAX_TARGETS,
  MAX_REASON_CHARS,
  normalizeTarget,
  idsOf,
  isSubjectKind,
  effectiveCapability,
  intentOf,
  blockedBecauseOf,
  planScrubs,
  planSummaryOf,
  warningOf,
  residueSummaryOf,
  residueReportOf,
  residueRowOf,
  buildPlan,
  keyCompliant,
  SPEC_IDS,
  SURFACE_COUNT,
} from './plan.js'
export {
  MAX_VALUE_CHARS,
  resolveTarget,
  dedupe,
  assertTarget,
  outcomeOf,
  specOf,
  isComplete,
  residueOf,
  runSummaryOf,
  expectedSurfacesOf,
} from './scrub.js'
export { ForgetRight } from './service.js'
export type { ForgetRightDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-forget-right'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-forget-right: 注册配置段')
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
    /** 被遗忘权服务；未装载本插件时为 undefined。 */
    'ondra-forget-right'?: ForgetRightService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：十一面全软（见文件头）。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: ForgetConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('forget-right') : 'ondra.forget-right')

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

  // 2. 补全。任何非法值都回退默认，绝不抛。
  const settings = completeConfig(effective)

  // 3. 依赖全部用取值函数：上游晚装载时能自愈，早卸载时立刻反映。
  const service = new ForgetRight({
    settings,
    log,
    core: () => ctx.get('ondra-memory-core') as MemoryCoreLike | undefined,
    audit: () => ctx.get('ondra-memory-audit') as AuditLike | undefined,
    graph: () => ctx.get('ondra-memory-graph') as GraphLike | undefined,
    vector: () => ctx.get('ondra-memory-vector') as VectorLike | undefined,
    prospective: () => ctx.get('ondra-memory-prospective') as ProspectiveLike | undefined,
    capsule: () => ctx.get('ondra-time-capsule') as CapsuleLike | undefined,
    lexicon: () => ctx.get('ondra-lexicon') as LexiconLike | undefined,
    diary: () => ctx.get('ondra-diary') as DiaryLike | undefined,
    narrative: () => ctx.get('ondra-narrative-log') as NarrativeLogLike | undefined,
    snapshot: () => ctx.get('ondra-snapshot') as SnapshotLike | undefined,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(
    () => ctx.provide(FORGET_RIGHT_SERVICE_KEY, service),
    'ondra-forget-right: 注册被遗忘权服务',
  )

  // 4. 报一次现状。缺哪些面必须能被自检读到，不许黑箱。
  //    刻意**不在 apply 里出计划**：装载期上游可能还没就绪，那时出的计划会漏面。
  log.info('被遗忘权就绪：%s（十一面清算，两阶段删除）', service.available ? '可用' : '不可用')
  const absent: string[] = []
  if (ctx.get('ondra-memory-core') === undefined) absent.push('记忆正文（真源，执行会被拒）')
  if (ctx.get('ondra-memory-audit') === undefined) absent.push('记忆钉子（改走 O-010 单删）')
  if (ctx.get('ondra-memory-graph') === undefined) absent.push('图边（这一面动不了）')
  if (ctx.get('ondra-memory-vector') === undefined) absent.push('向量索引（没装就没有这一面）')
  if (ctx.get('ondra-memory-prospective') === undefined) absent.push('待办与承诺')
  if (ctx.get('ondra-time-capsule') === undefined) absent.push('时间胶囊')
  if (ctx.get('ondra-lexicon') === undefined) absent.push('语感样本')
  if (ctx.get('ondra-diary') === undefined) absent.push('日记（本来就删不掉）')
  if (ctx.get('ondra-narrative-log') === undefined) absent.push('叙事日志（本来就删不掉）')
  if (ctx.get('ondra-snapshot') === undefined) absent.push('快照（本来就只读）')
  if (absent.length > 0) {
    log.info('以下上游未装载，对应面会报「动不了」而不是假装清过：%s', absent.join('；'))
  }
  if (!settings.enable) {
    log.warn('被遗忘权已关闭（enable=false）：服务照常注册，plan() / execute() 一律抛 disabled')
  }
  if (settings.clearLexicon) {
    // 这条要说得重一点：它是唯一会「顺手动别人的东西」的开关。
    log.warn(
      'clear-lexicon 已开启：lexicon 面会整份清空语感样本（包括别人说的话），且上限只有整份清',
    )
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。五个字段都能安全补全，
 * 因此永远不产 issue——配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: ForgetConfig } | { readonly issues: readonly { readonly message: string }[] }
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
