/**
 * O-036 `ondra-prompt-inject`：注入装箱（〔研〕自研）。
 *
 * 手册 §2.6 的原文是这一句：「拿字符预算往里装，按权重全局排序逐条装；
 * 装不下就跳过这条、继续试下一条（不是整段停）；装不下的条数写在段标题里」。
 * 本插件的全部结构都为这一句服务：
 *
 * ```
 *   gather()  ── 八块取材（每块各自 try/catch，缺谁只少一块）
 *     │
 *   pack()    ── 核心段整块装；其余全局按权重逐条试，装不下跳过
 *     │
 *   render()  ── 段标题 + 正文；段标题里写「另有 N 条未展开」
 * ```
 *
 * ## 为什么是〔研〕而不是〔薄〕
 *
 * 生态里现成的记忆注入都是「检索 topK 拼字符串」（mem0 / 各家 RAG 都是这个形状）。
 * 手册要的是**装箱**：没有条数上限、装不下要报数、核心段豁免。
 * 这三条与 topK 是互斥的语义——套一层适配只能改名字，改不了行为，所以自己写。
 * 唯一可复用的是「行格式」这种文本约定，而那本来就只有几行。
 *
 * ## 明确不做
 *
 * - **不碰人格段**：人格四段归 O-023、由 O-033 冻结成前缀。注入是易变段，
 *   写进前缀就是把缓存命中率打回 0（§8.5）。
 * - **不做去重记账**：已见 id 的读写归 O-142；本插件只接受一个 `seen` 集合，
 *   并把 `suppressed` 与 `dropped` 分开报，让它能分清「该释放已见」还是「该加预算」。
 * - **不注册工具**：`chain_recall` 的模型侧入口归 O-132 / O-138 的门面；
 *   本插件只提供 `expand()`，注册工具要 `inject: ['tools']`，那会让上游缺席时整插件 PENDING。
 *
 * ## 与宿主的关系
 *
 * `apply()` 末尾把 `render()` 的正文挂进宿主 `systemPrompt` 的一条运行时上下文
 * （`ondra:injection`，order 220，不插值）。这是 `render()` 唯一的对外出口：
 * 这条边不接，七块取材全在空转，而日志里只有一行「就绪」，谁也看不出没接上。
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
import type { Config as InjectConfig } from './settings.js'
import { Injection } from './service.js'
import { INJECT_SERVICE_KEY, NAME_RE, PROMPT_CONTEXT_NAME, PROMPT_CONTEXT_ORDER } from './types.js'
import type {
  AuditLike,
  ConfigSchemaLike,
  CoreLike,
  DecayLike,
  HumanlikeLike,
  IdentityLike,
  InjectionService,
  LogLike,
  PoolLike,
  ProspectiveLike,
  RecallLike,
  Sources,
  SystemPromptLike,
} from './types.js'

export type * from './types.js'
export { INJECT_SERVICE_KEY, NAME_RE, BLOCK_IDS, BLOCK_SPECS, BUDGET_PRESETS, PROMPT_CONTEXT_NAME, PROMPT_CONTEXT_ORDER } from './types.js'
export { budgetOf, capsOf, CONFIG_SECTION_ID } from './settings.js'
export { anniversaryOf } from './blocks.js'
export { djb2, formatLine, headingOf } from './format.js'
export { pack } from './pack.js'
export { refOf } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-prompt-inject'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 向 O-005 注册配置段。
 *
 * 放进 `ctx.effect`：段是本插件的资源，卸载时必须一起撤。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 注册是否成功。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-prompt-inject: 注册配置段')
    return true
  } catch (error) {
    log.warn(
      '向 ondra-config-schema 注册配置段失败（四层合并与来源追溯不可用，退回插件实例配置）：%s',
      messageOf(error),
    )
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 注入装箱服务；未装载本插件时为 undefined。 */
    'ondra-prompt-inject'?: InjectionService
  }
}

