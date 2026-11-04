/**
 * O-021 `ondra-persona-core`：L1 内核 + 五关系变体 + 六槽位（〔研〕自研）。
 *
 * 为什么是自研：手册 §1.8 的复用档里没有「人格内核装配」这一项，而生态里的
 * 人格插件（`dsh-catgirl-plugin` 一类）做的是「一段写死的角色 prompt」——
 * 没有槽位、没有关系变体、没有「缺哪一段」的报告。本插件要的是**可拆可换的六段**
 * 与**只改关系不改人格的五个变体**，这两件事没有现成实现。
 *
 * 真正自研的只有三样（其余全是接线）：
 * 1. **六槽位的切分与映射**（`slots.ts` 一张表 + 切分器，含代码围栏处理）；
 * 2. **五关系变体的「只写关系差异」约束**（`variants.ts`，字段本身就是约束）；
 * 3. **内核缓存与探活**（`service.ts`，键含人设版本）。
 *
 * 三条写死在这里、防止下一轮有人顺手改的边界：
 * - **不改写人设正文。** 槽位正文是 `SKILL.md` 的原样切片。
 * - **不裁剪、不加浓度、不加边界。** 裁剪归 O-023、浓度归 O-022、
 *   边界由 O-023 / O-037 从 `boundaries()` 取。
 * - **不切人设。** 本插件没有 `setActive`：一旦组装内核的插件能决定「用谁」，
 *   就会出现「插件装载顺序决定了她是谁」这种查不出来的故障。
 */

import type { Context } from '@ntars/cordis'
import { PersonaCoreRepository } from './service.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as PersonaCoreConfig } from './settings.js'
import { PERSONA_CORE_SERVICE_KEY } from './types.js'
import type { ConfigSchemaLike, IdentityLike, LogLike, PersonaCoreService, PersonaLoaderLike } from './types.js'

// 契约里既有纯类型也有运行时值（服务键、槽位 id 表、变体表），分开导出才不违背
// 「类型导入不得混入运行时值」这条自检项。
export type * from './types.js'
export { PERSONA_CORE_SERVICE_KEY, SLOT_IDS, AUX_IDS, BUILTIN_RELATION_IDS } from './types.js'
export { PersonaCoreRepository } from './service.js'
export {
  AUX_SPECS,
  SLOT_SPECS,
  charCount,
  classifyHeading,
  layoutOf,
  splitItems,
  splitSections,
  stripFrontmatter,
} from './slots.js'
export { SKILL_FILE, activationOf, boundaryItemsOf, buildKernel, kernelOfLayout, kernelTextOf, referenceEntriesOf } from './kernel.js'
export { RELATION_VARIANTS, deltasOf, relationSectionOf, variantOf } from './variants.js'
export {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  RELATION_IDS,
  SECTION_KEYS,
  completeConfig,
  effectiveRelation,
  isRelationId,
} from './settings.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-persona-core'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-persona-core: 注册配置段')
    return true
  } catch (error) {
    // 注册失败不是致命：四层合并与来源追溯用不上，插件实例配置照样能跑。
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 人格内核服务；未装载本插件时为 undefined。 */
    'ondra-persona-core'?: PersonaCoreService
  }
}

/**
 * Cordis 入口：解析配置、建内核服务、注册。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：声明 `inject: ['ondra-persona-loader']` 后，
 * 加载器缺席会让整个插件停在 PENDING（静默不加载，最难查的失败形态）。
 * 改成「照常注册 + `available=false` 说清原因」，下游能区分
 * 「没装加载器」与「装了但人设包里没有 SKILL.md」。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: PersonaCoreConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('persona-core') : 'ondra.persona-core') as unknown) as LogLike

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

  // 2. 加载器**每轮现取**，不存实例：装载顺序不确定，存下来的 undefined 会让
  //    「谁先上」决定她的内核能不能出来（见 service.ts 文件头第 1 条）。
  const loaderOf = (): PersonaLoaderLike | undefined => ctx.get('ondra-persona-loader') as PersonaLoaderLike | undefined

  const repository = new PersonaCoreRepository(loaderOf, log, settings)
  ctx.effect(() => ctx.provide(PERSONA_CORE_SERVICE_KEY, repository), 'ondra-persona-core: 注册人格内核服务')

  // 3. 报一次现状。可用性、人设、缺槽位、字数、关系，都要能被自检读到（§12.2）。
  const stats = repository.stats()
  if (!stats.available) {
    log.warn('人格内核服务已注册但不可用（%s）：%s', stats.reason ?? '未知原因', hintOf(stats.reason))
    return
  }
  log.info(
    '人格内核就绪：人设 %s，关系 %s，六槽位缺 %d 个，内核 %d 字，边界 %d 条',
    stats.personaId ?? '（无）',
    stats.relation,
    stats.missingCount,
    stats.kernelChars,
    stats.boundaryCount,
  )
  const kernel = repository.kernel()
  if (kernel !== undefined && kernel.missing.length > 0) {
    // 缺槽位不是「不可用」，但必须说出来：缺的往往是「自检」或「格式」，
    // 而这两段缺失的直接后果是「她说话像了，但每次都要人提醒才收尾」。
    log.warn(
      '人设「%s」缺 %d 个槽位：%s（内核照常出，缺的那段留空，不拿别的段落顶替）',
      kernel.personaId,
      kernel.missing.length,
      kernel.missing.join(' / '),
    )
  }
  if (kernel !== undefined && kernel.extras.length > 0 && !settings.includeExtras) {
    log.info(
      '人设「%s」有 %d 段没被映射到槽位（%s），默认不进内核；要带上请开 includeExtras',
      kernel.personaId,
      kernel.extras.length,
      kernel.extras.map(extra => extra.heading.replace(/^#+\s*/, '')).join(' / '),
    )
  }
}

/** 把不可用原因翻成一句能照做的话。 */
function hintOf(reason: string | undefined): string {
  switch (reason) {
    case 'disabled':
      return '总开关被关（enable=false）'
    case 'no-loader':
      return '没有装载 ondra-persona-loader（O-020），拿不到任何人设包'
    case 'no-persona':
      return '配置的人设不存在，或加载器里还没有当前人设——请检查 personaId 与 ondra-persona-skills 目录'
    case 'no-skill':
      return '人设包在，但里面没有可读的 SKILL.md'
    default:
      return '未知原因'
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
    ) => { readonly value: PersonaCoreConfig } | { readonly issues: readonly { readonly message: string }[] }
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
