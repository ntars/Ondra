/**
 * O-121 `ondra-store-json`：JSONL 持久化后端（〔研〕自研，多方案分支）。
 *
 * 定位（手册 §12.3「持久化后端」行 + 台账第 16 组）：SQLite（WAL）是**默认**底座，
 * 本插件是它的**分支**——无 SQLite 的环境、`node:sqlite` 缺失、库文件损坏且快照不可用，
 * 而用户又**不想接受内存后端的「退出即丢」**时，把持久化换成一个不依赖 SQLite 的实现。
 *
 * 与 O-006 / O-007 的关系：三个后端实现同一个 `StorePort` 形状（结构对位镜像），
 * 注册三个不同的服务键；**消费方只取一个、只写一个**——同时写两个后端就是双真源。
 * 取值顺序由消费方配置决定；本插件不做「SQLite 在位就退让」的自动逻辑，
 * 因为分支切换是**用户的显式选择**，不是可用性探测（那是 O-007 的职责）。
 *
 * 三条边界（实现细节见 `port.ts` 头注释）：
 *
 * 1. **先落盘后改内存**：追加失败时内存保持原样，消费方看到的是一次干净的失败。
 * 2. **追加日志 + 压缩原子重写**：崩溃最多丢正在写的半行；`compact()` 用 tmp + fsync + rename。
 * 3. **不装 SQL 的样子**：`caps.sql = false`、`raw = undefined`，需要 FTS5 的消费方
 *    必须在装载期检查能力位后留在 SQLite 分支，而不是运行到一半才收到「不支持」。
 *
 * 不 import O-006 / O-007 的源码（§15.5）：契约靠本包 `src/types.ts` 的结构对位镜像。
 */

import type { Context } from '@ntars/cordis'
import { JsonlStore } from './port.js'
import { STORE_JSON_SERVICE_KEY } from './types.js'
import type { ConfigSchemaLike, StorePort } from './types.js'

// 契约里既有纯类型也有运行时值（服务键、错误类、标识符正则），分开导出才不违背
// 「类型导入不得混入运行时值」这条自检项。
export type * from './types.js'
export { STORE_JSON_SERVICE_KEY, StoreError } from './types.js'
// 配置的四层合并接入与默认值真源都在 `settings.ts`：`FIELD_SPECS` 是唯一存放处，
// 本文件不再自己写一份默认值（两份默认值必然漂移）。
export {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  KEY_PAIRS,
  SECTION_KEYS,
  completeConfig,
  normalizeUserLayer,
  registerSection,
  valuesToConfigShape,
} from './settings.js'
import {
  CONFIG_SECTION_ID,
  completeConfig,
  isRecord,
  normalizeUserLayer,
  registerSection,
  valuesToConfigShape,
} from './settings.js'
export { JsonlStore } from './port.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-store-json'

/** 数据目录名。挂在 `user/` 区域下（可备份、不可随手清）。 */
const DATA_DIR_NAME = 'jsonl-store'

/** 配置项：全部有默认值。 */
export interface Config {
  /**
   * 是否注册本后端。**默认 false**——台账第 16 组：默认分支「否（SQLite 默认）」。
   * 打开它 = 用户显式选择 JSONL 分支；SQLite 在位时两个后端会同时注册，
   * 用哪个由消费方的取值顺序决定，本插件不越权裁决。
   */
  readonly enabled: boolean
  /**
   * 单表行数上限。默认 20000。到上限**拒绝新增**并抛错，不淘汰旧行（与 O-007 同口径）。
   */
  readonly maxRowsPerTable: number
  /**
   * 自动压缩倍数。默认 4：某表自上次压缩以来的追加行数达到
   * 「存活行数与 64 的较大者」的 4 倍时自动压缩。0 = 关闭自动压缩（只能手跑 `compact()`）。
   */
  readonly compactFactor: number
  /**
   * 是否把数据目录收紧到 0700、文件收紧到 0600。默认 true；Windows 上自动跳过。
   */
  readonly tightenPermissions: boolean
}

/** O-001 身份服务的结构对位子集（只用来拼日志命名空间）。 */
interface IdentityLike {
  loggerName(feature: string): string
}

/** O-002 路径服务的结构对位子集。目录归它建（0700 + 越界校验），本插件不自己 mkdir。 */
interface PathLayoutLike {
  readonly display: string
  ensure(area: 'user' | 'logs' | 'cache' | 'tmp' | 'backups', ...segments: string[]): string
  fileIn(area: 'user' | 'logs' | 'cache' | 'tmp' | 'backups', ...segments: string[]): string
}

