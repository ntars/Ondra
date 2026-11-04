/**
 * O-068 `ondra-adb`：手机短信的**只读轮询**。档位〔复〕。
 *
 * ## 这一包只做一件事，而且这件事手册写得很窄
 *
 * master-plan §9.11「端侧实证」逐字：
 * **只做只读短信轮询**（`content://sms/inbox`、未读 20 条、15s 轮询、
 * `seen` 集合超 1000 裁到 500）；**没有截图、点击、中文输入**；
 * 发短信不做，靠 `replyWebhook` + 用户自备 Intent 桥。
 *
 * 手册 §1.7 又补了一句：`O-068 adb | scrcpy 能力更强（投屏+控制）`。
 * 两句合起来就是本包的边界：**投屏与控制归 scrcpy，本包只读短信**。
 *
 * ## 装载期只做五件事
 *
 * 1. 解析配置（有 O-005 就走四层合并）；
 * 2. 定位已答集合文件（`user/adb-seen.json`，0600 由 O-002 建）；
 * 3. 读回已答集合（跨重启记住「哪些处理过」）；
 * 4. 建执行器与回复桥（桥地址不合规就不建，并在日志里说为什么）；
 * 5. `provide` 服务 + 起定时器（挂在 `ctx.effect` 的 disposer 上，卸载即停）。
 *
 * ## 为什么默认关
 *
 * 手册 §16.3：端侧八个插件**各自独立、默认全部关闭**，且
 * 「只读能力不得因同组其他插件被授权而获得写权限」。
 * 本包的「只读」不是文档承诺，是 `policy.ts` 里一道**结构白名单**：
 * 除 `adb shell content query --uri content://sms/inbox` 之外一律拒绝，
 * 连 `;` `|` `$` 这类会被设备侧 sh 重解析的字符都在拒绝之列。
 */

import type { Context } from '@ntars/cordis'
import { HttpReplyPush, checkBridgeUrl } from './reply.js'
import { SpawnAdbRunner } from './runner.js'
import { SeenStore } from './store.js'
import { AdbPoller } from './service.js'
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
import { SEEN_MAX } from './types.js'
import type {
  AdbService,
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  KitLike,
  LogLike,
  PathLayoutLike,
} from './types.js'
import { ADB_SERVICE_KEY } from './types.js'

export type * from './types.js'
export { ADB_SERVICE_KEY, SMS_URI, NAME_RE, SEEN_MAX, SEEN_KEEP, UNREAD_BATCH, POLL_SECONDS } from './types.js'
export {
  CONFIG_SECTION_ID,
  CONFIG_SECTION,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  SEEN_FLOOR,
  SEEN_CEIL,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
export { guardReadOnly, describeArgv } from './policy.js'
export type { PolicyVerdict } from './policy.js'
export { queryArgv, parseRow, parseSmsOutput, orderForBatch, SMS_PROJECTION } from './sms.js'
export { SpawnAdbRunner, classifyStderr } from './runner.js'
export type { SpawnAdbRunnerDeps } from './runner.js'
export { HttpReplyPush, checkBridgeUrl } from './reply.js'
export type { BridgeUrlCheck, HttpReplyPushDeps } from './reply.js'
export { SeenStore, keepOf } from './store.js'
export type { SeenLogLike, SeenStoreDeps } from './store.js'
export { AdbPoller, describeExec } from './service.js'
export type { AdbServiceDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-adb'

/**
 * 向 O-005 注册配置段。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-adb: 注册配置段')
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
    /** adb 短信服务；未装载本插件时为 undefined。 */
    'ondra-adb'?: AdbService
  }
}

