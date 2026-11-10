/**
 * O-128 `ondra-multimodal-memory`：把「看见的」与「听见的」记成记忆（手册 §1.5，P1）。
 *
 * ## 一句话
 *
 * 用户发来一张图或一段语音，O-126 / O-127 把它变成文字，本包把这些文字
 * 按普通记忆写进 O-010，并额外记住「它是从哪个文件来的」。
 *
 * ## 装载期只做三件事
 *
 * 1. 解析配置（有 O-005 就走四层合并，没有就用本地校验）；
 * 2. 建服务并 `provide`——**不建表、不调模型、不探文件**：
 *    边表懒建（第一次要写时才建），模型调用归上游两个包；
 * 3. 把「为什么现在不能入库」逐条打出来（关着 / 没有记忆内核）。
 *
 * ## 刻意不声明插件级 `inject`
 *
 * 六个消费方（`ondra-memory-core` / `ondra-store-*` / `ondra-evidence-gate` /
 * `ondra-config-schema` / `ondra-identity` / `ondra-clock`）全是软依赖。
 * 声明 `inject` 会让缺一个就整包停 PENDING，而本包的整个设计前提是
 * 「缺谁就少哪一块，但要说得出缺了谁」——静默停 PENDING 连这句都说不出。
 *
 * ## 本包不出站
 *
 * 它不发任何网络请求：描述与转写都在上游两个包，出站裁决也在那两个包
 * （它们各自向 O-076 登记）。所以本包**不登记出站能力**——多登记一条
 * 等于让 privacy 面板多一个永远不会发生的出站项，那是在骗用户。
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
import type { Config as MmConfig } from './settings.js'
import { MultimodalMemory } from './service.js'
import type { MmDeps } from './service.js'
import { MmIndex } from './table.js'
import { MM_SERVICE_KEY } from './types.js'
import type {
  AsrLike,
  ConfigSchemaLike,
  EvidenceGateLike,
  IdentityLike,
  LogLike,
  MemoryCoreLike,
  MultimodalMemoryService,
  StoreLike,
  VisionLike,
} from './types.js'

export type * from './types.js'
export {
  MM_SERVICE_KEY,
  NAME_RE,
  MM_TABLE,
  MM_REASONS,
  MODALITIES,
  MEMORY_KINDS_LIKE,
  MEMORY_CATEGORIES_LIKE,
  MEMORY_CHANNELS_LIKE,
} from './types.js'
export {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  FRAMES_MAX,
  FRAMES_MIN,
  FULL_MAX,
  FULL_MIN,
  SUBJECT_MAX,
  SUMMARY_MAX,
  TEXT_MAX,
  TEXT_MIN,
  TITLE_MAX,
  TITLE_MIN,
  completeConfig,
  configDriftOf,
  isMemoryCategory,
  isMemoryChannel,
  isMemoryKind,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
export {
  FRAME_DESC_MAX,
  PATH_MAX,
  composeFramesText,
  defaultCategoryOf,
  defaultKindOf,
  evidenceSourceOf,
  isModality,
  normalizeDraft,
  sanitizeBoxes,
  sanitizeFrames,
  sanitizeSpans,
} from './draft.js'
export { charsOf, clip, fingerprintOf, fnv1a64, messageOf, squeeze, titleOf } from './text.js'
export { LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX, MmIndex } from './table.js'
export { MultimodalMemory, defaultsOf } from './service.js'
export type { MmDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-multimodal-memory'

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
    /** 多模态记忆；未装载本插件时为 undefined。 */
    'ondra-multimodal-memory'?: MultimodalMemoryService
  }
}

/**
 * Cordis 入口：解析配置、装服务。**永不抛错**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: MmConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log: LogLike = ctx.logger(identity ? identity.loggerName('multimodal-memory') : 'ondra.multimodal-memory')

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

  /**
   * 边表实例：**懒创建**。
   *
   * 装载顺序不定——`ondra-store-sqlite` 可能比本包晚一点注册。在 `apply()` 里
   * 抓一次，抓不到就永久没有边表；改成第一次真正要写时才抓，能把
   * 「存储晚装了三毫秒」这种时序问题挡掉。
   */
  let indexInstance: MmIndex | undefined
  const indexOf = (): MmIndex | undefined => {
    if (indexInstance !== undefined) return indexInstance
    const store = (ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')) as
      | StoreLike
      | undefined
    if (store === undefined) return undefined
    indexInstance = new MmIndex(store, log)
    return indexInstance
  }

  const deps: MmDeps = {
    settings: () => settings,
    log,
    now: () => {
      const clock = ctx.get('ondra-clock') as { now(): number } | undefined
      return clock === undefined ? Date.now() : clock.now()
    },
    core: () => ctx.get('ondra-memory-core') as MemoryCoreLike | undefined,
    gate: () => ctx.get('ondra-evidence-gate') as EvidenceGateLike | undefined,
    index: indexOf,
    vision: () => ctx.get('ondra-vision') as VisionLike | undefined,
    asr: () => ctx.get('ondra-asr') as AsrLike | undefined,
  }

  const service = new MultimodalMemory(deps)

  ctx.effect(
    () => {
      const removeService = ctx.provide(MM_SERVICE_KEY, service)
      return () => {
        service.dispose()
        removeService()
      }
    },
    'ondra-multimodal-memory: 注册多模态记忆服务',
  )

  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被夹紧或丢弃（与你设的不一样）：%s', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('多模态入库关着：服务仍注册（available=false），面板能读到「关着」')
    return
  }

  const core = ctx.get('ondra-memory-core') as MemoryCoreLike | undefined
  if (core === undefined || !core.available) {
    log.warn(
      '没有可用的 ondra-memory-core：本包不自己存记忆（那会变成第二份记忆库），现在一律 no-core',
    )
    return
  }

  if (indexOf() === undefined) {
    log.warn('没有存储端口（ondra-store-sqlite / ondra-store-memory）：记忆照常入库，但查不到「来自哪张图」')
  }

  const gate = ctx.get('ondra-evidence-gate') as EvidenceGateLike | undefined
  if (gate === undefined || !gate.available) {
    log.info('没有 ondra-evidence-gate：入库不过证据闸，结果里会带 no-gate 降级说明')
  }

  const vision = ctx.get('ondra-vision') as VisionLike | undefined
  const asr = ctx.get('ondra-asr') as AsrLike | undefined
  log.info(
    '多模态入库：条目上限 %d 字，全文留档 %d 字；视频抽 %d 帧（描述%s）；抽帧%s，转写%s',
    settings.maxTextChars,
    settings.maxFullChars,
    settings.videoFrames,
    settings.videoDescribeFrames ? '开' : '关',
    vision === undefined || !vision.available ? '不可用' : '可用',
    asr === undefined || !asr.available ? '不可用' : '可用',
  )
  log.info('本包不建界面、不拼提示词、不发请求：界面归应用外壳，出站归 O-126 / O-127')
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
    ) => { readonly value: MmConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能安全补全（越界夹紧、坏枚举回退），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
