/**
 * O-143 `ondra-zero-residence`：**零常驻上下文**（手册 §8.6，P1）。
 *
 * ## 一句话
 *
 * 把一段常驻正文换成一条**确定性指针**（`[zr-xxxxxxxxxxxx/1420]`），
 * 正文落进 SQLite，指针留在提示词里；要用的时候按指针**逐字**取回来。
 *
 * 比「压缩成摘要」好在两点：**可逆**（原文还在，不是「大概」）与**可审计**
 * （账上写着谁在什么时候被遮了多少字，取回来还能对指纹）。
 *
 * ## 为什么这个插件自己也是零常驻
 *
 * 不装定时器、不装监听器、不拼提示词、不调模型、不常驻正文：
 * 只在被调用时算一次。索引随启动懒加载，正文按需从库里取。
 * 一个号称零常驻的插件自己先常驻 2MB，说不过去。
 *
 * ## 它接在哪
 *
 * **不接。** 这不是偷懒，是边界：本包看不到消息序列，所以不知道「哪一段该被替换」。
 * 替换动作归 O-033 `ondra-dialogue`（它有 `compactHistory`）或应用外壳。
 * 本包只提供三样东西：**替换文本**、**可恢复的凭据**、**可对账的账本**。
 *
 * 硬要自己接 `agent/pre-step` 去改消息，就等于在没有原文归属权的情况下改写别人的上下文——
 * 改错了没有任何人能查出来。所以宁可少做一步，也要把这一步留在有资格做的地方。
 */

import type { Context } from '@ntars/cordis'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as ZrConfig } from './settings.js'
import { ZeroResidence } from './service.js'
import type { ZrDeps } from './service.js'
import { ZR_SERVICE_KEY } from './types.js'
import type { ConfigSchemaLike, IdentityLike, StorePortLike, ZrService } from './types.js'

export type * from './types.js'
export {
  ZR_SERVICE_KEY,
  KEY_RE,
  POINTER_RE_SOURCE,
  pointerRe,
} from './types.js'
export {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  ZR_MODES,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
export {
  baseIdOf,
  charsOf,
  chunkText,
  fnv1a64,
  idCandidateOf,
  idOfPointer,
  indexAfterChars,
  pointerOf,
} from './pointer.js'
export { ZrLedger } from './ledger.js'
export type { ZrEntry } from './ledger.js'
export { ZR_TABLE, ZR_TABLE_NAME, ZrStoreAdapter } from './store.js'
export { expandText, verifyRecord } from './recover.js'
export type { ZrResolver, ZrVerify } from './recover.js'
export { ZeroResidence } from './service.js'
export type { ZrDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-zero-residence'

/**
 * 把异常折成一句文本。
 * @param error 异常。
 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

declare module '@ntars/cordis' {
  interface Context {
    /** 零常驻上下文；未装载本插件时为 undefined。 */
    'ondra-zero-residence'?: ZrService
  }
}

/**
 * Cordis 入口：解析配置、装服务。**永不抛错**。
 *
 * 刻意**不写 `inject`**：存储后端缺席时本插件仍然要能被查到（`available=false`、
 * `reason='no-store'`）。写成入口级 inject 会让它停在 PENDING 且一声不响，
 * 那正是手册 §8.3 说的最隐蔽的失败。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: ZrConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('zero-residence') : 'ondra.zero-residence')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  if (schema !== undefined) {
    try {
      schema.register(CONFIG_SECTION, name)
      const resolved = schema.resolve(CONFIG_SECTION_ID, { user: normalizeUserLayer(raw) })
      if (resolved !== undefined) {
        effective = valuesToConfigShape(resolved.values)
        if (resolved.fallbackCount > 0) {
          log.warn('配置有 %d 个字段校验失败，已逐个回退默认值', resolved.fallbackCount)
        }
      }
    } catch (error) {
      log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', textOf(error))
    }
  }
  const settings = completeConfig(effective)

  const deps: ZrDeps = {
    settings: () => settings,
    log,
    now: () => {
      const clock = ctx.get('ondra-clock') as { now(): number } | undefined
      return clock === undefined ? Date.now() : clock.now()
    },
    // 现取而不是快照：装载顺序由用户配置决定，不由本插件决定。
    store: () => ctx.get('ondra-store-sqlite') as StorePortLike | undefined,
  }

  const service = new ZeroResidence(deps)

  ctx.effect(
    () => {
      const removeService = ctx.provide(ZR_SERVICE_KEY, service)
      return () => {
        // 先撤服务再清账本：卸载后没人再查，留着只是占内存。
        service.dispose()
        removeService()
      }
    },
    'ondra-zero-residence: 注册零常驻服务',
  )

  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被夹紧或丢弃（与你设的不一样）：%s', drift.join(' / '))
  }

  if (settings.mode === 'off') {
    log.info('零常驻关着：服务仍注册（available=false），账本与统计仍可查')
    return
  }

  const port = ctx.get('ondra-store-sqlite') as StorePortLike | undefined
  if (settings.requireDurable && port === undefined) {
    log.warn(
      '没有存储后端（ondra-store-sqlite 不在）：零常驻已注册但不可用（reason=no-store）——手册要求「压缩前状态先写 SQLite」，写不进去就不交指针',
    )
    return
  }

  log.info(
    '零常驻就绪：模式 %s，单段上限 %d 字，省字门槛 %d，账本上限 %d 条',
    settings.mode,
    settings.maxSpanChars,
    settings.minSavingsChars,
    settings.maxRecords,
  )
  if (settings.mode === 'observe') {
    log.info('当前是 observe：照常算、照常报警，但不写盘也不交指针。先看 fast() 与 ledger() 的数再翻 compact')
  }
  log.info('替换动作不在本包：把 compact() 返回的 pointers 交给 O-033 或应用外壳去替换，本包只管「可恢复」')
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => { readonly value: ZrConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能安全补全（越界夹紧、坏条目回退），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
