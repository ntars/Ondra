/**
 * O-100 `ondra-memory-heal`：记忆自愈（〔研〕自研，L9 扩展池）。
 *
 * ## 它到底做什么
 *
 * 把「记忆库有没有留下不该留的东西」变成一份**可核对的清单**，并把每一项分成三档：
 *
 * - `auto`：无损可修（清悬空钉子）；
 * - `confirm`：不可逆，必须人点名（墓碑泄漏的再忘一次）；
 * - `advise`：本插件修不了，写清归谁。
 *
 * ## 它刻意不做什么（四条）
 *
 * - **不做后台常驻自愈。** 插件形态只允许 `apply(ctx)`，且 §17 不做常驻服务。
 *   巡检由人按需触发（体检面板的按钮），修不修、修哪几项也由人定。
 * - **不做自动修复。** `apply()` 必须传 `{ confirm: 'repair' }`。
 *   少这道闸，「自愈」就变成了「无人复核地改记忆库」。
 * - **不越权修别人的活。** 摘要重写归 O-019/O-035，合并归 O-012，沉底归 O-010 的批量口。
 *   这三类全部落在 `advise` 档，且 `plan()` 里 `planned` 恒为 `false`。
 * - **不直连表。** 所有修复经 O-017 的 `unpin()` / `forget()` 公开方法。
 *   直连表会漏掉 O-017 额外做的两件事（清钉子、清孤儿边）。
 *
 * ## 依赖纪律
 *
 * 三项依赖**全是软依赖**，故刻意不声明插件级 `inject`：
 * 缺记忆内核 → `available=false`、`reason='no-core'`；
 * 缺审计 → 少查三类并在 `missing` 里点名；
 * 缺判重 → 少查疑似重复。
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
import type { Config as HealConfig } from './settings.js'
import { MemoryHeal } from './service.js'
import { MEMORY_HEAL_SERVICE_KEY } from './types.js'
import type {
  AuditLike,
  ClockLike,
  ConfigSchemaLike,
  DedupeLike,
  IdentityLike,
  LogLike,
  MemoryCoreLike,
  MemoryHealService,
} from './types.js'

export type * from './types.js'
export {
  MEMORY_HEAL_SERVICE_KEY,
  REPAIR_TIERS,
  FINDING_CODES,
  FINDING_SPECS,
  SUMMARY_MIN_CHARS,
  PIN_WARN_LIMIT,
  MAX_SCAN_ROWS,
  MAX_PINS,
  HealError,
} from './types.js'
export { CONFIG_SECTION_ID, DEFAULT_CONFIG, FIELD_SPECS, SECTION_KEYS, CONFIG_SECTION, completeConfig } from './settings.js'
export {
  danglingPinsOf,
  tombstoneLeaksOf,
  resurfaceGhostsOf,
  zeroStrengthOf,
  emptySummariesOf,
  duplicateGroupsOf,
  pinOverflowOf,
  settleFindings,
  countsOf,
  specZhOf,
} from './checks.js'
export { MemoryHeal } from './service.js'
export type { MemoryHealDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-memory-heal'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-memory-heal: 注册配置段')
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
    /** 记忆自愈服务；未装载本插件时为 undefined。 */
    'ondra-memory-heal'?: MemoryHealService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：三项依赖全软（见文件头）。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: HealConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('memory-heal') : 'ondra.memory-heal')

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
  const heal = new MemoryHeal({
    settings,
    log,
    core: () => ctx.get('ondra-memory-core') as MemoryCoreLike | undefined,
    audit: () => ctx.get('ondra-memory-audit') as AuditLike | undefined,
    dedupe: () => ctx.get('ondra-memory-dedupe') as DedupeLike | undefined,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(() => ctx.provide(MEMORY_HEAL_SERVICE_KEY, heal), 'ondra-memory-heal: 注册记忆自愈服务')

  // 4. 报一次现状。可用性与依赖到位情况都要能被自检读到，不许黑箱。
  //    刻意**不在 apply 里跑巡检**：装载期扫全库会拖慢启动，且那时上游可能还没就绪。
  log.info('记忆自愈就绪：%s（按需巡检，不做常驻自愈）', heal.available ? '可用' : `不可用（${heal.reason ?? '未知'}）`)
  if (ctx.get('ondra-memory-audit') === undefined) {
    log.info('审计服务未装载：悬空钉子、待曝光幽灵、钉子偏多三类检查将跳过，并在报告的 missing 里点名')
  }
  if (ctx.get('ondra-memory-dedupe') === undefined) {
    log.info('判重服务未装载：疑似重复检查将跳过（这一类本来也只报告不合并）')
  }
  if (!settings.enable) {
    log.warn('记忆自愈已关闭（enable=false）：服务照常注册，diagnose() 一律不可用')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。四个字段都能安全补全，
 * 因此永远不产 issue——配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: HealConfig } | { readonly issues: readonly { readonly message: string }[] }
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