/**
 * Cordis 入口：解析配置、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：`inject` 里有任何一个上游缺席，整个插件会停在
 * PENDING（静默不加载，最难查的失败形态）。这里全部改成取值函数，
 * 缺谁就少一块并在 `degradations` 里留痕。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: InjectConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('prompt-inject') : 'ondra.prompt-inject')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  // 1. 有 O-005 就让配置走四层合并（出问题时能说出「哪一层的哪个字段」）。
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  if (schema !== undefined && registerSection(ctx, schema, log)) {
    try {
      const resolved = schema.resolve(CONFIG_SECTION_ID, { user: normalizeUserLayer(raw) })
      if (resolved !== undefined) {
        effective = valuesToConfigShape(resolved.values)
        if (resolved.fallbackCount > 0) {
          // 回退是静默的危险动作：不报数等于埋雷（O-005 原话）。
          log.warn('配置有 %d 个字段校验失败，已逐个回退默认值', resolved.fallbackCount)
        }
      }
    } catch (error) {
      log.warn('解析配置段失败，退回插件实例配置：%s', messageOf(error))
    }
  }

  // 2. 补全 + 校验。任何非法值都回退默认，绝不抛。
  const settings = completeConfig(effective)

  // 3. 依赖全部用取值函数：上游晚装载时能自愈，早卸载时立刻反映。
  //    上游服务键都是 Cordis 的字符串重载，类型声明在别的包里，本插件不许 import（§15.5），
  //    所以取回来立刻按结构对位断言。拼错键不会被编译器发现，但会走已实现的降级路径。
  const sources: Sources = {
    prospective: () => ctx.get('ondra-memory-prospective') as ProspectiveLike | undefined,
    audit: () => ctx.get('ondra-memory-audit') as AuditLike | undefined,
    core: () => ctx.get('ondra-memory-core') as CoreLike | undefined,
    recall: () => ctx.get('ondra-memory-recall') as RecallLike | undefined,
    humanlike: () => ctx.get('ondra-memory-humanlike') as HumanlikeLike | undefined,
    decay: () => ctx.get('ondra-memory-decay') as DecayLike | undefined,
    pool: () => ctx.get('ondra-memory-pool') as PoolLike | undefined,
  }

  const injection = new Injection({ settings, log, sources, now: () => Date.now() })

  ctx.effect(() => ctx.provide(INJECT_SERVICE_KEY, injection), 'ondra-prompt-inject: 注册注入装箱')

  // 4. 挂进宿主的系统提示词。
  //
  //    为什么是「运行时上下文」而不是「提示词章节」：本插件自己的纪律写着
  //    「注入是易变段，写进前缀就是把缓存命中率打回 0」（§8.5）。宿主把 context
  //    物化成一条用户角色快照——不进缓存前缀、每轮重取，语义正好对上。
  //
  //    为什么在这里挂：`render()` 是本插件唯一的对外正文出口，而此前全仓没人读它
  //    （注入装箱照常启动、照常打「就绪」日志，然后什么也不发生）。宿主装配链里
  //    没有第二个地方会去问「她这轮想起了什么」。这条边不接，下游七块全是空转。
  //
  //    宿主没有 `systemPrompt`（精简 profile）时**不阻断**，只留一行日志。
  //    `systemPrompt` 是异步就绪的：插件树走到这里时它往往还没 provide，当场
  //    `ctx.get` 取不到不等于「宿主没有」。此前这里直接 return，症状是八块全部
  //    空转、界面永远「暂无记忆」，而日志只有一行 warn（还常被静默）。故改为
  //    取不到就等它出现，出现即挂；它被卸载时挂接也随之撤销。
  const attach = (prompt: SystemPromptLike): void => {
    // 装配期可能被反复调用；渲染失败只报第一次，避免每轮刷屏。
    let renderFailureReported = false
    const textForPrompt = (context: { readonly query?: string }): string => {
      if (!injection.available) return ''
      try {
        // 话头由宿主随装配上下文传入（本轮用户输入的原文本）。
        // 有话头，③⑤ 才检索；没有就保持空——绝不自己编一个检索词。
        return injection.render(context.query === undefined ? {} : { query: context.query }).text
      } catch (error) {
        if (!renderFailureReported) {
          renderFailureReported = true
          log.warn('渲染注入正文失败，本轮不注入（同一实例只报一次）：%s', messageOf(error))
        }
        return ''
      }
    }
    ctx.effect(
      () => prompt.context({
        name: PROMPT_CONTEXT_NAME,
        order: PROMPT_CONTEXT_ORDER,
        // 记忆正文里可能出现 `{{…}}`。一旦被当成提示词变量，宿主 renderPrompt 会抛
        // `unknown prompt variable` 并让整次装配失败——一条记忆里写个花括号就够了。
        // 故声明不插值，正文原样进入快照。
        interpolate: false,
        text: textForPrompt,
      }),
      'ondra-prompt-inject: 挂进系统提示词',
    )
    log.info('已挂进宿主系统提示词：上下文 %s（order %d，不插值）', PROMPT_CONTEXT_NAME, PROMPT_CONTEXT_ORDER)
  }
  const ready = ctx.get('systemPrompt') as SystemPromptLike | undefined
  if (ready === undefined) {
    ctx.inject(['systemPrompt'], (scoped) => {
      const late = scoped.get('systemPrompt') as SystemPromptLike | undefined
      if (late === undefined) {
        log.warn('宿主没有 systemPrompt 服务：注入装箱已就绪但无人阅读（精简 profile 属正常）')
        return
      }
      attach(late)
    })
  } else {
    attach(ready)
  }

  // 5. 报一次现状。可用性与依赖到位情况都要能被自检读到，不许黑箱（§12.2）。
  log.info(
    '注入装箱就绪：预算 %d 字（档位 %s），八块上限 %d/%d/%d/%d/-/%d/-/1',
    injection.budget(),
    settings.budgetPreset,
    settings.maxPromises,
    settings.maxPinned,
    settings.maxPersons,
    settings.maxAnniversary,
    settings.maxLessons,
  )
  if (!settings.enable) {
    log.warn('注入装箱已关闭（enable=false）：服务照常注册，但 render() 返回空正文')
  }
  if (!NAME_RE.test(name)) {
    // 这条永远不该触发；留着是因为服务键不合规的代价是「模型侧直接拒绝」，
    // 而那类事故没有任何运行期报错。
    log.error('插件名不合规（%s）：服务键会被模型侧拒绝', name)
  }
  if (ctx.get('ondra-memory-recall') === undefined) {
    log.warn('召回未装载：③ 我认识的人 与 ⑤ 这会儿想起来的 不会出（其余六块照常）')
  }
  if (ctx.get('ondra-memory-core') === undefined) {
    log.warn('记忆内核未装载：②④⑥⑧ 与钉住的正文都拿不到，注入只剩 ①⑤⑦')
  }
  if (settings.respectPool && ctx.get('ondra-memory-pool') === undefined) {
    log.info('记忆池未装载：不判「海马体永不注入」（海马体是硬性质，建议装上 O-131）')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: InjectConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能被安全补全（枚举外的值退回默认），因此永远不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
