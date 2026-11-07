/**
 * 系统通知（§12.10、§7.4「应用未开走系统通知」）。
 *
 * ## 它解决的那个缺口
 *
 * 主动消息的判据在宿主，投递在界面。窗口可见时她自己会出现在时间轴上，
 * 不需要任何额外提示。**窗口不可见时**（关到托盘、最小化、切到别的 Space），
 * 用户根本不知道她说过话——除非走系统通知。
 *
 * ## 为什么「应用未开」在本应用里就是「窗口不可见」
 *
 * 这一点很关键，值得写清楚：本应用**关窗不等于退出**（§2.1、`window.rs`
 * 的 `intercept_close`）——点关闭只是把窗口隐藏到托盘，WebView 进程还活着。
 * 真正退出只有托盘菜单的「退出」。
 *
 * 所以 §7.4 那张表里的三种状态，在本应用里落成这样：
 *
 * | 规范说的 | 本应用的实际状态 | 谁来发通知 |
 * | --- | --- | --- |
 * | 应用未开 | 窗口隐藏 / 最小化（进程仍在） | 前端，从隐藏的 WebView 里发 |
 * | 已开但不在前台 | 窗口可见、没有焦点 | **不发**，只加 Rail 圆点 |
 * | 已开且在前台 | 窗口可见且有焦点 | 不发，她直接出现在时间轴上 |
 *
 * 不需要为第一行造一个常驻守护进程：WebView 在隐藏时仍然跑着定时器，
 * 主动消息的判定与投递本来就在那里发生，只是从前「窗口不可见就跳过」
 * 改成「窗口不可见就发通知」。
 *
 * ## 为什么隐藏时仍要跑定时器
 *
 * 浏览器会在后台标签页里节流 `setTimeout`（Chrome 到分钟级，WebKit 也有
 * 类似策略）。但节流只是**推迟**，不是停止；`useProactiveTick` 挂的是
 * 一次性的长定时器（25 分钟量级），被推迟几十秒对结果没有影响。
 * 这条如果哪天不成立（比如发现隐藏后完全不同步），正确的修法是让壳
 * 在 Rust 侧持一个定时器，而不是把判定搬到宿主——判定必须在界面这侧，
 * 因为它要读「用户此刻在不在看」。
 *
 * ## 权限为什么在打开开关时才要
 *
 * §7.5 自查表最后一条：「系统通知权限只在用户开启"主动消息"时才请求，
 * 不在首启请求」。首启就弹权限框是最典型的坏习惯——用户还不知道这个
 * 应用要通知他什么，先被问「允许通知吗」，答案大概率是「不允许」，
 * 而且系统层面记住这个答案，以后想开还得去系统设置里翻。
 *
 * 所以{@link enableNotify} 的三步顺序是固定的：
 * 1. 先问是否已授权；
 * 2. 没授权才请求（用户点开关的那一刻，他知道自己在为什么授权）；
 * 3. 被拒绝就**如实报告**，开关弹回去，并说明去哪开。
 *
 * ## 与静音、声音的关系
 *
 * | 层 | 管 | 会不会拦住通知 |
 * | --- | --- | --- |
 * | 静音（`mute.ts`） | 「这一小时别出声」 | **会**。静音期不弹通知 |
 * | 声音（`preferences.sound`） | 三个提示音的开关 | 不会。那是应用的音，不是系统通知 |
 * | 通知（本文件） | 窗口不可见时她说话 | — |
 *
 * 静音要拦住通知，理由与声音一样：用户按「静音 1 小时」时想的是
 * 「这一小时别打扰我」，一条系统通知比一声提示音打扰得更狠。
 */

import { useEffect, useState } from 'react'
import { isDesktopShell } from './shell.ts'
import { isMuted } from './mute.ts'
import { getPreferences } from './preferences.ts'
import { readVisibility } from './visibility.ts'

/**
 * 通知权限的四种状态。
 *
 * 用四态而不是布尔：`unsupported`（浏览器开发态、或系统没有通知中心）
 * 与 `denied`（用户明确拒绝）在界面上要给的提示完全不同——前者是
 * 「这里没这功能」，后者是「你拒绝过，要去系统设置改」。合成一个
 * `granted: false` 会让界面只能写一句含糊的话。
 */
export type NotifyPermission = 'granted' | 'denied' | 'default' | 'unsupported'

/** 插件的全局对象形状。只声明用到的三个成员。 */
interface NotifyApi {
  isPermissionGranted(): Promise<boolean>
  requestPermission(): Promise<NotificationPermission>
}

/**
 * 取通知 API。
 *
 * 优先用插件的 `__TAURI__.notification`——它是对 `window.Notification` 的
 * **薄封装**（见插件 `api-iife.js`），语义与 Web 标准一致，但多一个
 * `isPermissionGranted()`：Web 标准里 `Notification.permission` 在桌面
 * WebView 上未必反映系统层的真实状态（macOS 上尤其如此，用户可能在
 * 系统设置里关掉），问一次插件更准。
 *
 * 拿不到（浏览器开发态）就返回 `undefined`，由调用方降级成 `unsupported`。
 */
function api(): NotifyApi | undefined {
  const tauri = (globalThis as { __TAURI__?: { notification?: NotifyApi } }).__TAURI__
  return tauri?.notification
}

/**
 * 读当前权限，不触发任何请求。
 *
 * 这个函数**永远不会弹框**。界面在任何时候调它都安全——包括页面加载时。
 */
