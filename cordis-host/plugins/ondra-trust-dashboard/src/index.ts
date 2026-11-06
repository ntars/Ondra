/**
 * O-102 `ondra-trust-dashboard`：信任读数（〔研〕自研，L9 扩展池）。
 *
 * ## 它到底做什么
 *
 * 把「她有多信你」这件事拆成**几项可核对的读数**，每一项都标出「取自哪个服务的哪个字段」，
 * 读不到的项老老实实显示「读不到」，**不用 0 顶替**。
 *
 * ## 它刻意不做什么（五条）
 *
 * - **不自己算一个信任分。** 名字里有「仪表盘」，最容易犯的错就是新编一个 0–100 分。
 *   那会立刻多出三个真源（关系四维 / 记忆规模 / 承诺履约），而三处读数迟早漂开，
 *   界面上两处都说得通。故每一项都是上游读数的**投影**，并强制带 `sources`。
 * - **不做界面。** L8 界面 14 个插件已整批下线，渲染归应用外壳（`desktop/`）。
 *   本插件只交 `TrustBoard` 结构化数据。
 * - **不写任何上游。** 契约里**连 `adjust()` 都不镜像**：只读插件落到代码上，
 *   就是接口里根本没有那条路——比文档里写「请勿调用」有效。
 * - **不用 0 顶替缺失值。** 上游缺席给 0，界面会显示「信任 0%」，
 *   用户读到的是「她一点都不信我」，而真相是「这个数这会儿算不出来」。
 * - **不报比例、不评价、不鼓励。** 「信任 68%，继续加油」会被当成评分系统，然后开始刷分。
 *   总结只说「读到几项、缺了谁、哪一项最低」。
 *
 * ## 依赖纪律
 *
 * 五项依赖（关系 / 承诺 / 记忆 / 审计 / 时钟）**全是软依赖**，故刻意不声明插件级 `inject`：
 * 缺哪一项就少读一项并在 `missing` 里点名，其余照常出表。
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
import type { Config as TrustConfig } from './settings.js'
import { TrustDashboard } from './service.js'
import { TRUST_DASHBOARD_SERVICE_KEY } from './types.js'
import type {
  AuditLike,
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  MemoryCoreLike,
  ProspectiveLike,
  StageLike,
  TrustDashboardService,
} from './types.js'

export type * from './types.js'
export {
  TRUST_DASHBOARD_SERVICE_KEY,
  READING_IDS,
  READING_STATES,
  STATE_CUTS,
  READING_SPECS,
  TRUST_ERROR_CODES,
  TrustError,
} from './types.js'
export { CONFIG_SECTION_ID, DEFAULT_CONFIG, FIELD_SPECS, SECTION_KEYS, CONFIG_SECTION, completeConfig } from './settings.js'
export {
  ratioOf,
  countOf,
  stateOf,
  sourceOf,
  relationReadingOf,
  promiseReadingOf,
  memoryReadingOf,
  summaryOf,
} from './readings.js'
export { TrustDashboard } from './service.js'
export type { TrustDashboardDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-trust-dashboard'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-trust-dashboard: 注册配置段')
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
    /** 信任读数服务；未装载本插件时为 undefined。 */
    'ondra-trust-dashboard'?: TrustDashboardService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：五项依赖全软（见文件头）。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: TrustConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('trust-dashboard') : 'ondra.trust-dashboard')

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
  const dashboard = new TrustDashboard({
    settings,
    log,
    stage: () => ctx.get('ondra-emotion-stage') as StageLike | undefined,
    prospective: () => ctx.get('ondra-memory-prospective') as ProspectiveLike | undefined,
    core: () => ctx.get('ondra-memory-core') as MemoryCoreLike | undefined,
    audit: () => ctx.get('ondra-memory-audit') as AuditLike | undefined,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(() => ctx.provide(TRUST_DASHBOARD_SERVICE_KEY, dashboard), 'ondra-trust-dashboard: 注册信任读数服务')

  // 4. 报一次现状。可用性与依赖到位情况都要能被自检读到，不许黑箱。
  //    刻意**不在 apply 里出表**：装载期上游可能还没就绪，那时出表会得到一张全是「读不到」的表。
  log.info('信任读数就绪：%s（只读投影，不自算分数）', dashboard.available ? '可用' : `不可用（${dashboard.reason ?? '未知'}）`)
  const absent: string[] = []
  if (ctx.get('ondra-emotion-stage') === undefined) absent.push('关系（信任/亲密/熟悉三项读不到）')
  if (ctx.get('ondra-memory-prospective') === undefined) absent.push('承诺（履约率读不到）')
  if (ctx.get('ondra-memory-core') === undefined) absent.push('记忆（存量读不到）')
  if (ctx.get('ondra-memory-audit') === undefined) absent.push('审计（钉子数读不到，存量照出）')
  if (absent.length > 0) {
    log.info('以下上游未装载，对应读数会显示为「读不到」而不是 0：%s', absent.join('；'))
  }
  if (!settings.enable) {
    log.warn('信任读数已关闭（enable=false）：服务照常注册，board() 一律抛 disabled')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。三个字段都能安全补全，
 * 因此永远不产 issue——配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: TrustConfig } | { readonly issues: readonly { readonly message: string }[] }
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
