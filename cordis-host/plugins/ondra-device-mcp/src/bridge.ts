/**
 * 数据来源（`DeviceBridge`）的两个现成实现。
 *
 * ## 为什么来源是端口，而不是本包自己去读设备
 *
 * master-plan §9.12 把旧 UI 的 `endpoint` 判成**假字段**，理由是「源码走本地命令」。
 * 但本仓里**没有**任何一处本地命令可供复用：`cordis/` 下没有读过通知、通讯录、
 * 电量或前台 App 的代码，`desktop/packages` 也没有「设备信息」类服务键。
 * 手册 §9.11 只给了五个能力名与 8 秒超时，**没给命令、没给权限声明**。
 *
 * 硬要凑一版，只能去猜 `dumpsys notification` 的输出格式、`content query` 的
 * 联系人列名、`getprop` 的电池字段……每一条都随 Android 版本与厂商变化，
 * 猜错的表现是「工具能用但返回空」。这与「没接」在界面上完全同形——
 * 正是本仓一直在躲的那类失败。
 *
 * 所以画一条线：**来源归来源，本包负责能力面、隐私闸门、超时与降级。**
 *
 * ## 两个实现
 *
 * 1. `AdbSmsBridge`：把 O-068 `ondra-adb` 的 `readSms()` 接成 `device-sms`。
 *    只声明支持 `sms`——**不假装**它也能给通知或通讯录（它只有短信那一条通路）。
 *    这是同层软依赖：`ondra-adb` 缺席时这个桥根本不建。
 * 2. `CompositeBridge`：按能力把请求分给多个来源，谁声明支持就给谁。
 *    用来叠「adb 管短信 + 用户自备桥管通知/联系人」，两者不必是同一套实现。
 */

import type { AdbLike, BridgeFailure, BridgeResult, DeviceBridge, SmsItem, ToolKey } from './types.js'

/**
 * 把 adb 的原因码折成本包的失败码。
 *
 * 两个体系里的词不一样，映射必须**显式**做：直接把 `'no-adb'` 透给模型，
 * 它既不知道那是什么，也做不出正确动作。
 * @param reason adb 的原因码。
 */
function failureOf(reason: string): BridgeFailure {
  if (reason === 'denied') return 'denied'
  if (reason === 'no-adb' || reason === 'device-offline') return 'device-offline'
  if (reason === 'timeout') return 'timeout'
  if (reason === 'disabled' || reason === 'no-runner' || reason === 'stopped') return 'unsupported'
  return 'error'
}

/**
 * 把 `ondra-adb` 接成短信来源。
 *
 * **只实现 `sms`**：其余四个能力明确回 `unsupported`。
 * 这一点很重要——如果这里「顺手」也返回空数组，调用方会以为
 * 「这台手机没有通知」，而真相是「这个来源根本不管通知」。
 */
export class AdbSmsBridge implements DeviceBridge {
  readonly id = 'adb-sms'

  readonly supports: readonly ToolKey[] = Object.freeze(['sms'])

  private readonly adb: () => AdbLike | undefined

  constructor(adb: () => AdbLike | undefined) {
    this.adb = adb
  }

  /**
   * 短信（只读）。
   * @param input 条数与是否只看未读。
   */
  async sms(input: { readonly limit: number; readonly unreadOnly: boolean }): Promise<BridgeResult<readonly SmsItem[]>> {
    const adb = this.adb()
    if (adb === undefined) {
      return { ok: false, reason: 'unsupported', detail: 'ondra-adb 不在（未装载或已卸载）' }
    }
    if (!adb.available) {
      return { ok: false, reason: 'device-offline', detail: 'ondra-adb 当前不可用（开关关着，或没有执行器）' }
    }
    try {
      const result = await adb.readSms({ limit: input.limit, unreadOnly: input.unreadOnly })
      if (!result.ok) return { ok: false, reason: failureOf(result.reason), detail: result.detail }
      const items: SmsItem[] = result.rows.map(row => ({
        id: row.id,
        address: row.address,
        body: row.body,
        date: row.date,
        // 来源给的是原文，截断由本包的隐私闸门做——两处都截会截两次。
        truncated: false,
      }))
      return { ok: true, value: Object.freeze(items) }
    } catch (error) {
      return { ok: false, reason: 'error', detail: textOf(error) }
    }
  }