export async function readPermission(): Promise<NotifyPermission> {
  if (!isDesktopShell()) {
    /*
     * 浏览器开发态：`window.Notification` 可能真实存在（Chrome 有），
     * 但那条路发出来的是浏览器的通知，与桌面应用不是一回事。
     * 报 `unsupported` 比报 `default` 诚实：开发时不该看到「去申请权限」。
     */
    return 'unsupported'
  }
  const bridge = api()
  if (bridge === undefined) return 'unsupported'
  try {
    return (await bridge.isPermissionGranted()) ? 'granted' : 'default'
  } catch {
    return 'unsupported'
  }
}

/**
 * 请求权限。**只在用户打开通知开关时调用。**
 *
 * @returns 请求之后的状态。用户点了「不允许」时返回 `denied`。
 */
export async function requestPermission(): Promise<NotifyPermission> {
  if (!isDesktopShell()) return 'unsupported'
  const bridge = api()
  if (bridge === undefined) return 'unsupported'
  try {
    const result = await bridge.requestPermission()
    /*
     * 插件返回的是 Web 标准的 `NotificationPermission`
     * （`granted` / `denied` / `default`），三态直接对应我们的枚举。
     * `default` 出现在用户关掉了权限框而没有选择时。
     */
    return result === 'granted' ? 'granted' : result === 'denied' ? 'denied' : 'default'
  } catch {
    return 'unsupported'
  }
}

/** 一条通知的内容。 */
export interface NotifyPayload {
  /** 标题。用应用名，不用时间、不用「新消息」。 */
  title: string
  /** 正文：她说的那一句。 */
  body: string
}

/**
 * 弹一条系统通知。
 *
 * ## 四道前置判断，顺序不能反
 *
 * 1. **静音**：最外层。静音期连构造都不该发生。
 * 2. **用户开关**：§12.10「默认关闭」。
 * 3. **窗口可见性**：只有 `hidden` 才发。
 * 4. **权限**：没授权就什么都不做，不弹框（弹框是 `requestPermission` 的事）。
 *
 * ## 第 3 条为什么收在这里，而不是留给调用方
 *
 * §7.4 那张表的核心判断就是「窗口看不看得见」。它有三个调用方可能犯错：
 * 主动开口、以后可能有的定时提醒、以及别的地方。每处各判一次，就会
 * 出现「某一条漏判」的缺陷——而那种缺陷的表现是「用户在应用里好好看着，
 * 系统通知栏弹出一条重复的」，非常显眼又非常难查。
 *
 * 判据只写一遍。调用方只管「我要通知他这件事」，该不该发由这里定。
 *
 * ## 为什么不 await 发送结果
 *
 * `new Notification()` 是同步的，失败也不抛（系统把它吞了）。
 * 包一层 Promise 去等它，只会让调用方多一个不会 reject 的 await。
 *
 * @returns 是否真的发出去了。`false` 不代表出错，只代表按规则不该发。
 */
export function notify(payload: NotifyPayload): boolean {
  /* 1. 静音期：一声都不出，包括通知。理由见文件头。 */
  if (isMuted()) return false
  /* 2. 默认关闭。用户没开就是没开，不替他决定。 */
  if (!getPreferences().notify) return false
  /*
   * 3. 窗口看得见就不发（§7.4）。`visible` 与 `unfocused` 都不发——
   * 后者的窗口就在屏幕上，用户回来一眼能看到；弹通知才是打扰。
   */
  if (readVisibility() !== 'hidden') return false
  if (!isDesktopShell()) return false

  /*
   * 4. 权限。这里读的是**同步**的 `Notification.permission`：
   * 它由插件的 `init-iife.js` 在插件初始化时异步填好，页面跑起来之后
   * 就一直是准的。用 `readPermission()` 会多一次 IPC 往返，
   * 而主动开口那一刻不值得为一句通知多等一个来回。
   *
   * 读到 `default`（还没问过）时也直接返回——没问过就意味着开关
   * 打开的那一刻没成功授权，那么此刻弹通知也不会有任何效果。
   */
  const g = globalThis as {
    Notification?: new (title: string, options?: NotificationOptions) => unknown
  }
  const Ctor = g.Notification
  if (Ctor === undefined) return false
  /*
   * 权限读的是同一个全局对象上的静态属性。分开声明是因为
   * `Notification` 在本文件里被 TypeScript 当作「可构造的值」，
   * 而静态成员不在构造签名里。插件把两者挂在同一个对象上，
   * 分开取只是为了让类型写得出来。
   */
  const perm = (globalThis as { Notification?: { permission: NotificationPermission } })
    .Notification?.permission
  if (perm !== 'granted') return false

  try {
    const options: NotificationOptions = { body: payload.body }
    new Ctor(payload.title, options)
    return true
  } catch {
    /* 系统拒绝、通知中心不可用：静默降级。她的话还在时间轴上。 */
    return false
  }
}

/**
 * 读权限状态的 React 钩子（只读，不请求）。
 *
 * 挂载时读一次。权限在应用运行期间不会自己变（用户去系统设置改的情况
 * 存在，但那时窗口通常不在前台，重新读的时机应该是「窗口重新可见」，
 * 由偏好页自己处理——见 `Preferences.tsx` 的 `useEffect` 依赖 `page`）。
 */
export function useNotifyPermission(): NotifyPermission {
  const [permission, setPermission] = useState<NotifyPermission>('default')
  useEffect(() => {
    let alive = true
    void readPermission().then((next) => { if (alive) setPermission(next) })
    return () => { alive = false }
  }, [])
  return permission
}
