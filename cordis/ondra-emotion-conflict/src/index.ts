/**
 * O-030 `ondra-emotion-conflict`：冲突锁（〔研〕自研）。
 *
 * ## 一句话
 *
 * 吵起来的时候，**只有一处**记得「现在还气着」——并且它会管住撒娇、主动与话长。
 *
 * ## 为什么这一项必须自研
 *
 * 手册 §1.8 把「七阶关系弧 + 防跃迁 + **冲突锁**」整条列进自研档（P0），
 * 理由原文是「社区做好感度 0-1000 六段，没人做敌意→献祭→落定这种纵深」。
 * 冲突锁是那条纵深上唯一一个**会改变当下行为**的部件：
 * 别的系统里吵架只是「好感 −5」，这里是「她接下来半小时不撒娇、不主动、话变短」。
 *
 * 真正自研的只有两样：**两套进锁入口（事件 / 阈值）的合并方式**与
 * **解锁的两条路**。数值全是手册给的（`+0.15`、连续 2 次、`0.5`）。
 *
 * ## 与邻居的边界
 *
 * - **不持有情绪**：张力 / 心情归 O-026；本插件只读，改动一律以 Δ 建议带出（C1）。
 * - **不做阶段**：七阶与「锁定时覆盖为敌意」归 O-028，本插件只把 `locked` 交给它。
 * - **不写语域**：六态与句长系数归 O-031 / O-038，本插件只给 `brevity: 'short'`。
 * - **不 import 任何邻居的源码**（§18.5）：只用结构对位镜像。
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
import type { Config as ConflictConfig } from './settings.js'
import { ConflictRepository } from './service.js'
import { ConflictStore } from './store.js'
import { CONFLICT_SERVICE_KEY, LOCK_STRESS, LOCK_TENSION, MOOD_CEILING, TENSION_ADD } from './types.js'
import type { ConfigSchemaLike, ConflictService, EmotionLike, IdentityLike, LogLike, StoreLike } from './types.js'

export type * from './types.js'
export {
  CONFLICT_SERVICE_KEY,
  LOCK_STRESS,
  LOCK_TENSION,
  MIN_FRAGMENT_ORDER,
  MOOD_CEILING,
  MOOD_RISE,
  POSITIVE_STREAK,
  REASON_ZH,
  RELEASE_TENSION_MAX,
  TENSION_ADD,
} from './types.js'
export {
  CONFLICT_DIRECTIVE_TEXT,
  LONG_LOCK_HOURS,
  buildDirective,
  canReleaseByPositives,
  clamp01,
  enterSuggestion,
  moodGateOf,
  releaseSuggestion,
  resolveStatus,
  stressTriggered,
  tensionTriggered,
} from './rules.js'
export type {
  DirectiveSettings,
  EnterSuggestion,
  MoodGate,
  ReleaseSuggestion,
  RuleInput,
} from './rules.js'
export { CONFIG_SECTION, CONFIG_SECTION_ID, DEFAULT_CONFIG, FIELD_SPECS } from './settings.js'
export { TABLE_CONFLICT, ConflictStore } from './store.js'
export type { RawConflictRow } from './store.js'
export { ConflictRepository } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-emotion-conflict'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 向 O-005 注册配置段。
 *
 * 注册放进 `ctx.effect`：段是本插件的资源，卸载时必须一起撤，
 * 否则重载后第二次注册会撞「段键已被占用」。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 注册是否成功。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-emotion-conflict: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 冲突锁服务；未装载本插件时为 undefined。 */
    'ondra-emotion-conflict'?: ConflictService
  }
}

/**
 * Cordis 入口：接上存储与情绪读数、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：`inject: ['ondra-emotion-core']` 会让情绪缺席时
 * 整个插件停在 PENDING（静默不加载，最难查的失败形态）。
 * 而本插件的正确降级是「照常注册 + 读到基线」：
 * 下游能区分「没装冲突锁」与「装了但读不到心情」——
 * 后者的表现是心情闸放行（宁可早解一次），而不是她永远冷着脸。
 *
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: ConflictConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('emotion-conflict') : 'ondra.emotion.conflict') as unknown) as LogLike

  // 1. 配置：有 O-005 就走四层合并（并能说出「哪一层的哪个字段」）。
  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw
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
  const settings = completeConfig(effective)

  // 2. 状态表：锁必须落盘，否则重启等于「不生气了」——
  //    而「重启一下她就和好了」会让整条关系纵深失去意义。
  const store = (ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')) as StoreLike | undefined
  let conflictStore: ConflictStore | undefined
  if (store === undefined) {
    log.warn('没有可用存储端口：冲突锁只活在内存里，重启等于「刚和好」')
  } else {
    const created = new ConflictStore(store, log)
    if (created.ensure()) conflictStore = created
  }

  // 3. 情绪读数用**延迟取值**：装载顺序不确定，构造时拿不到不代表以后拿不到。
  const service = new ConflictRepository(settings, log, () => Date.now(), () => {
    const emotion = ctx.get('ondra-emotion-core') as EmotionLike | undefined
    return emotion
  }, conflictStore)
  ctx.effect(() => ctx.provide(CONFLICT_SERVICE_KEY, service), 'ondra-emotion-conflict: 注册冲突锁')

  // 4. 报一次现状（§12.2：可用性、降级原因都要能被自检读到，不许黑箱）。
  const stats = service.stats()
  if (!stats.available) {
    log.warn('冲突锁已注册但不可用（%s）：永不进锁，行为后果不生效', stats.reason ?? '未知原因')
    return
  }
  log.info(
    '冲突锁就绪：%s，状态表 %s，情绪读数 %s；进锁线 张力>%.2f 或 应激>%.2f，建议 +%.2f / 心情压到 ≤%.2f',
    stats.locked ? '当前锁着' : '当前没锁',
    stats.storeProvider,
    stats.readingSource === 'emotion' ? '情绪服务' : '出厂基线（未接情绪服务）',
    LOCK_TENSION,
    LOCK_STRESS,
    TENSION_ADD,
    MOOD_CEILING,
  )
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
    ) => { readonly value: ConflictConfig } | { readonly issues: readonly { readonly message: string }[] }
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
