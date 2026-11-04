/**
 * O-072 `ondra-gui-agent`：图形界面的**单步决策环 + 三层安全网 + 审计**。档位〔研〕。
 *
 * ## 一句话定位
 *
 * 它**不会**自己截屏、也**不会**自己点鼠标（见 README 限制 1）。
 * 它只做四件事：判这一步该不该做、要不要人点头、把票管好、把每一下记进审计。
 * 真正的「看」与「动」由一个实现 `GuiRunner` 的端口提供。
 *
 * ## 三层安全网（三层都在，缺一层就等于没有）
 *
 * | 层 | 闸门 | 为什么必须有这一层 |
 * |---|---|---|
 * | 一 | **危险区黑名单**（归一化矩形） | 菜单栏、窗口红绿灯、Dock——点错一下就关窗/退出/切走，与「点错一个按钮」不是一个量级 |
 * | 二 | **App 白名单**（空 = 全拒） | 「没点名的不许动」。空数组时不是「忘了配」，而是一个明确的默认 |
 * | 三 | **动作确认阈值** + **每日预算** + **限频** | 打字与按键是高危动作；预算与限频防「连点风暴」 |
 *
 * 台账 O-072 那栏写着「手册补：三层安全网必须落地」。本轮全文核对过手册：
 * `gui` 只 12 处命中、无 gui-agent 专章，`危险区` / `黑名单` / `三层安全网` **0 命中**——
 * 也就是说这句话在手册里**没有出处**，是从 master-plan §9.11「旧实现只写在注释里」
 * 反推出来的施工要求。本包按它执行，但把这件事写清楚，免得下一个人去手册里找。
 *
 * ## 为什么默认只开 `observe`
 *
 * 打开一个「能替你点鼠标」的插件，第一步应该是让它**先看见屏幕**，
 * 而不是直接给它一只会点「确认支付」的手。所以出厂 `enabledTools=['observe']`、
 * `appAllowList=[]`（一个都不许）、`maxRisk='high'`、`confirmThreshold='high'`。
 * 这三条合起来的实际效果是：**装上之后它什么都做不了，除非你亲手放开**。
 *
 * ## 为什么 `approve()` 不是工具
 *
 * 三档审批的意义是「人点头」。模型若能自己 `approve`，那道闸门就退化成自问自答，
 * 而日志里还写着「已确认」。本包因此只把 `approve()` 放在服务对象上，
 * 由宿主/界面在用户点击后调用——模型侧**没有**这个工具（纪律 31）。
 */

import type { Context } from '@ntars/cordis'
import { GuiAgentService, clockAccess } from './service.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as Settings } from './settings.js'
import { ACT_TIMEOUT_MS, GUI_SERVICE_KEY, OBSERVE_TIMEOUT_MS, TOOL_NAMES } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  GuiService,
  IdentityLike,
  LogLike,
  PathLike,
} from './types.js'

export type * from './types.js'
export {
  GUI_SERVICE_KEY,
  NAME_RE,
  TOOL_NAMES,
  TOOL_KEYS,
  KEY_RE,
  RISK_LEVELS,
  ACTION_KINDS,
  OBSERVE_TIMEOUT_MS,
  ACT_TIMEOUT_MS,
  TIMEOUT_FLOOR,
  TIMEOUT_CEIL,
  OBSERVATION_TTL_MS,
  TTL_CEIL,
  STEP_INTERVAL_MS,
  INTERVAL_CEIL,
  DAILY_BUDGET,
  BUDGET_CEIL,
  CONFIRM_TTL_MS,
  CONFIRM_TTL_CEIL,
  TEXT_MAX,
  TEXT_CEIL,
  COORD_GRID,
  AUDIT_KEEP,
  AUDIT_KEEP_CEIL,
  AUDIT_FILE,
  AUDIT_MAX_BYTES,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  CONFIG_SECTION,
  DEFAULT_CONFIG,
  DEFAULT_TOOLS,
  DEFAULT_ZONES,
  FIELD_SPECS,
  SECTION_KEYS,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
export {
  appAllowed,
  baseRiskOf,
  decide,
  isStale,
  keyOk,
  quantize,
  riskRankOf,
  textOk,
  zoneAt,
} from './policy.js'
export { StepLoop } from './loop.js'
export type { BudgetView, LoopDeps, TakeResult, TicketRecord } from './loop.js'
export { AuditTrail } from './audit.js'
export type { AuditDeps, AuditDraft } from './audit.js'
export { NoRunner, runnerReady } from './runner.js'
export { describeObservation, normalizeObservation } from './observe.js'
export { descriptorOf, keyOfArgs, pointOfArgs, textOfArgs, toolKeyOf } from './tools.js'
export { DEFAULT_TIMEOUTS, GuiAgentService, clockAccess } from './service.js'
export type { GuiAgentDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-gui-agent'

/**
 * 向 O-005 注册配置段。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-gui-agent: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', textOf(error))
    return false
  }
}

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
    /** 图形界面操作；未装载本插件时为 undefined。 */
    'ondra-gui-agent'?: GuiService
  }
}

