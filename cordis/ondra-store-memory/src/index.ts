/**
 * O-007 `ondra-store-memory`：内存兜底存储（〔研〕自研）。
 *
 * 存在理由只有一条（决策 92）：**SQLite 打不开时，主对话还能进行**。
 * 数据库文件损坏、卷不支持共享内存、Node 缺 `node:sqlite`——这些都会让 O-006
 * 干脆不注册服务；没有本插件，记忆域、情绪域、人格域会全部拿到 `undefined`，
 * 表现是「她失忆了，而且什么都不说」。
 *
 * 三条边界，写死在实现里：
 *
 * 1. **不持久化。** 进程退出即丢。这不是缺陷，是定位——`caps.persist = false`，
 *    界面与 O-077 据此显示「本次会话的临时记忆」。
 * 2. **不假装支持 SQL。** `caps.sql = false`，`raw` 恒为 `undefined`。
 *    记忆检索这类必须用 FTS5 的能力必须检查能力位后切分支，不许试探调用。
 * 3. **不静默淘汰。** 单表到上限就拒绝写入并抛错，不悄悄删最旧的行——
 *    悄悄删数据比写不进去糟得多。
 *
 * **不 import O-006 的源码**（§15.5）：契约靠 `src/types.ts` 的结构对位镜像，
 * 形状分叉时消费方那一行 `??` 赋值会立刻报类型错。
 */

import type { Context } from '@ntars/cordis'
import { MemoryStore } from './port.js'
import { STORE_MEMORY_SERVICE_KEY } from './types.js'
import type { StorePort } from './types.js'

export type * from './types.js'
export { STORE_MEMORY_SERVICE_KEY, StoreError, IDENT_RE } from './types.js'
export { MemoryStore } from './port.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-store-memory'

/** 配置项：全部有默认值。 */
export interface Config {
  /**
   * 是否注册本后端。默认 true。
   *
   * 关掉它 = 放弃兜底：SQLite 一挂，持久化相关能力全部拿不到服务。
   * 只有「确认环境里永远有可用 SQLite」时才建议关。
   */
  readonly enabled: boolean
  /**
   * 单表行数上限。默认 20000。到上限**拒绝写入**并抛 `constraint`，不淘汰旧行。
   */
  readonly maxRowsPerTable: number
  /**
   * 是否在装载时打一条「本后端是兜底、不持久化」的提醒。默认 true。
   * 关掉只是少一行日志，`stats().degraded` 仍然是 true。
   */
  readonly announceFallback: boolean
}

/** 默认配置。 */
const DEFAULT_CONFIG: Config = {
  enabled: true,
  maxRowsPerTable: 20000,
  announceFallback: true,
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 补全并夹紧配置。 */
function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const enabled = raw['enabled']
  const maxRows = raw['maxRowsPerTable']
  const announce = raw['announceFallback']
  return {
    enabled: typeof enabled === 'boolean' ? enabled : DEFAULT_CONFIG.enabled,
    maxRowsPerTable:
      typeof maxRows === 'number' && Number.isFinite(maxRows) && maxRows > 0
        ? Math.min(2_000_000, Math.trunc(maxRows))
        : DEFAULT_CONFIG.maxRowsPerTable,
    announceFallback: typeof announce === 'boolean' ? announce : DEFAULT_CONFIG.announceFallback,
  }
}

/** 身份服务的结构对位子集（只用来拼日志命名空间）。 */
interface IdentityLike {
  loggerName(feature: string): string
}

declare module '@ntars/cordis' {
  interface Context {
    /** 内存存储端口；未装载或已关闭时为 undefined。 */
    'ondra-store-memory'?: StorePort
  }
}

/**
 * Cordis 入口：注册内存端口。
 *
 * **即使 SQLite 后端已在位也照常注册。** 理由：注册与否取决于装载顺序就会
 * 「有时兜底、有时不兜底」，那种不确定性比多存一个空对象贵得多。
 * 「只用其中一个」由消费方的取值顺序保证：
 * `ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')`。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Config): void {
  const complete = completeConfig(config)

  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('store-memory') : 'ondra.store-memory')

  if (!complete.enabled) {
    log.warn('enabled=false：内存兜底已关闭。SQLite 不可用时，依赖存储的插件将拿不到任何后端')
    return
  }

  const store = new MemoryStore(complete.maxRowsPerTable)

  ctx.effect(
    () => {
      const dispose = ctx.provide(STORE_MEMORY_SERVICE_KEY, store)
      return () => {
        dispose()
        store.close()
      }
    },
    'ondra-store-memory: 注册内存存储端口',
  )

  // SQLite 在位时只说一句「我在备用」，不说「已启用」——后者会让人以为数据进了内存。
  const sqlite = ctx.get('ondra-store-sqlite') as StorePort | undefined
  if (sqlite !== undefined && sqlite.state === 'open') {
    log.info('SQLite 后端已在位（%s），本后端仅作备用，不会被选中', sqlite.provider)
    return
  }

  if (complete.announceFallback) {
    log.warn(
      '内存兜底已生效：本次会话的数据**不会落盘**，进程退出即丢；单表上限 %d 行。若要长期记忆，请先修好 SQLite 后端（日志命名空间 ondra.store-sqlite）',
      complete.maxRowsPerTable,
    )
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
    ) => { readonly value: Config } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      const complete = completeConfig(value)
      const issues: { message: string }[] = []
      const raw = isRecord(value) ? value : {}
      if (typeof raw['maxRowsPerTable'] === 'number') {
        const maxRows = raw['maxRowsPerTable']
        if (!Number.isInteger(maxRows) || maxRows <= 0) {
          issues.push({ message: '配置项 maxRowsPerTable 必须是正整数' })
        }
      }
      if (issues.length > 0) return { issues }
      return { value: complete }
    },
  },
}
