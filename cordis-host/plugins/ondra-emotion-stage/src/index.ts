/**
 * O-028 `ondra-emotion-stage`：七阶关系弧与防跃迁（〔研〕自研）。
 *
 * ## 为什么这一项必须自研
 *
 * 手册 §1.8 把「七阶关系弧 + 防跃迁 + 冲突锁」列在自研档，理由写得很直白：
 * **社区做的是「好感度 0–1000 六段」，没人做「敌意→献祭→落定」这种纵深。**
 * 生态里能查到的关系系统几乎都是「一个数字 + 几个阈值」，
 * 而这里要的是：一个只升不降的棘轮、四道不许跃迁的闸、一条会衰减的关系曲线，
 * 外加两条互不推导的只读展示（五阶段 / 六段）。
 *
 * 真正自研的只有两样：**七阶表的判定顺序**与**棘轮 + 四闸的组合**。
 * 衰减公式本身不是新的（与 O-013 / O-026 同一条闭式曲线），
 * 熟悉度的分母也不是新的（借 §3.5 的 5000）。
 *
 * ## 与邻居的边界
 *
 * - **不表达**：六态语域（雀跃/软和/…）归 O-031，本插件只给阶段与刻度。
 * - **不建锁**：冲突锁归 O-030，本插件只收一个 `locked` 布尔入参。
 * - **不做阈值漂移**：`threshold = base × (1 + 0.6 × min(1, n/5000))` 归 O-130
 *   `ondra-persona-evolve`。本插件只把 `interactions` 这个被乘数备好。
 * - **不管张力**：张力归 O-026 的六维与 O-030 的锁。§3.4 的 tension 24h 半衰不在这里。
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
import type { Config as StageConfig } from './settings.js'
import { StageRepository } from './service.js'
import { RelationStore } from './store.js'
import { STAGE_SERVICE_KEY } from './types.js'
import type {
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  StageService,
  StageUnavailableReason,
  StoreLike,
} from './types.js'

export type * from './types.js'
export {
  FAMILIARITY_SATURATION,
  MAX_STEP,
  MS_PER_DAY,
  MS_PER_MINUTE,
  RELATION_DIMS,
  RELATION_SPEC,
  STAGES,
  STAGE_SERVICE_KEY,
  STAGE_SPECS,
  StageError,
} from './types.js'
export {
  DIM_BASELINE,
  applyPatch,
  clampDim,
  clampDims,
  clampStep,
  daysOf,
  decayedDim,
  familiarityOf,
  minutesBetween,
  projectDims,
} from './relation.js'
export type { DimValues, PatchResult } from './relation.js'
export { orderOf, probeAll, probeStage, resolveStage, specOf, stageAt } from './stages.js'
export type { GateContext, ProbeResult, ResolveResult } from './stages.js'
export { LEGACY_MAP, SCALE_BANDS, legacyOf, scaleOf } from './legacy.js'
export { describeStageDrift, driftedStages } from './thresholds.js'
export type { StageDriftReport, ThresholdDrift } from './thresholds.js'
export { TABLE_RELATION, RelationStore } from './store.js'
export type { RawRelationRow, RelationWrite } from './store.js'
export { StageRepository } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-emotion-stage'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 向 O-005 注册配置段。
 *
 * 注册放进 `ctx.effect` 里：段是本插件的资源，卸载时必须一起撤，
 * 否则重载后第二次注册会撞「段键已被占用」。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 注册是否成功。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-emotion-stage: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 关系阶段服务；未装载本插件时为 undefined。 */
    'ondra-emotion-stage'?: StageService
  }
}

/**
 * Cordis 入口：接上存储端口、读一次存档、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：声明 `inject: ['ondra-store-sqlite']` 之后，
 * 存储缺席会让整个插件停在 PENDING（静默不加载，最难查的失败形态）。
 * 改成「照常注册 + 内存态运行」，下游能区分「没装关系阶段」与
 * 「装了但重启会回到敌意」——后者的表现是关系会重走，而不是她失忆。
 *
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: StageConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('emotion-stage') : 'ondra.emotion.stage') as unknown) as LogLike

  // 1. 配置：有 O-005 就走四层合并（并能说出「哪一层的哪个字段」）。
  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  if (schema !== undefined && registerSection(ctx, schema, log)) {
    try {
      // 用户层用 kebab 键交给 O-005（§8.4 只认小写），回来再换成 camel 键。
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

  // 2. 状态表：阶段是棘轮，不落盘就等于每次重启都回到敌意。
  /*
   * `enable=false` 时**不建表**（第 16 轮修）。
   *
   * 修之前这里没有守卫：用户在设置里关掉「关系阶段」，重启后
   * `RelationStore.ensure()` 照样调 `store.ensureTable()`，库里多出一张
   * `ondra_relation_state`。开关看着生效（`available` 返回 false、读操作
   * 一律返回起始阶），破绽只在「数据库里多了一张不该存在的表」。
   *
   * 与 `ondra-emotion-core/src/index.ts:172-186` 的标准写法对齐：
   * **先判关，再判存储**。顺序不能反——反了的话「关掉 + 无存储」会报
   * `no-store`，把用户引去查存储。
   */
  const store = (ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')) as StoreLike | undefined
  let relationStore: RelationStore | undefined
  let reason: StageUnavailableReason | undefined
  if (!settings.enable) {
    reason = 'disabled'
    log.info('关系阶段被配置关闭：服务仍注册，读操作一律返回起始阶，且不建表')
  } else if (store === undefined) {
    reason = 'no-store'
    log.warn('没有可用存储端口：关系阶段只活在内存里，重启回到敌意阶')
  } else {
    const created = new RelationStore(store, log)
    if (created.ensure()) {
      relationStore = created
    } else {
      reason = 'schema-failed'
    }
  }

  // 3. 造服务并读一次存档（构造里已经读过）。
  /*
   * 阈值漂移：延迟取值 + 每次判定现问。
   *
   * `base` 由本插件那张 `STAGE_SPECS` 给（它是这张表的主人），
   * 乘法归 O-130，本插件只收结果。三个缺席条件（没装 / 已关 / 抛错）
   * 一律退化为「不漂」，也就是用出厂门槛判 —— 与「装了但 0 次互动」等价。
   */
  const service = new StageRepository(settings, log, () => Date.now(), relationStore, reason, () => {
    const evolve = ctx.get('ondra-persona-evolve') as
      | { readonly available: boolean; thresholdOf(key: string, base: number): number }
      | undefined
    if (evolve === undefined || evolve.available !== true) return undefined
    return (key: string, base: number) => evolve.thresholdOf(key, base)
  })
  ctx.effect(() => ctx.provide(STAGE_SERVICE_KEY, service), 'ondra-emotion-stage: 注册关系阶段')

  // 4. 报一次现状。可用性、降级原因、当前阶都要能被自检读到，不许黑箱（§12.2）。
  const stats = service.stats()
  if (!stats.available) {
    log.warn('关系阶段已注册但不可用（%s）：所有读操作返回起始阶', stats.reason ?? '未知原因')
    return
  }
  log.info(
    '关系阶段就绪：当前「%s」，第 %d 天，累计互动 %d 次，状态表 %s',
    stats.base,
    stats.days,
    stats.interactions,
    stats.storeProvider,
  )
  if (stats.reason !== undefined) {
    log.warn('关系阶段以降级状态运行：%s', stats.reason)
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
    ) => { readonly value: StageConfig } | { readonly issues: readonly { readonly message: string }[] }
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