/**
 * Cordis 入口：解析配置、装服务。**永不阻断宿主**。
 *
 * 刻意**不声明插件级 `inject`**：声明 `ondra-clock` / `ondra-config-schema` 会让上游缺席时
 * 整插件停在 PENDING（手册 §8.3 的静默失败之一），而本包对这四个上游全是软依赖——
 * 缺席只是「预算按进程算」「配置退回本地校验」，功能照跑。
 *
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  // 日志命名空间 `ondra.gui.agent`（前缀由 O-001 给）。
  const log = ctx.logger(identity ? identity.loggerName('gui.agent') : 'ondra.gui.agent')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  // 1. 配置：有 O-005 就走四层合并。
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  const onBad = (text: string, kind: string): void => {
    log.warn('配置条目已丢弃（%s）：%s', kind, text)
  }
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
      log.warn('解析配置段失败，退回插件实例配置：%s', textOf(error))
    }
  }
  const settings = completeConfig(effective, onBad)

  // 2. 时间与路径：都每次现取（上游晚装载能自愈，早卸载立刻反映）。
  const clock = ctx.get('ondra-clock') as ClockLike | undefined
  const time = clockAccess(clock)
  const path = (): PathLike | undefined => ctx.get('ondra-path-layout') as PathLike | undefined

  const service = new GuiAgentService({
    settings,
    log,
    now: time.now,
    dayKey: time.dayKey,
    path,
  })

  // 3. 注册服务。撤服务时一并撤掉已注册工具（不留幽灵注册）。
  ctx.effect(
    () => {
      const dispose = ctx.provide(GUI_SERVICE_KEY, service)
      return () => {
        service.dispose()
        dispose()
      }
    },
    'ondra-gui-agent: 注册图形界面操作服务',
  )

  // 4. 报一次现状（每一条都指向一个具体动作）。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被夹紧或丢弃（与你设的不一样）：%s', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('图形界面自动化默认关闭（enable=false）：打开之后它也只能先看屏幕')
  } else if (!service.ready) {
    log.warn(
      '开关开着但没有后端：本包只做判定与审计，不会截屏也不会点鼠标（见 README 已知限制 1）',
    )
  } else {
    log.info('图形界面自动化已打开，后端：%s', service.status().runner)
  }

  if (settings.appAllowList.length === 0) {
    log.warn('App 白名单是空的（一个都不许）：这是明确默认，不是故障。要操作哪个 App 就把名字加进 app-allow-list')
  } else {
    log.info('App 白名单：%s', settings.appAllowList.join(' / '))
  }

  const kinds = settings.enabledTools
  if (kinds.includes('click') || kinds.includes('type') || kinds.includes('key')) {
    log.warn(
      '已开放的动作为：%s（每一项都要过危险区、白名单、风险上限与确认阈值四道闸）',
      kinds.map(key => TOOL_NAMES[key]).join(' / '),
    )
  } else {
    log.info('只开放了 observe：它只看不动，不需要确认，也不消耗动作预算')
  }

  if (settings.dangerZones.length === 0) {
    log.warn('危险区是空的：菜单栏、窗口按钮、Dock 都不再被拦——除非你确实知道自己在做什么，否则把出厂三条加回去')
  } else {
    log.info(
      '危险区 %d 个：%s（坐标按归一化 0–1 判，换分辨率不会错位）',
      settings.dangerZones.length,
      settings.dangerZones.map(zone => zone.id).join(' / '),
    )
  }

  if (!settings.formRedLine) {
    log.warn('表单红线已关闭：检测到已填表单也不会收手')
  }
  if (settings.maxRisk === 'readonly') {
    log.info('风险上限是 readonly：所有动作都会被拦，等于只许看')
  }

  if (settings.observeTimeoutMs !== OBSERVE_TIMEOUT_MS) {
    log.info('观察超时被改成 %d 毫秒（出厂 %d）', settings.observeTimeoutMs, OBSERVE_TIMEOUT_MS)
  }
  if (settings.actTimeoutMs !== ACT_TIMEOUT_MS) {
    log.info('执行超时被改成 %d 毫秒（出厂 %d，留了首次授权弹窗的余量）', settings.actTimeoutMs, ACT_TIMEOUT_MS)
  }

  // 时钟给不给自然日键，直接决定预算口径——必须说出来，否则用户会以为「每天」是他想的那样。
  const scope = service.status().budgetScope
  if (scope === 'day') {
    log.info('动作预算按自然日重置（借 ondra-clock 的 dayKey）')
  } else {
    log.warn('ondra-clock 没有 dayKey：动作预算只能按进程累计（重开应用才重置），见 README 限制 3')
  }

  log.info(
    '本包不提供 gui-approve 工具：确认票只能由界面在用户点头后批准，' +
      '模型没有批准通道（否则三档审批会退化成自问自答）',
  )
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
    ) => { readonly value: Settings } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能安全补全（越界夹紧、坏条目逐条丢弃），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
