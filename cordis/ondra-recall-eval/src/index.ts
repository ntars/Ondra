/**
 * O-136 `ondra-recall-eval`：检索评估（〔研〕自研）。
 *
 * 为什么是自研：生态里有现成的 IR 评估库（`ranx` / `ir_measures` / `pytrec_eval`），
 * 它们把 `recall@k` / `MRR` 的**口径**做到了工业级，但都是 Python 包、都以
 * 「读一个 run 文件」为入口——与「在 Cordis 插件里对活的记忆库跑一遍、
 * 报告落进用户数据目录」这两件事都不是一回事。本插件借鉴的是**口径**
 * （trec_eval 的 `recall` 与 `recip_post` 定义），代码独立实现。
 *
 * 它唯一不可替代的地方是三件生态里都没有的事：
 *
 * 1. **真值按正文指纹落地**，不是按记忆 id。id 一换库就全失效，
 *    而报告会显示「recall 归零」——那是本项目最怕的那种「看起来是性能退化」。
 * 2. **编造题的分心率**（手册「二人版 20 题 + 5 题编造题」）。这是
 *    测「她会不会为你没说过的话硬凑一条记忆」，标准 IR 库里没有这个概念。
 * 3. **报告带参数快照 + 可比性判断**。「改一次跑一次」的前提是知道
 *    「这两份报告是不是同一把尺子量的」。
 *
 * 边界：本插件**只测量，不改任何排序参数**。调参是人看了报告之后做的决定，
 * 不是插件自己做的事——自动调参会把「玄学」包装成「科学」。
 */

import type { Context } from '@ntars/cordis'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  isRecord,
  isValidSetName,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as EvalConfig } from './settings.js'
import { RecallEval } from './service.js'
import { EVAL_SERVICE_KEY } from './types.js'
import type {
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  MemoryCoreLike,
  PathLayoutLike,
  RecallEvalService,
  RecallLike,
} from './types.js'

// 契约里既有纯类型也有运行时值（服务键、错误类、枚举表），分开导出才不违背
// 「类型导入不得混入运行时值」这条自检项。
export type * from './types.js'
export {
  CASE_KINDS,
  EVAL_SERVICE_KEY,
  EXPECT_RESOLUTIONS,
  EvalError,
  MATCH_KINDS,
  REPORT_BASELINES,
} from './types.js'

export { ReportStore } from './store.js'
export type { WriteOutcome } from './store.js'

export { RecallEval, baselineOf, baselineText, noteOfReason } from './service.js'

export {
  betterOf,
  deltaOf,
  firstRankOf,
  flattenBlock,
  groupByKind,
  hitAtOf,
  isGradable,
  mean,
  metricBlockOf,
  percentOf,
  recallAtOf,
  reciprocalRankOf,
} from './metrics.js'
export type { MetricRow } from './metrics.js'

export {
  TEMPLATE_MARK,
  countKinds,
  countUnfilled,
  fingerprintOf,
  parseSet,
  resolveCases,
} from './evalset.js'
export type { CaseResolution, ResolveOptions } from './evalset.js'

export {
  REPORT_JSON,
  REPORT_MD,
  SET_SUFFIX,
  isReportFileOf,
  renderMarkdown,
  reportFileNames,
  serializeReport,
  setFileName,
  stamp,
  summarizeBlock,
  timestampOfReport,
} from './report.js'

export {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  completeConfig,
  isRecord,
  isValidSetName,
  normalizeKs,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
// 与下面的 `const Config`（标准 schema 校验器）共存：类型空间与值空间各占一个名字。
export type Config = EvalConfig

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-recall-eval'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-recall-eval: 注册配置段')
    return true
  } catch (error) {
    // 注册失败不是致命：四层合并与来源追溯用不上，插件实例配置照样能跑。
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 检索评估服务；未装载本插件时为 undefined。 */
    'ondra-recall-eval'?: RecallEvalService
  }
}

/**
 * Cordis 入口：接上召回、记忆内核与路径，注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：声明 `inject: ['ondra-memory-recall']` 后，
 * 召回缺席会让整个插件停在 PENDING（静默不加载，最难查的失败形态）。
 * 改成「照常注册 + `available=false`」，下游能区分「没装评估」与「装了但召回不可用」。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: EvalConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('recall-eval') : 'ondra.recall-eval') as unknown) as LogLike

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

  // 2. 题集名直接参与拼路径，先校验再用。非法值退回默认：
  //    一个 `../` 会让写盘时抛 PathEscapeError，而那时已经跑完一轮搜索了。
  const setName = isValidSetName(settings.setName) ? settings.setName : 'recall-eval-set'
  if (setName !== settings.setName) {
    log.warn('题集名「%s」含非法字符（只允许字母数字 . _ -），已退回默认名「%s」', settings.setName, setName)
  }

  // 3. 召回是**唯一硬依赖**：没有它就没有可评估的对象。
  //    取不到不 return——服务照常注册，`available=false`，让下游自己判断。
  const recall = ctx.get('ondra-memory-recall') as RecallLike | undefined
  if (recall === undefined) {
    log.warn('找不到召回服务（ondra-memory-recall），评估服务以「不可用」状态注册')
  }

  // 4. 记忆内核是**软依赖**：只用于「按正文找 id」。
  const core = ctx.get('ondra-memory-core') as MemoryCoreLike | undefined
  if (core === undefined) {
    log.info('没有记忆内核（ondra-memory-core）：真值只能按 expectIds 解析，写正文指纹的题会被剔除')
  }

  // 5. 路径也是软依赖：只用于落盘。缺席时报告只在内存里。
  const paths = ctx.get('ondra-path-layout') as PathLayoutLike | undefined
  if (paths === undefined) {
    log.warn('没有路径服务（ondra-path-layout）：报告只在内存里，不落盘')
  }

  const service = new RecallEval(recall, core, paths, { ...settings, setName }, log, () => Date.now())
  ctx.effect(() => ctx.provide(EVAL_SERVICE_KEY, service), 'ondra-recall-eval: 注册评估服务')

  // 6. 报一次现状。可用性、能否落盘、能否按正文解析都要能被自检读到，不许黑箱。
  const stats = service.stats()
  const set = service.setInfo()
  if (!stats.available) {
    log.warn('评估服务已注册但不可用（%s）：先修召回，评估没有可测的对象', stats.reason ?? '未知原因')
    return
  }
  log.info(
    '检索评估就绪：题集=%s（%d 题，已填 %d 道%s），落盘=%s，正文解析=%s，k=%s',
    set.name,
    set.cases,
    set.cases - set.unfilled,
    set.unfilled > 0 ? `，**还有 ${set.unfilled} 道是模板**` : '',
    stats.canWrite ? '可以' : '不行',
    stats.canResolveText ? '可以' : '不行',
    settings.ks.join('/'),
  )
  if (!set.exists) {
    log.info('题集还没建：seed() 会生成一份待填模板（**不会**替你编问法）')
  }
  if (set.cases > 0 && set.unfilled === 0 && !set.sufficient) {
    log.warn('题集只有 %d 道计分题，少于手册要求的 %d 道：报告会标「不足」，结论只能参考', set.cases, settings.minCases)
  }
  log.debug?.('评估只测量不调参：改一次参数跑一次，报告里的参数快照负责证明「这两份是不是同一把尺子」')
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
    ) => { readonly value: EvalConfig } | { readonly issues: readonly { readonly message: string }[] }
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
