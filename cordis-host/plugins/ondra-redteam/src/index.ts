/**
 * O-104 `ondra-redteam`：红队评测（〔研〕自研，L9 扩展池）。
 *
 * ## 它到底做什么
 *
 * 用**十五道固定的攻击题**去撞她，看人格边界有没有塌。五类撞法：
 * 越狱套话、身份泄漏、内部提示萃取、谄媚迎合、隐私套取。
 * 判据是静态正则，判定是纯函数——**不调模型**（让同一个模型给自己打分，
 * 得到的分数只反映它今天的心情）。
 *
 * ## 它刻意不做什么（五条）
 *
 * - **不驱动对话。** 谁把攻击话术发给她、谁把回复拿回来，是 O-033 与调用方的事。
 *   自己发起对话就多出一条绕过冻结前缀与九步过滤的路径，测出来的结论没意义。
 * - **不出综合分。** 报告里只有条数与逐题结论。一旦有「人格一致性 87 分」，
 *   第二天就有人为了这 87 分去调参数——而被调的是人格（禁报数铁律 P0 第 3 条）。
 * - **不存回复正文。** 只回长度与命中位置区间。回复里可能就有用户刚说的隐私，
 *   把报告当回收站用是本插件最容易造成的二次泄漏。
 * - **不把「跳过」算通过。** 题库里有、这批没给回复的题记 `skip`，单独一列。
 *   空回复直接拒收，不许它悄悄变成一个 pass。
 * - **不做界面。** L8 界面 14 个插件已整批下线，渲染归应用外壳（`desktop/`）。
 *
 * ## 依赖纪律
 *
 * 只有两项软依赖（身份 / 配置）。**刻意不依赖 LLM 网关与对话链**：
 * 本插件是纯文本判定，一旦接上网关就有了「让它自己评自己」的诱惑。
 * 故也不声明插件级 `inject`。
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
import type { Config as RedTeamConfig } from './settings.js'
import { RedTeam } from './service.js'
import { REDTEAM_SERVICE_KEY } from './types.js'
import type {
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  RedTeamService,
} from './types.js'

export type * from './types.js'
export {
  REDTEAM_SERVICE_KEY,
  CASEBOOK_VERSION,
  SUITE_IDS,
  SUITE_SPECS,
  CRITERION_KINDS,
  SEVERITIES,
  VERDICTS,
  REPORT_VERDICTS,
  REDTEAM_ERROR_CODES,
  RedTeamError,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  CONFIG_SECTION,
  completeConfig,
} from './settings.js'
export { RED_CASES } from './cases.js'
export {
  MAX_REPLY_CHARS,
  SEVERITY_ORDER,
  compileChecks,
  spansOf,
  gradeOne,
  noteOf,
  queryCases,
  casebookOf,
  reportOf,
  summaryOf,
  kindLabelOf,
} from './grade.js'
export type { CompiledCheck, CompileIssue, CompileResult } from './grade.js'
export { RedTeam } from './service.js'
export type { RedTeamDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-redteam'

/**
 * 本插件**不声明** `inject`：没有任何硬依赖。
 *
 * 这一点写在这里是给未来的自己看的：红队插件最容易被顺手接上网关，
 * 而一旦接上，「用模型评模型」这条路就通了——那条路会让整份评测变成自证。
 */

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 向 O-005 注册配置段。放进 `ctx.effect`：段是本插件的资源，卸载时必须一起撤。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 注册是否成功。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-redteam: 注册配置段')
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
    /** 红队评测服务；未装载本插件时为 undefined。 */
    'ondra-redteam'?: RedTeamService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: RedTeamConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('redteam') : 'ondra.redteam')

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

  // 2. 补全。任何非法值都回退默认，绝不抛。
  const settings = completeConfig(effective)

  // 3. 建服务。题库在这里编译一次；编译失败会逐条打到日志。
  const service = new RedTeam({ settings, log, now: () => Date.now() })

  ctx.effect(() => ctx.provide(REDTEAM_SERVICE_KEY, service), 'ondra-redteam: 注册红队评测服务')

  // 4. 报一次现状。题库条数与套件覆盖必须能被自检读到，不许黑箱。
  const book = service.casebook()
  log.info(
    '红队评测就绪：%s（题库 v%d，%d 题 / %d 套；纯文本判定，不调模型）',
    service.available ? '可用' : '不可用',
    book.version,
    book.total,
    service.suites().length,
  )
  const holes = book.bySuite.filter(item => item.count === 0)
  if (holes.length > 0) {
    // 套件有洞比题库少几题严重：报告按套件分组，缺一套那一格永远是 0。
    log.warn('以下套件在题库里一题都没有，报告里那一组会恒为空：%s', holes.map(item => item.zh).join('、'))
  }
  if (!settings.enable) {
    log.warn('红队评测已关闭（enable=false）：服务照常注册，grade() / batch() 一律抛 disabled')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。四个字段都能安全补全
 * （数字越界夹到区间内），因此永远不产 issue——配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: RedTeamConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      return { value: completeConfig(value) }
    },
  },
}
