/**
 * O-023 `ondra-persona-assemble`：四段拼装 + 预算裁剪 + `overBudget` 上报（〔研〕自研）。
 *
 * 为什么是自研：手册 §1.8 的三档里没有「人格提示词拼装与预算」。
 * 唯一可参照的是 `dsh-chain` 的**装箱制**（MIT，手册 §2.6 与 §13.8 逐字引用过它的原话），
 * 本插件照它的**机制**重写，不引代码；而「四段固定顺序 + 边界层整层豁免 + 按槽位裁」
 * 这三条是本仓的产品定案，生态里没有。
 *
 * 真正自研的只有三样（其余全是接线）：
 * 1. **装箱与豁免**（`sections.ts`，含「装不下跳过继续试」与三轮标题收敛）；
 * 2. **按槽位裁内核，且先与上游对拍**（`service.ts` + `text.ts` 的 `sameKernel()`）；
 * 3. **`overBudget` 与降级说明**（`sections.ts` 的报告，四类降级全部进 `degradations`）。
 *
 * 四条写死在这里、防止下一轮有人顺手改的边界：
 * - **四段顺序恒为「内核 → 关系微调 → 浓度 → 边界」。** `priority` 只用于裁剪。
 * - **边界层整层豁免裁剪。** 宁可 `overBudget: true`，也不悄悄少一条禁令。
 * - **不切字。** 只有「单元带走 / 不带」，没有 `slice`。
 * - **不做摘要、不压缩人格。** 压缩只发生在对话历史的用户回合边界（§8.5），不在这里。
 */

import type { Context } from '@ntars/cordis'
import { AssembleRepository } from './service.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as AssembleConfig } from './settings.js'
import { ASSEMBLE_SERVICE_KEY } from './types.js'
import type {
  AssembleService,
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  PersonaCoreLike,
  PersonaVarsLike,
} from './types.js'

// 契约里既有纯类型也有运行时值（服务键、段 id 表、预算预设），分开导出才不违背
// 「类型导入不得混入运行时值」这条自检项。
export type * from './types.js'
export { ASSEMBLE_SERVICE_KEY, BUDGET_PRESETS, SECTION_IDS } from './types.js'
export { AssembleRepository, ASSEMBLY_ORDER } from './service.js'
export {
  UNIT_PRIORITY,
  boundaryUnit,
  composeAssembly,
  emptyAssembly,
  extraUnit,
  headingOf,
  kernelWholeUnit,
  pack,
  priorityOf,
  relationUnit,
  slotUnit,
  toneUnit,
} from './sections.js'
export type { ComposeAssemblyInput } from './sections.js'
export { charCount, normalizeBlank, sameKernel, trimBlank } from './text.js'
export {
  BUDGET_MAX,
  BUDGET_MIN,
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  clampBudget,
  completeConfig,
} from './settings.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-persona-assemble'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-persona-assemble: 注册配置段')
    return true
  } catch (error) {
    // 注册失败不是致命：四层合并与来源追溯用不上，插件实例配置照样能跑。
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 人格四段拼装服务；未装载本插件时为 undefined。 */
    'ondra-persona-assemble'?: AssembleService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：声明 `inject: ['ondra-persona-core']` 后，
 * 内核缺席会让整个插件停在 PENDING——那时下游拿到的是「什么都没有」，
 * 而不是「一个说清为什么空的结果」。改成「照常注册 + `available=false`」，
 * 对话层能区别「没装人格」与「人格拼装挂了」。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: AssembleConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('persona-assemble') : 'ondra.persona-assemble') as unknown) as LogLike

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

  // 2. 上游**每轮现取**，不存实例（见 service.ts 文件头第 1 条）。
  const coreOf = (): PersonaCoreLike | undefined => ctx.get('ondra-persona-core') as PersonaCoreLike | undefined
  const varsOf = (): PersonaVarsLike | undefined => ctx.get('ondra-persona-vars') as PersonaVarsLike | undefined

  const repository = new AssembleRepository(coreOf, varsOf, log, settings)
  ctx.effect(() => ctx.provide(ASSEMBLE_SERVICE_KEY, repository), 'ondra-persona-assemble: 注册四段拼装服务')

  // 3. 报一次现状。预算、四段是否齐、能不能拼，都要能被自检读到（§12.2）。
  if (!repository.available) {
    log.warn(
      '四段拼装服务已注册但不可用（%s）：%s',
      repository.reason ?? '未知原因',
      repository.reason === 'disabled'
        ? '总开关被关（enable=false）'
        : '没有装载 ondra-persona-core（O-021）或它不可用——没有任何人格可拼',
    )
    return
  }
  const stats = repository.stats()
  log.info(
    '四段拼装就绪：预算 %d 字符，人格内核在位 %s，变量与浓度在位 %s',
    stats.budgetChars,
    stats.corePresent ? '是' : '否',
    stats.varsPresent ? '是' : '否',
  )
  if (!stats.varsPresent) {
    // 这条必须说出来：没有 O-022 时内核里的 {{user}} 会原样留在提示词里，
    // 而现象是「她开始念花括号」——不说清就没人查得到根因。
    log.info('未装载 ondra-persona-vars（O-022）：占位符原样保留、没有浓度段，内核与边界照常拼')
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
    ) => { readonly value: AssembleConfig } | { readonly issues: readonly { readonly message: string }[] }
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