declare module '@ntars/cordis' {
  interface Context {
    /** JSONL 存储端口；未装载或 `enabled=false` 时为 undefined。 */
    'ondra-store-json'?: StorePort
  }
}

/**
 * Cordis 入口：建目录、开存储、注册服务。失败只降级不阻断。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: unknown): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const layout = ctx.get('ondra-path-layout') as PathLayoutLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('store-json') : 'ondra.store-json')

  /*
   * 配置：有 O-005 就走四层合并。取不到 / 注册失败 / 解析抛错，三条降级路径的
   * 终点都是同一个 `completeConfig(config)`，所以没有 O-005 时行为与以前逐字相同。
   *
   * 这一段此前是缺的：用户层的 `enabled` 根本没机会进来，总开关恒读出厂的 `false`。
   * 后果是「在插件抽屉里打开它 → 显示已启用 → 启动日志说 enabled=false → 服务没注册」，
   * 而三个界面各说各的，没有一处报错。
   */
  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  if (schema !== undefined && registerSection(ctx, schema, log)) {
    try {
      const resolved = schema.resolve(CONFIG_SECTION_ID, { user: normalizeUserLayer(raw) })
      if (resolved !== undefined) {
        effective = valuesToConfigShape(resolved.values)
        if (resolved.fallbackCount > 0) {
          log.warn?.('配置有 %d 个字段校验失败，已逐个回退默认值', resolved.fallbackCount)
        }
      }
    } catch (error) {
      log.warn?.('解析配置段失败，退回插件实例配置：%s', error instanceof Error ? error.message : String(error))
    }
  }
  const complete = completeConfig(effective)

  if (!complete.enabled) {
    log.info('enabled=false（出厂默认）：JSONL 分支未注册。SQLite 不可用且不想丢数据时，在「设置 → JSONL 存储」里打开它')
    return
  }

  // 定位数据目录。**绝不落到当前工作目录**——目录归 O-002 建（0700 + 越界校验），
  // 本插件不自己 mkdir；找不到路径服务就拒绝注册，而不是悄悄把数据写散。
  let dir: string
  let displayPath: string | null
  if (layout === undefined) {
    log.error('找不到路径服务 ondra-path-layout：拒绝把数据目录落到当前工作目录，本插件不注册服务')
    return
  }
  try {
    dir = layout.ensure('user', DATA_DIR_NAME)
    displayPath = `${layout.display}/user/${DATA_DIR_NAME}`
  } catch (error) {
    log.error(
      '解析数据根下的 JSONL 目录失败，本插件不注册服务：%s',
      error instanceof Error ? error.message : String(error),
    )
    return
  }

  let store: JsonlStore
  try {
    store = new JsonlStore(
      dir,
      displayPath,
      complete.maxRowsPerTable,
      complete.compactFactor,
      complete.tightenPermissions,
    )
  } catch (error) {
    log.error(
      'JSONL 存储初始化失败，本插件不注册服务（下游应回退 ondra-store-sqlite / ondra-store-memory）：%s',
      error instanceof Error ? error.message : String(error),
    )
    return
  }

  // 可逆注册：卸载时先摘服务再关存储。
  ctx.effect(
    () => {
      const dispose = ctx.provide(STORE_JSON_SERVICE_KEY, store)
      return () => {
        dispose()
        try {
          store.close()
        } catch (error) {
          log.error('关闭 JSONL 存储时出错：%s', error instanceof Error ? error.message : String(error))
        }
      }
    },
    'ondra-store-json: 注册 JSONL 存储端口',
  )

  log.info(
    'JSONL 分支已注册：%s（单表上限 %d 行，自动压缩 %s）',
    displayPath,
    complete.maxRowsPerTable,
    complete.compactFactor > 0 ? `×${complete.compactFactor}` : '关',
  )
  const sqlite = ctx.get('ondra-store-sqlite') as StorePort | undefined
  if (sqlite !== undefined && sqlite.state === 'open') {
    log.warn(
      'SQLite 后端也在位：%s 与本分支同时注册了。两个后端**不会自动同步**，消费方按配置只取一个、只写一个',
      sqlite.provider,
    )
  }
  if (!complete.tightenPermissions) {
    log.warn('tightenPermissions=false：数据文件权限未收紧到 0600，仅调试期可用')
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
      if (typeof raw['compactFactor'] === 'number') {
        const compact = raw['compactFactor']
        if (!Number.isInteger(compact) || compact < 0) {
          issues.push({ message: '配置项 compactFactor 必须是非负整数（0 表示关闭自动压缩）' })
        }
      }
      if (issues.length > 0) return { issues }
      return { value: complete }
    },
  },
}
