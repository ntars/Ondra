/**
 * O-144 `ondra-reflex`：**反射弧自写 + 链路结晶**（手册 §8.6，P1）。
 *
 * ## 一句话
 *
 * 同一个工具因为同一个原因失败到第 3 次，写一条 `R-auto-<cause>-<tool>`；
 * 跨器官的 ≥3 步成功链走过两遍，记成一条 skill 候选。**全程不调模型。**
 *
 * ## 它接在哪
 *
 * `tools/result`——与 O-139 同一个事件，但**只读不喂**：
 *
 * - 结果在这里已经冻结、且可无损 JSON 表示，读完不会被后续改写；
 * - 监听器抛错被隔离（`emit` 模式），本包写坏了也不会把工具结果弄丢；
 * - 本包**不**向器官宿主 `toolResult()` 推任何东西——那是 O-139 的唯一职责，
 *   出现第二个喂食者会让器官收到两份同样的结果（见 O-139 README 已知限制 7）。
 *
 * ## 为什么它不是器官
 *
 * 器官门面里只有 `onToolResult`（要有人喂），没有「订阅上游事件」这条路。
 * 本包要的正是**上游事件**，而且它要给的结果是「账本 + 候选」，不是「反馈 Δ」。
 * 硬塞进器官 ABI 的代价是：要么改已 `done` 的 O-132，要么绕过门面去拿裸 ctx，
 * 两条都比「做成策略层插件」糟。C3 的精神照守：整条链 try/catch，绝不传播。
 *
 * ## 一处命名冲突（手册内部矛盾，已在 README 说明）
 *
 * 手册要求 `R-auto-<cause>-<tool>`，而 §8.4 要求键名小写。
 * 本包两个都留：`id` 是手册原样（展示用），`key` 是小写归一化版（当键用）。
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
import type { Config as ReflexConfig } from './settings.js'
import { Reflex } from './service.js'
import type { ReflexDeps } from './service.js'
import { REFLEX_SERVICE_KEY } from './types.js'
import type { AttribLike, ConfigSchemaLike, IdentityLike, ReflexService, StorePortLike } from './types.js'

export type * from './types.js'
export {
  REFLEX_KEY_PREFIX,
  REFLEX_PREFIX,
  REFLEX_SERVICE_KEY,
  KEY_RE,
} from './types.js'
export {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
export {
  candidateSlugOf,
  hashOf,
  keyIsPlain,
  keyOfSafe,
  reflexIdOf,
  reflexKeyOf,
  signatureOf,
  slugOf,
} from './naming.js'
export { ChainTracker } from './chain.js'
export { Crystallizer } from './skill.js'
export type { CrystallizeOptions, CrystallizeOutcome, CrystallizeVerdict } from './skill.js'
export { REFLEX_TABLE, REFLEX_TABLE_NAME, ReflexStore } from './store.js'
export type { StoredRow } from './store.js'
export { Reflex } from './service.js'
export type { ReflexDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-reflex'

/**
 * 上游事件总线的最小形状。
 *
 * **刻意不 `declare module` 扩 `Events`**：上游已经声明过 `tools/result`，
 * 本包再声明一遍，签名差一个字就会让 `interface` 合并直接编译失败，
 * 而错误信息指向「重复声明」，看不出真正原因是「本包抄错了参数」。
 */
interface EventBusLike {
  on(event: string, listener: (...args: never[]) => unknown): () => void
}

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
    /** 反射弧与链路结晶；未装载本插件时为 undefined。 */
    'ondra-reflex'?: ReflexService
  }
}

/**
 * Cordis 入口：解析配置、装服务、挂一个工具结果监听。**永不抛错**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: ReflexConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('reflex') : 'ondra.reflex')

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

  const deps: ReflexDeps = {
    settings: () => settings,
    log,
    now: () => {
      const clock = ctx.get('ondra-clock') as { now(): number } | undefined
      return clock === undefined ? Date.now() : clock.now()
    },
    // 现取：装载顺序由用户配置决定，快照会让「后装载的归因」永远拿不到。
    attrib: () => ctx.get('ondra-failure-attrib') as AttribLike | undefined,
    store: () => ctx.get('ondra-store-sqlite') as StorePortLike | undefined,
  }

  const service = new Reflex(deps)

  ctx.effect(
    () => {
      const removeService = ctx.provide(REFLEX_SERVICE_KEY, service)
      return () => {
        // 先撤服务再清账本：卸载之后没人再查，留着只是占内存。
        service.dispose()
        removeService()
      }
    },
    'ondra-reflex: 注册反射服务',
  )

  ctx.effect(
    () => {
      const bus = ctx as unknown as EventBusLike
      const off = bus.on('tools/result', (execution: unknown, result: unknown) => {
        try {
          service.observe(execution, result)
        } catch (error) {
          // 本包在工具返回的临界路径上：它坏了不能影响工具结果本身。
          log.warn('反射处理失败（已忽略，不影响工具结果）：%s', textOf(error))
        }
      })
      return () => off()
    },
    'ondra-reflex: 监听工具结果',
  )

  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被夹紧或丢弃（与你设的不一样）：%s', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('反射弧关着：服务仍注册（available=false），账本与候选仍可查（只是不再增长）')
    return
  }
  if (ctx.get('ondra-failure-attrib') === undefined) {
    log.warn(
      '失败归因（ondra-failure-attrib）不在：反射已注册但不可用（reason=no-attrib）——不知道原因就不写反射，绝不把「不知道」当成 unknown 类',
    )
    return
  }

  log.info(
    '反射弧就绪：同工具×同因 %d 次成反射；链 ≥%d 步且跨 ≥%d 个器官、重复 %d 次成候选',
    settings.reflexThreshold,
    settings.chainMinSteps,
    settings.chainMinTools,
    settings.chainRepeats,
  )
  log.info('全程零模型调用：本包不调模型、不注册工具、不喂器官宿主（那是 O-139 的职责）')
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => { readonly value: ReflexConfig } | { readonly issues: readonly { readonly message: string }[] }
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
