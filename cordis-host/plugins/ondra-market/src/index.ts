/**
 * O-078 `ondra-market`：**只接线的封闭市场**。档位〔复〕。
 *
 * ## 为什么这个包几乎没有「市场逻辑」
 *
 * 手册 §1.7 把市场放进〔复〕：「插件市场（`ondra-market`）」。动手前按能力查了上游
 * （不是按依赖名查）：`desktop/packages/boot/plugin-market` 提供 `pluginMarket` 服务，
 * 有 `listIndexes()` / `search(url, query)` / `entry(url, name)` 三个方法，
 * 索引格式在 `desktop/packages/util/plugin-market-index`（format 1，带校验与相对图标解析）。
 * 也就是说「读索引、模糊匹配、挑默认版本、判 `engines.ondra` 兼容性」上游全做了。
 *
 * 能复用却自研 = 违规。所以本包**一行索引解析都不写**。
 *
 * ## 那它到底做什么
 *
 * 三件上游不做、而手册要的事：
 *
 * 1. **封闭**（手册 §7.4-⑩：「与 `ondra-market` 同型但封闭——只显示认可的插件，
 *    也支持用户上传自定义」）。上游是开放索引，没有白名单概念。
 * 2. **只读**（master-plan §5：「组合包清单，**只读**」）。本包不装、不卸、不改索引源：
 *    连上游的 `setIndexes()` 都不调——改索引源是用户动作。
 * 3. **安装方案**（master-plan §9.11：「安装依赖 snapshot 还原点」）。本包只算
 *    「装什么、装之前必须先有什么」，落盘归 O-079，还原点归 O-009。
 *
 * ## 上游缺席时它不死
 *
 * `pluginMarket` 是宿主键，不是每个环境都有。没有它时：
 * 服务**照常注册**，`status().reason` 报 `no-market`，本地认可清单（`allowList()`）
 * 仍可读，`plan()` 返回 `blocked: 'no-market'`。
 * 「服务不注册」会让消费方分不清「没装」与「装了但上游不在」——前者要提示安装，
 * 后者要提示配置索引源，两种话术完全不同。
 */

import type { Context } from '@ntars/cordis'
import { Market } from './service.js'
import { ApprovalStore } from './store.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as Settings } from './settings.js'
import { MARKET_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  MarketHostLike,
  MarketService,
  PathLayoutLike,
} from './types.js'

export type * from './types.js'
export {
  MARKET_SERVICE_KEY,
  MARKET_MODES,
  SORT_KINDS,
  NAME_RE,
} from './types.js'
export {
  APPROVED_FILE,
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_BUILTIN,
  DEFAULT_CONFIG,
  DEFAULT_MAX_INDEXES,
  DEFAULT_PAGE_SIZE,
  FIELD_SPECS,
  MAX_PAGE_SIZE,
  SECTION_KEYS,
  completeConfig,
  configDriftOf,
  isPackageName,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
export { installSpecOf, latestVersionOf, pickText, toCatalog } from './normalize.js'
export type { NormalizeOptions } from './normalize.js'
export { ApprovalStore } from './store.js'
export type { LoadResult, StoredApproval } from './store.js'
export { Market } from './service.js'
export type { MarketDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-market'

/**
 * 把异常折成一句文本。
 * @param error 异常。
 */
function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 向 O-005 注册配置段。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-market: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', textOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 封闭市场（认可清单 + 上游接线）；未装载本插件时为 undefined。 */
    'ondra-market'?: MarketService
  }
}

/**
 * Cordis 入口：解析配置、接上游、装存储、注册服务。**不建定时器、不抓网络**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  // 日志命名空间 `ondra.market`（前缀由 O-001 给）。
  const log = ctx.logger(identity ? identity.loggerName('market') : 'ondra.market')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  // 1. 配置：有 O-005 就走四层合并。
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  const onBad = (text: string, kind: string): void => {
    log.warn('配置条目已丢弃（%s）：%s', kind, text)
  }
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
      log.warn('解析配置段失败，退回插件实例配置：%s', textOf(error))
    }
  }
  const settings = completeConfig(effective, onBad)

  // 2. 认可清单：有 O-002 才落盘，否则只在内存（`status().store` 会如实报 `memory`）。
  const layout = ctx.get('ondra-path-layout') as PathLayoutLike | undefined
  const store = new ApprovalStore(layout ?? null, log, settings.persist)
  store.load()
  if (store.corrupt) {
    log.warn('认可清单解析失败，已按空清单处理（不猜字段）：%s', store.path ?? '（内存）')
  }

  // 3. 上游：宿主键 `pluginMarket`。缺席不是错误，是常态（没装市场插件）。
  const host = (ctx.get('pluginMarket') as MarketHostLike | undefined) ?? null

  // 4. 时刻：每次现取（O-003 缺席就用本机时间）。
  const now = (): number => {
    const clock = ctx.get('ondra-clock') as ClockLike | undefined
    return clock === undefined ? Date.now() : clock.now()
  }

  const service = new Market({ settings: () => settings, log, now, store, host })

  // 5. 注册服务（经 `ctx.effect`，卸载即撤销）。
  ctx.effect(
    () => {
      const dispose = ctx.provide(MARKET_SERVICE_KEY, service)
      return () => {
        service.dispose()
        dispose()
      }
    },
    'ondra-market: 注册市场服务',
  )

  // 6. 报一次现状。**只报，不拦**。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被夹紧或丢弃（与你设的不一样）：%s', drift.join(' / '))
  }

  const allow = service.allowList()
  if (!settings.enable) {
    log.info('市场关着：不查上游（本地认可清单 %d 条仍可读）', allow.length)
    return
  }
  if (host === null) {
    log.warn('没接上游市场服务（`pluginMarket`）：只出本地认可清单，查不了索引')
    return
  }
  const indexes = service.status().indexes
  if (indexes === 0) {
    log.warn('上游没配索引源：查不到任何条目（在市场的设置里填一个索引 URL）')
    return
  }
  log.info(
    '市场就绪（%s）：索引 %d 个，认可 %d 条（内置 %d + 自定义 %d）',
    settings.mode === 'closed' ? '封闭' : '开放',
    indexes,
    allow.length,
    allow.filter(item => item.origin === 'builtin').length,
    allow.filter(item => item.origin === 'user').length,
  )
  if (settings.mode === 'closed' && allow.length === 0) {
    log.warn('封闭市场的认可清单是空的：一条都不会显示。请改配置 `builtin` 或调用 `approve()`')
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
    ) => { readonly value: Settings } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能安全补全（越界夹紧、坏条目丢弃并计数），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
