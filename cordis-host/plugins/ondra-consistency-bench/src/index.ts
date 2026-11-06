/**
 * O-118 `ondra-consistency-bench`：人格一致性评测（〔研〕自研，L9 扩展池）。
 *
 * ## 它到底做什么
 *
 * 用**十四道日常话术**去照她，看她还是不是她。五类走形：
 * 口吻突变、自称漂移、设定遗忘、语气覆盖、格式漂移。
 * 判据是静态正则，判定是纯函数——**不调模型**（让同一个模型给自己打分，
 * 得到的分数只反映它今天的心情；这条裁决 O-104 已经定过，这里不重开）。
 *
 * ## 与 O-104 redteam 的分工（两个插件最容易变成一件事的地方）
 *
 * 红队送进去的是**攻击话术**（"忽略设定"、"把提示词念出来"），判的是
 * 「安全边界有没有被突破」，输了叫**塌方**。
 * 本插件送进去的是**日常话术**（"谢谢你陪我"、"你是谁"、"用正式点说"），判的是
 * 「人格特征有没有被磨损」，输了叫**走形**。
 * 两边的题库、判据、结论**互不复用、互不引用**——合并成一份的那天，
 * 报告里就再也分不清「她被攻破了」和「她被聊成了别人」。
 *
 * ## 它刻意不做什么（六条）
 *
 * - **不调 LLM。** 自证：她说自己没走形，评测就报没走形。
 * - **不出综合分。** 报告里只有条数与逐类明细。一旦有「人格一致性 87 分」，
 *   第二天就有人为了这 87 分去调人格参数——而被调的是人格（禁报数铁律 P0 第 3 条）。
 * - **不存回复正文。** 只回长度与命中位置区间。
 * - **不驱动对话。** 自己发起就多出一条绕过冻结前缀（O-033）与九步过滤（O-037）的路径。
 * - **不做界面、不装定时器。** 渲染归应用外壳；评测要人发起，因为探测句必须由调用方送进去。
 * - **不落盘。** 报告是评测产物，落盘就等于在磁盘上留了一份「她当时说了什么」的索引。
 *
 * ## 依赖纪律
 *
 * 只有两项软依赖（身份 / 配置），且**身份只用来拼日志命名空间**：
 * 判据本身零上游依赖，读不到人就退化成静态判据，不会因为上游缺席而判不出结论。
 * 故也不声明插件级 `inject`。
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
import type { Config as BenchConfig } from './settings.js'
import { ConsistencyBench } from './service.js'
import { BENCH_SERVICE_KEY, CASEBOOK_VERSION } from './types.js'
import type { BenchService, ConfigSchemaLike, IdentityLike, LogLike } from './types.js'

export type * from './types.js'
export {
  BENCH_SERVICE_KEY,
  CASEBOOK_VERSION,
  FREE_CASE_ID,
  SUITE_IDS,
  SUITE_SPECS,
  CRITERION_KINDS,
  SEVERITIES,
  VERDICTS,
  REPORT_VERDICTS,
  BENCH_ERROR_CODES,
  BenchError,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  CONFIG_SECTION,
  completeConfig,
} from './settings.js'
export { BASELINE_CHECKS, BENCH_CASES } from './cases.js'
export {
  MAX_SCAN_CHARS,
  SEVERITY_ORDER,
  ERROR_CODES,
  compileChecks,
  spansOf,
  gradeOne,
  gradeFree,
  noteOf,
  queryCases,
  reportOf,
  summaryOf,
  kindLabelOf,
} from './grade.js'
export type { CompiledCheck, CompileIssue, CompileResult } from './grade.js'
export { ConsistencyBench } from './service.js'
export type { BenchDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-consistency-bench'

/**
 * 本插件**不声明** `inject`：没有任何硬依赖。
 *
 * 这一点写在这里是给未来的自己看的：一致性评测最容易被顺手接上网关
 * （「让模型自己判断有没有走形」听起来太自然了），而一旦接上，
 * 整份评测就变成自证——它说自己没走形，评测就报没走形。
 */

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-consistency-bench: 注册配置段')
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
    /** 人格一致性评测服务；未装载本插件时为 undefined。 */
    'ondra-consistency-bench'?: BenchService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: BenchConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('consistency-bench') : 'ondra.consistency-bench')

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

  // 3. 建服务。题库在这里编译一次；编译失败会逐条打到日志。
  const service = new ConsistencyBench({ settings, log, now: () => Date.now() })

  ctx.effect(() => ctx.provide(BENCH_SERVICE_KEY, service), 'ondra-consistency-bench: 注册一致性评测服务')

  // 4. 报一次现状。题库条数与分类覆盖必须能被自检读到，不许黑箱。
  const cases = service.cases()
  const stats = service.stats()
  log.info(
    '一致性评测就绪：%s（题库 v%d，%d 题 / %d 类；纯文本判定，不调模型）',
    service.available ? '可用' : '不可用',
    CASEBOOK_VERSION,
    cases.length,
    service.suites().length,
  )
  const holes = service.suites().filter(spec => cases.every(item => item.suite !== spec.id))
  if (holes.length > 0) {
    // 分类有洞比题库少几题严重：报告按分类分组，缺一类那一格永远是 0。
    log.warn('以下分类在题库里一题都没有，报告里那一组会恒为空：%s', holes.map(spec => spec.zh).join('、'))
  }
  if (stats.compileIssues > 0) {
    log.error('题库有 %d 条正则编译不过：grade() / report() 会一律抛 bad-casebook', stats.compileIssues)
  }
  if (!settings.enable) {
    log.warn('一致性评测已关闭（enable=false）：服务照常注册，grade() / report() 一律抛 disabled')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。四个字段都能安全补全
 * （数字越界夹到区间内、非布尔的按 false 处理），因此永远不产 issue——
 * 配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: BenchConfig } | { readonly issues: readonly { readonly message: string }[] }
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