/**
 * Cordis 入口：解析配置、读已答集合、建执行器与桥、注册服务。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Settings): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  // 日志命名空间 `ondra.adb`（前缀由 O-001 给）。
  const log = ctx.logger(identity ? identity.loggerName('adb') : 'ondra.adb')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  // 1. 配置：有 O-005 就走四层合并。
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  const onBad = (text: string, kind: string): void => {
    log.warn('配置条目已按约束改写（%s）：%s', kind, text)
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

  // 2. 已答集合的落盘路径。没有 O-002 就只在内存（会重答，必须说清）。
  const layout = ctx.get('ondra-path-layout') as PathLayoutLike | undefined
  let stateFile = ''
  if (settings.stateFile !== '') {
    stateFile = settings.stateFile
    if (layout !== undefined) {
      try {
        layout.prepareFile(stateFile)
      } catch (error) {
        log.warn('已答集合文件准备失败（改为只在内存）：%s', textOf(error))
        stateFile = ''
      }
    }
  } else if (layout !== undefined) {
    try {
      stateFile = layout.prepareFile(layout.fileIn('user', 'adb-seen.json'))
    } catch (error) {
      log.warn('已答集合路径解析失败（改为只在内存）：%s', textOf(error))
      stateFile = ''
    }
  }

  // 3. 读回已答集合。
  const seen = new SeenStore({
    file: stateFile,
    max: settings.seenMax,
    log,
  })
  const loaded = seen.load()

  // 4. 执行器与桥。
  const runner = new SpawnAdbRunner({ adbPath: settings.adbPath, serial: settings.serial })
  const bridge = checkBridgeUrl(settings.replyWebhook, settings.allowRemoteBridge)
  const push = bridge.ok ? new HttpReplyPush({ webhook: settings.replyWebhook.trim() }) : null

  const now = (): number => {
    const clock = ctx.get('ondra-clock') as ClockLike | undefined
    return clock === undefined ? Date.now() : clock.now()
  }

  const poller = new AdbPoller({
    settings,
    log,
    now,
    seen,
    runner,
    push,
    kit: () => ctx.get('ondra-channel-kit') as KitLike | undefined,
  })

  // 5. 注册服务 + 定时器。**停服务与停定时器必须同时发生**。
  ctx.effect(
    () => {
      const dispose = ctx.provide(ADB_SERVICE_KEY, poller)
      poller.start()
      return () => {
        poller.stop()
        dispose()
      }
    },
    'ondra-adb: 注册短信服务',
  )

  // 6. 报一次现状（每一条都指向一个具体动作）。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值被约束改写（与你设的不一样）：%s', drift.join(' / '))
  }

  if (!settings.enable) {
    log.info('手机短信轮询默认关闭（enable=false）：打开后每 %d 秒读一次未读短信', settings.pollSeconds)
  } else if (settings.autoReply && push === null) {
    log.warn('autoReply 打开了但回复桥不可用（%s）：本轮按只读处理，短信不会被回复', bridge.detail)
  } else if (settings.autoReply) {
    log.info('短信轮询已打开：自动回复经 %s（%s）', bridge.detail, settings.replyWebhook.trim())
  } else {
    log.info('短信轮询已打开：只读模式（autoReply=false，不会回复任何短信）')
  }

  if (loaded > 0) log.info('已答集合读回 %d 条（上限 %d，超过裁到一半）', loaded, settings.seenMax)
  if (stateFile === '') {
    log.warn('已答集合只在内存：重启后会把最近这批未读再答一遍（缺 ondra-path-layout 或未配 stateFile）')
  }
  if (settings.seenMax !== SEEN_MAX) {
    log.info('已答集合上限被改成 %d（手册 §9.11 实测值是 %d）', settings.seenMax, SEEN_MAX)
  }
  if (settings.serial === '') {
    log.info('没有指定 serial：只接一台设备时没问题，接多台时 adb 会直接报 more than one device')
  }

  log.info(
    '只读边界：除 `adb shell content query --uri content://sms/inbox` 之外一律拒绝；' +
      '截图 / 点击 / 中文输入不做（投屏与控制归 scrcpy，见手册 §1.7）',
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
      // 全部字段都能安全补全（越界夹紧、跨字段约束就地修正），故永不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