  /** 未实现的能力统一回 `unsupported`（见类注释）。 */
  private unsupported<T>(what: string): Promise<BridgeResult<T>> {
    return Promise.resolve({ ok: false, reason: 'unsupported', detail: 'adb 来源只提供短信，不提供' + what })
  }

  notifications(): Promise<BridgeResult<readonly never[]>> {
    return this.unsupported('通知')
  }

  contacts(): Promise<BridgeResult<readonly never[]>> {
    return this.unsupported('通讯录')
  }

  battery(): Promise<BridgeResult<never>> {
    return this.unsupported('电量')
  }

  foreground(): Promise<BridgeResult<never>> {
    return this.unsupported('前台应用')
  }
}

/**
 * 按能力分派的组合来源。
 *
 * 规则只有一条：**先声明支持者先接**（数组顺序即优先级）。
 * 同名能力被两个来源同时声明时，先来的赢——不做「两个都问再合并」，
 * 因为合并两个来源的短信列表会同时带来顺序与去重问题，而收益只是「可能多几条」。
 */
export class CompositeBridge implements DeviceBridge {
  readonly id = 'composite'

  readonly supports: readonly ToolKey[]

  private readonly bridges: readonly DeviceBridge[]

  constructor(bridges: readonly DeviceBridge[]) {
    // 过滤掉 null 之后按能力去重：第一个声明该能力的来源即归属。
    const seen = new Set<ToolKey>()
    for (const bridge of bridges) {
      for (const key of bridge.supports) seen.add(key)
    }
    this.supports = Object.freeze([...seen])
    this.bridges = Object.freeze([...bridges])
  }

  /**
   * 找第一个声明支持该能力的来源。
   * @param key 能力键。
   */
  private pick(key: ToolKey): DeviceBridge | undefined {
    return this.bridges.find(bridge => bridge.supports.includes(key))
  }

  notifications(input: { readonly limit: number }, timeoutMs: number): Promise<BridgeResult<readonly never[]>> {
    const target = this.pick('notifications')
    if (target === undefined) return unsupported('通知')
    return target.notifications(input, timeoutMs) as Promise<BridgeResult<readonly never[]>>
  }

  sms(
    input: { readonly limit: number; readonly unreadOnly: boolean },
    timeoutMs: number,
  ): Promise<BridgeResult<readonly SmsItem[]>> {
    const target = this.pick('sms')
    if (target === undefined) return unsupported('短信')
    return target.sms(input, timeoutMs)
  }

  contacts(input: { readonly query: string; readonly limit: number }, timeoutMs: number): Promise<BridgeResult<readonly never[]>> {
    const target = this.pick('contacts')
    if (target === undefined) return unsupported('通讯录')
    return target.contacts(input, timeoutMs) as Promise<BridgeResult<readonly never[]>>
  }

  battery(timeoutMs: number): Promise<BridgeResult<never>> {
    const target = this.pick('battery')
    if (target === undefined) return unsupported('电量')
    return target.battery(timeoutMs) as Promise<BridgeResult<never>>
  }

  foreground(timeoutMs: number): Promise<BridgeResult<never>> {
    const target = this.pick('foreground')
    if (target === undefined) return unsupported('前台应用')
    return target.foreground(timeoutMs) as Promise<BridgeResult<never>>
  }
}

/**
 * 统一的「不支持」返回。
 * @param what 中文能力名。
 */
function unsupported<T>(what: string): Promise<BridgeResult<T>> {
  return Promise.resolve({ ok: false, reason: 'unsupported', detail: '没有来源提供' + what + '（DeviceBridge 未注入该能力）' })
}

/**
 * 把异常折成一句文本。
 * @param error 异常。
 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
