/**
 * O-025 `ondra-worldbook-scenes`：场景卡数据、关键词触发、同层互斥、递归 ≤3（〔研〕自研）。
 *
 * 为什么是自研：手册 §1.8 的三档里没有「场景卡」。生态里最接近的是角色卡里的
 * "scene examples"（SillyTavern，AGPL，只可读思路），它给的是**示例对话**，
 * 而本插件要的是「触发 → 骨架 → 硬规则」这套可判定的结构；这套结构直接来自
 * 两个人设包 `references/scenes.md` 的真实格式，生态里没有对应实现。
 *
 * 真正自研的只有三样（其余全是接线）：
 * 1. **场景卡解析**（`parse.ts`，按真实文件的六栏格式写，认不出的行报出来）；
 * 2. **触发判定**（`trigger.ts`：抽词、否定邻域、互斥、递归闭包）；
 * 3. **渲染剔除**（`service.ts`：`内心` 与 `触发` 永不进提示词）。
 *
 * 五条写死在这里、防止下一轮有人顺手改的边界：
 * - **一轮只用一张骨架**（默认按章节组互斥）。两张卡同时生效 = 互相矛盾的指令。
 * - **`内心` 永不进提示词**，没有开关。
 * - **递归 ≤3 是宪法**，配大了夹回 3 并告警。
 * - **不在 `plan()` 里读盘**：只比一次 `activeId()`，变了才重解析。
 * - **不自己算预算**：token 数问 O-024，问不到按字符数当上限。
 */

import type { Context } from '@ntars/cordis'
import { SceneRepository } from './service.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  MAX_DEPTH_LIMIT,
  completeConfig,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as ScenesConfig } from './settings.js'
import { SCENES_SERVICE_KEY } from './types.js'
import type {
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  PersonaLoaderLike,
  ScenesService,
  WorldbookLike,
} from './types.js'

// 契约里既有纯类型也有运行时值（服务键、层表、深度上限），分开导出才不违背
// 「类型导入不得混入运行时值」这条自检项。
export type * from './types.js'
export { LAYER_IDS, SCENES_SERVICE_KEY } from './types.js'
export { SceneRepository, baseLabel, renderCard, visibleFields } from './service.js'
export type { SceneDeps } from './service.js'
export { parseScenes, splitInline, stripOrdinal, titleKeyOf } from './parse.js'
export {
  applyExclusion,
  countTerm,
  expand,
  extractTerms,
  extractTitleTerms,
  isUsableTerm,
  judge,
  mergeTerms,
  normalize,
  prepare,
  scoreCard,
  tighten,
} from './trigger.js'
export type { CardScore, ExpandInput, JudgeInput } from './trigger.js'
export {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  MAX_DEPTH_LIMIT,
  MIN_TERM_CHARS_MAX,
  MIN_TERM_CHARS_MIN,
  SCENES_FILE_MAX,
  SECTION_KEYS,
  clampInteger,
  clampNumber,
  completeConfig,
  normalizeRelPath,
} from './settings.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-worldbook-scenes'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-worldbook-scenes: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 场景卡服务；未装载本插件时为 undefined。 */
    'ondra-worldbook-scenes'?: ScenesService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册、报现状。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：声明后人设加载器缺席会让整个插件停在 PENDING，
 * 那时下游拿到 `undefined`，分不清「没人设」与「场景卡插件挂了」。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: ScenesConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(
    identity ? identity.loggerName('worldbook-scenes') : 'ondra.worldbook-scenes',
  ) as unknown) as LogLike

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

  // 2. 上游**每轮现取**：装载顺序不确定，构造时取一次会在"晚装载"的宿主里永远拿不到。
  const loaderOf = (): PersonaLoaderLike | undefined =>
    ctx.get('ondra-persona-loader') as PersonaLoaderLike | undefined
  const worldbookOf = (): WorldbookLike | undefined => ctx.get('ondra-worldbook') as WorldbookLike | undefined

  const repository = new SceneRepository({
    config: settings,
    log,
    loader: loaderOf(),
    worldbook: worldbookOf(),
  })

  ctx.effect(() => ctx.provide(SCENES_SERVICE_KEY, repository), 'ondra-worldbook-scenes: 注册场景卡服务')

  // 3. 报一次现状。卡片数、组数、有没有"永不命中"的卡，都要能被自检读到（§12.2）。
  const stats = repository.stats()
  if (!stats.available) {
    log.info(
      '场景卡服务已注册但不可用（%s）：%s',
      stats.reason ?? '未知原因',
      stats.reason === 'no-loader'
        ? '没有装载 ondra-persona-loader（O-020），读不到人设包'
        : stats.reason === 'no-persona'
          ? '当前没有人设：先在设置里选一个人设'
          : stats.reason === 'no-file'
            ? '人设包里没有 ' + settings.scenesFile + '（这个包可能没写场景卡）'
            : '场景文件读到了，但一张卡都解析不出来（格式与预期不符）',
    )
    return
  }
  log.info(
    '场景卡就绪：%d 张（%d 组，平均 %s 个触发词，互斥粒度 %s，递归上限 %d）',
    stats.cards,
    stats.groups,
    stats.avgTriggers.toFixed(1),
    stats.exclusion,
    stats.maxDepth,
  )
  if (stats.mute > 0) {
    log.warn('其中 %d 张卡抽不出触发词，永远不会命中（见上面的逐条告警）', stats.mute)
  }
  if (stats.unknownLines > 0) {
    log.warn('场景文件有 %d 行认不出，已跳过', stats.unknownLines)
  }
  if (settings.maxDepth > MAX_DEPTH_LIMIT) {
    // 理论上 `completeConfig` 已经夹过；留这条是为了「有人绕过配置直接传参」时也能喊一声。
    log.warn('递归上限被夹到 %d（台账规定 ≤%d）', MAX_DEPTH_LIMIT, MAX_DEPTH_LIMIT)
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
    ) => { readonly value: ScenesConfig } | { readonly issues: readonly { readonly message: string }[] }
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
