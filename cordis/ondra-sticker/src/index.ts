/**
 * O-053 `ondra-sticker`：贴纸包的读取与分发。目录即索引，文件名即标签。
 *
 * ## 装载期做四件事
 *
 * 1. 解析配置（有 O-005 就走四层合并，没有就用本地校验）；
 * 2. 建默认根下的三个目录（`createDirs`），让用户马上有地方丢图；
 * 3. `provide` 服务；
 * 4. 打一行现状：贴纸根在哪、扫到几个包、同义表有没有两级跳。
 *
 * **不在装载期建索引**：装载时人设可能还没定、路径服务可能还没起，
 * 那时扫出来的「零张图」会被缓存成结论（与 O-049 / O-051 同一条纪律）。
 * 索引在第一次 `pick()` / `packs()` 时懒建。
 *
 * ## 刻意不声明插件级 `inject`
 *
 * `ondra-path-layout` 与 `ondra-persona-core` 全软：
 * 没有路径服务还能用 `rootOverride`；没有人设服务就只用共享包与内置包。
 * 声明 `inject` 会让缺一个就整包停 PENDING，而"为什么取不到图"
 * 恰恰要靠这个插件活着才能被看见。
 *
 * ## 刻意不注册工具
 *
 * 做成工具，模型就能自己挑一张图发出去——贴纸是**表达**，不是**工具**。
 * 手册 §4.2 的「贴纸触发最小间隔 3 条」在 O-040 的 `stickerGate()`，
 * 概率档在 O-031 的 `stickerChance`。本插件只回答「这个标签有哪些图、
 * 下一张是哪张」，什么时候发不归它管。
 */

import type { Context } from '@ntars/cordis'
import { nodeFs } from './fs.js'
import { StickerStore } from './service.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as StickerConfig } from './settings.js'
import { aliasIssues, buildAliasTable } from './tags.js'
import { NAME_RE, STICKER_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  PathLayoutLike,
  PersonaCoreLike,
  StickerService,
} from './types.js'

export type * from './types.js'
export { STICKER_SERVICE_KEY, NAME_RE, FORMATS } from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  SEGMENT_RE,
  CACHE_TTL_CEIL,
  completeConfig,
  configDriftOf,
} from './settings.js'
export {
  ALIAS_SEEDS,
  TAG_MAX,
  aliasIssues,
  baseOf,
  buildAliasTable,
  canonicalOf,
  formatOf,
  orderOf,
  rawTagOf,
  tagKey,
} from './tags.js'
export { joinPath } from './fs.js'
export { nodeFs }
export { scanDir, packFromFiles } from './scan.js'
export type { ScanDeps, ScannedPack } from './scan.js'
export { StickerStore } from './service.js'
export type { StoreDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-sticker'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-sticker: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 贴纸服务；未装载本插件时为 undefined。 */
    'ondra-sticker'?: StickerService
  }
}

/**
 * Cordis 入口：解析配置、注册服务、报一次现状。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: StickerConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('sticker') : 'ondra.sticker')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  // 1. 有 O-005 就让配置走四层合并。
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

  // 2. 补全 + 校验。任何非法值都回退默认，绝不抛。
  const settings = completeConfig(effective)

  const store = new StickerStore({
    settings,
    log,
    now: () => {
      const live = ctx.get('ondra-clock') as ClockLike | undefined
      return live === undefined ? Date.now() : live.now()
    },
    fs: nodeFs,
    pathLayout: () => ctx.get('ondra-path-layout') as PathLayoutLike | undefined,
    persona: () => ctx.get('ondra-persona-core') as PersonaCoreLike | undefined,
  })

  ctx.effect(() => ctx.provide(STICKER_SERVICE_KEY, store), 'ondra-sticker: 注册贴纸服务')

  // 3. 建目录。失败只告警：用户可能就打算用 rootOverride 指的地方。
  const made = store.prepare()

  // 4. 报一次现状。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值越界已回退（%s）：路径或缓存时长与你设的不一样', drift.join(' / '))
  }

  if (!settings.enable) {
    log.warn('贴纸已关闭（enable=false）：pick() 一律 disabled，服务照常注册')
  } else {
    const root =
      settings.rootOverride !== ''
        ? settings.rootOverride
        : 'user/' + settings.userSubdir + '（经 ondra-path-layout 解析）'
    log.info(
      '贴纸就绪：根 %s · 缓存 %dms · 同义归一 %s · 本次建了 %d 个目录',
      root,
      settings.cacheTtlMs,
      settings.normalizeTags ? '开' : '关',
      made,
    )
  }

  // 同义表自检：两级跳会让"一次归一"与"两次归一"得到不同结果。
  const issues = aliasIssues(buildAliasTable())
  if (issues.length > 0) {
    log.warn('同义标签表自检发现 %d 个问题：%s', issues.length, issues.join(' / '))
  }

  // 「此刻」的上游。后装载是正常的，因此只用 info。
  if (ctx.get('ondra-path-layout') === undefined) {
    log.info('此刻没有 ondra-path-layout：只能用 rootOverride 指一个绝对路径（装好之后自动恢复）')
  }
  if (ctx.get('ondra-persona-core') === undefined) {
    log.info('此刻没有 ondra-persona-core：只扫共享包与内置包，人设专属贴纸不参与')
  }
  if (!NAME_RE.test(name)) {
    log.error('插件名不合规（%s）：服务键会被模型侧拒绝', name)
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
    ) => { readonly value: StickerConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能被安全补全（目录名与绝对路径都做了校验、非法即回退），
      // 因此永远不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
