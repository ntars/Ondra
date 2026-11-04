/**
 * O-022 `ondra-persona-vars`：变量替换与说话浓度提示（〔研〕自研）。
 *
 * 为什么是自研：手册 §1.8 的复用档与薄封装档里都没有「人格变量与浓度」这一项。
 * 生态里的做法是角色卡模板引擎（`{{char}}` / `{{user}}` 替换），那部分本插件
 * **只借鉴语法、不引代码**；而「说话浓度滑杆」是手册 §7.4 的产品定案，
 * 没有任何现成实现——它是这个产品特有的「同一份人格的浓淡刻度」。
 *
 * 真正自研的只有三样（其余全是接线）：
 * 1. **闭集变量表与占位符替换**（`vars.ts`，含「未知/无值原样保留」三条边界）；
 * 2. **五档浓度与每档的越界护栏**（`tone.ts`，每档都夹一句「不新增词」）；
 * 3. **取值优先级与来源追溯**（`service.ts`，`input > config > persona > default`）。
 *
 * 三条写死在这里、防止下一轮有人顺手改的边界：
 * - **不改写人设正文。** 替换只把占位符换成值，其余一个字不动。
 * - **浓度不写进内核。** 它永远是独立一段（`order = 2`），拼装归 O-023。
 * - **不引入时间/情绪变量。** 它们会让前缀缓存命中率归零（§8.5）。
 */

import type { Context } from '@ntars/cordis'
import { VarsRepository } from './service.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as VarsConfig } from './settings.js'
import { VARS_SERVICE_KEY } from './types.js'
import type { ConfigSchemaLike, IdentityLike, LogLike, PersonaCoreLike, VarsService } from './types.js'

// 契约里既有纯类型也有运行时值（服务键、变量名表、档位 id 表），分开导出才不违背
// 「类型导入不得混入运行时值」这条自检项。
export type * from './types.js'
export { VAR_NAMES, VARS_SERVICE_KEY, TONE_BAND_IDS } from './types.js'
export { VarsRepository } from './service.js'
export {
  ALIAS_CONFLICTS,
  VAR_ALIASES,
  VAR_LABELS,
  aliasOf,
  charCount,
  entriesOf,
  replacePlaceholders,
  tableOf,
} from './vars.js'
export type { ReplaceStats, VarValue, VarValueTable } from './vars.js'
export {
  BAND_ORDER,
  BAND_SAMPLES,
  LEGACY_LEVELS,
  TONE_BANDS,
  bandOf,
  clampLevel,
  toneSectionOf,
} from './tone.js'
export {
  CHAR_NAME_MAX,
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  USER_ADDRESS_MAX,
  completeConfig,
  normalizeShortWord,
} from './settings.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-persona-vars'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-persona-vars: 注册配置段')
    return true
  } catch (error) {
    // 注册失败不是致命：四层合并与来源追溯用不上，插件实例配置照样能跑。
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 人格变量与浓度服务；未装载本插件时为 undefined。 */
    'ondra-persona-vars'?: VarsService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：只有 `ondra-persona-core` 缺席时本插件仍然能用
 * （三个变量里两个不依赖上游，浓度段完全不依赖），声明 `inject` 会让
 * 整个插件停在 PENDING——那是最难查的失败形态。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: VarsConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('persona-vars') : 'ondra.persona-vars') as unknown) as LogLike

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

  // 2. 上游**每轮现取**，不存实例：装载顺序不确定，存下来的 undefined 会让
  //    「谁先上」决定她怎么称呼你（见 service.ts 文件头第 1 条）。
  const coreOf = (): PersonaCoreLike | undefined => ctx.get('ondra-persona-core') as PersonaCoreLike | undefined

  const repository = new VarsRepository(coreOf, log, settings)
  ctx.effect(() => ctx.provide(VARS_SERVICE_KEY, repository), 'ondra-persona-vars: 注册人格变量服务')

  // 3. 报一次现状。档位、称呼来源、关系名能不能拿到，都要能被自检读到（§12.2）。
  if (!repository.available) {
    log.warn('人格变量服务已注册但不可用（%s）：总开关被关（enable=false）', repository.reason ?? '未知原因')
    return
  }
  const stats = repository.stats()
  log.info(
    '人格变量就绪：浓度 %d（%s），称呼「%s」（来源 %s），关系名「%s」，浓度段 %d 字',
    stats.level,
    stats.band,
    stats.userAddress,
    stats.userSource,
    stats.relationLabel === '' ? '（拿不到）' : stats.relationLabel,
    stats.toneChars,
  )
  if (stats.userSource === 'default') {
    // 这条必须说出来：「她一直叫你『你』」有两种原因（用户没设 / 设了没生效），
    // 而两者在日志里长得一样。这条日志把它缩到只有一种。
    log.info('「怎么称呼你」还是兜底值——人设设置里填一次 userAddress 就会换成你填的称呼')
  }
  if (!stats.corePresent) {
    log.info('没有装载 ondra-persona-core（O-021）：{{relation}} 原样保留，其余变量与浓度段照常工作')
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
    ) => { readonly value: VarsConfig } | { readonly issues: readonly { readonly message: string }[] }
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
