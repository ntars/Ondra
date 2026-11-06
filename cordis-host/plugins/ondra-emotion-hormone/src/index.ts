/**
 * O-123 `ondra-emotion-hormone`：激素维度扩展（〔研〕自研，默认关闭）。
 *
 * ## 一句话
 *
 * **激素只读叠加：读得出、解释得清、一个字节都不写回情绪。**
 *
 * ## 为什么这一项必须自研
 *
 * 手册 §14.3 把情绪维度排成一排多方案：核心三维为底座、激素做可选插件、
 * 效价-唤醒二维做展示层派生。生态里有 `y258dd/ondra-hormone` 这类实现
 * （越阈值时往系统提示词写一句、值随事件升降、随时间衰减），
 * 但它做的是「自己持有数值 + 自己注入提示词」，而那恰好是本仓已经分给
 * O-026（持有）与 O-032（唯一文本出口）的两件事。
 * 本插件的价值在**接线口径**——把激素读成「倾向」而不是「第二个心情值」，
 * 这份口径没有现成实现可复用，故按台账标〔研〕。
 *
 * ## 与邻居的边界（四条，全部可验证）
 *
 * - **不持有激素**：值全在 O-026 的化学池里；`oxytocin` 用 O-026 自己的
 *   动态激素通道造（`inflict('oxytocin', 0)`），不新建表、不新建池。
 * - **不写 PAD、不算 mood**：`overlay()` 里没有 `setAxis` / `feel`，
 *   `applied` 的类型是字面量 `false`。
 * - **不出提示词片段**：文本出口唯一归 O-032；O-029 已在皮质醇 ≥80 时
 *   输出「你在应激」的行为指令，再加一段就是两段指令互相打架。
 * - **不改 O-026**：发现它缺 oxytocin 只登记，不偷偷加字段。
 *
 * ## 为什么刻意不声明插件级 `inject`
 *
 * `inject: ['ondra-emotion-core']` 会让情绪服务缺席时整个插件停在 PENDING
 * （静默不加载，宿主只在 stderr 留一行）。而本插件的正确降级是
 * **照常注册 + 给出厂基线 + 平稳倾向**：下游能区分「没装激素维度」
 * 与「装了但读不到情绪」——后者的表现是三维全基线，而不是插件凭空消失。
 */

import type { Context } from '@ntars/cordis'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  isRecord,
  valuesToConfigShape,
} from './settings.js'
import type { Config as HormoneConfig } from './settings.js'
import { HormoneRepository } from './service.js'
import { HORMONE_SERVICE_KEY, HORMONE_SPECS } from './types.js'
import type {
  ConfigSchemaLike,
  EmotionLike,
  HormoneService,
  IdentityLike,
  LogLike,
} from './types.js'

export type * from './types.js'
export {
  BAND_ZH,
  BELOW_RATIO,
  HORMONE_SERVICE_KEY,
  HORMONE_SPECS,
  LOW_RATIO,
  PRIMARY_HORMONES,
  REFERENCE_HORMONES,
  TILT_ZH,
} from './types.js'
export {
  bandOfRatio,
  baselineOf,
  clamp01,
  clamp100,
  ratioOf,
  readOf,
  valueIn,
  weightsOf,
} from './read.js'
export { BOND_HIGH, DRIVE_HIGH, DRIVE_LOW, LOAD_HIGH, notesOf, overlayOf, tiltOf } from './overlay.js'
export {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  KEY_PAIRS,
  KEY_PAIRS_REVERSE,
  completeConfig,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
export { HormoneRepository } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-emotion-hormone'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-emotion-hormone: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 激素维度服务；未装载本插件时为 undefined。 */
    'ondra-emotion-hormone'?: HormoneService
  }
}

/**
 * Cordis 入口：接线、注册服务。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: HormoneConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('emotion-hormone') : 'ondra.emotion.hormone') as unknown) as LogLike

  // 1. 配置：有 O-005 就走四层合并（并能说出「哪一层的哪个字段」）。
  const raw: Record<string, unknown> = isRecord(config) ? config : {}
  let effective: unknown = raw
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  if (schema !== undefined && registerSection(ctx, schema, log)) {
    try {
      const resolved = schema.resolve(CONFIG_SECTION_ID, { user: raw })
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

  // 2. 情绪读数用**延迟取值**：装载顺序不确定，构造时拿不到不代表以后拿得到。
  const service = new HormoneRepository(settings, log, () => Date.now(), () => {
    const emotion = ctx.get('ondra-emotion-core') as EmotionLike | undefined
    return emotion
  })
  ctx.effect(() => ctx.provide(HORMONE_SERVICE_KEY, service), 'ondra-emotion-hormone: 注册激素维度')

  // 3. 关闭态：注册完就停，不补造、不读数——关掉的插件不该产生任何副作用。
  if (!service.available) {
    log.debug?.('激素维度已注册但总开关关闭（默认关闭）：读数给出厂基线，叠加一律平稳')
    return
  }

  // 4. 补造缺失维度（只补动态那一类；核心维度本来就存在）。
  //    包 try/catch：补造失败不该让插件加载失败。
  if (settings.autoSeed) {
    try {
      const outcome = service.ensure()
      if (outcome.refused.length > 0) {
        log.warn('自动补造未完全成功：%s', outcome.refused.join('、'))
      }
    } catch (error) {
      log.warn('自动补造激素维度失败（不影响读数，缺失维度按基线代入）：%s', messageOf(error))
    }
  }

  // 5. 报一次现状（§12.2：可用性、来源、降级原因都要能被自检读到，不许黑箱）。
  try {
    const stats = service.stats()
    const overlay = service.overlay()
    log.info(
      '激素维度就绪：来源 %s，倾向 %s（负荷 %.2f / 驱动 %.2f / 联结 %.2f），已补 %d 维',
      stats.source === 'emotion' ? '情绪服务' : '出厂基线（未接情绪服务）',
      overlay.tilt,
      overlay.load,
      overlay.drive,
      overlay.bond,
      stats.seeded.length,
    )
  } catch (error) {
    // 收尾日志失败绝不能让 apply 抛出——抛了就是「插件加载失败」。
    log.warn('激素维度状态汇报失败（不影响服务）：%s', messageOf(error))
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 口径：**能补的全补，补不了的才报 issue**。配置错不该让插件不加载，
 * 只该让某个字段回退默认并被记下来。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: HormoneConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // `completeConfig` 永不抛错：非法值一律回退默认，都是「能补的」。
      return { value: completeConfig(value) }
    },
  },
}

/** 维度名的合法集合（供 O-005 的枚举校验与面板取用）。 */
export const HORMONE_NAMES: readonly string[] = Object.freeze(Object.keys(HORMONE_SPECS))
