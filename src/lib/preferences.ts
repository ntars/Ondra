/**
 * 偏好设置（§5.13 第一层）的数据层。
 *
 * ## 为什么必须有这一个文件
 *
 * 偏好设置是**独立窗口**，与主窗口是两个 WebView 文档。两个文档都要知道
 * 「现在是深色还是浅色」「字号是大是小」，却没有任何一条 React 状态能跨过去。
 * 若各存一份，深色窗口点一下、主窗口不动，用户会认为设置没生效。
 *
 * 所以三件事收到这里，且只在这里定义一次：
 *
 * | 偏好 | 生效方式 | 为什么要跨窗口 |
 * | --- | --- | --- |
 * | 主题 | `data-theme` + `color-scheme` | 主窗口要立刻换色 |
 * | 字号 | `html` 的 `font-size` 百分比 | 主窗口要立刻重排 |
 * | 发送方式 | 由 `Composer` 读 | 主窗口下一次按 Enter 就要按新规则 |
 *
 * ## 为什么用「磁盘 + 广播」两条腿
 *
 * `localStorage` 负责**重启后还在**，但它不保证跨窗口同步——两个窗口是否
 * 共用同一个存储区取决于各平台 WebView 的实现，不能拿它当通信手段。
 * 实时同步走壳的广播事件（`preferences-changed`），那条路是确定的。
 * 两者都写，任一条失效时另一条仍成立。
 *
 * ## 为什么主题要「解析后」才写进 `data-theme`
 *
 * `tokens.css` 里只有 `html[data-theme='dark']` 一个选择器，没有
 * `[data-theme='system']`。所以「跟随系统」不能写成 `system`——写进去
 * 一条规则都不命中，界面就固定在浅色。必须先问 `matchMedia` 拿到
 * 当前的真实结果再写。这一条曾经是个真缺陷：旧实现把属性直接删掉，
 * 结果系统是深色时界面仍是亮的。
 */

import { useSyncExternalStore } from 'react'
import { invokeShell, isDesktopShell, listenShell } from './shell.ts'
import type { ThemeMode } from './api.ts'

/** 界面字号档位。百分比相对浏览器基准字号，因此系统放大仍叠加生效。 */
export type FontScale = 'small' | 'standard' | 'large'

/** 生成中按 Enter 的行为（§5.6）。 */
export type SendMode = 'queue' | 'interrupt'

/** 全部偏好。 */
export interface Preferences {
  theme: ThemeMode
  fontScale: FontScale
  sendMode: SendMode
}

/** 出厂默认值。 */
const DEFAULTS: Preferences = {
  theme: 'system',
  fontScale: 'standard',
  sendMode: 'interrupt',
}

/**
 * 字号档位对应的百分比。
 *
 * 用百分比而不是 px：百分比相对浏览器（WebView）的基准字号，用户把系统
 * 字号调到 200% 时这里仍按比例放大；写 px 会把那条链掐断（§9.9）。
 * 112.5% / 93.75% 是 16px 基准下的 18px / 15px，取整便于口算。
 */
const FONT_PERCENT: Record<FontScale, string> = {
  small: '93.75%',
  standard: '100%',
  large: '112.5%',
}

/** localStorage 的键。沿用 `ondra.theme`，旧版本存过的选择不会丢。 */
const KEY_THEME = 'ondra.theme'
const KEY_FONT = 'ondra.fontScale'
const KEY_SEND = 'ondra.sendMode'

/** 当前偏好。模块级单例：两个窗口各持一份内存副本，靠广播对齐。 */
let current: Preferences = { ...DEFAULTS }

/** 订阅者。`useSyncExternalStore` 要求引用稳定，因此只建一次。 */
const listeners = new Set<() => void>()

/** 通知订阅者。 */
function notify(): void {
  for (const listener of listeners) listener()
}

/** 安全读一个键。隐私模式下 localStorage 会抛，一律回落默认值。 */
function read(key: string): string | undefined {
  try {
    return globalThis.localStorage?.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

/** 安全写一个键。写失败只影响「重启后还在」，不影响本次生效。 */
function write(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch { /* 隐私模式：本次仍生效，只是不持久 */ }
}

/** 把任意字符串收窄成语义值。认不出的一律回落默认，不猜。 */
function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

/** 从磁盘读。启动时调一次。 */
export function loadPreferences(): Preferences {
  current = {
    theme: pick(read(KEY_THEME), ['system', 'light', 'dark'] as const, DEFAULTS.theme),
    fontScale: pick(read(KEY_FONT), ['small', 'standard', 'large'] as const, DEFAULTS.fontScale),
    sendMode: pick(read(KEY_SEND), ['queue', 'interrupt'] as const, DEFAULTS.sendMode),
  }
  return current
}

/** 读当前偏好。 */
export function getPreferences(): Preferences {
  return current
}

/**
 * 把偏好落到文档上。
 *
 * 三个动作都必须是幂等的：广播到达、窗口打开、系统主题变化都会调它，
 * 重复执行不能产生额外效果（否则会出现「闪一下」）。
 */
export function applyPreferences(next: Preferences): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement

  // 主题：先解析再写。`system` 在这里被换成具体值，绝不留一个不命中任何规则的字面量。
  const dark = next.theme === 'dark'
    || (next.theme === 'system' && globalThis.matchMedia('(prefers-color-scheme: dark)').matches)
  const resolved = dark ? 'dark' : 'light'
  if (root.dataset['theme'] !== resolved) root.dataset['theme'] = resolved
  // `color-scheme` 让原生滚动条与光标跟着走。写在 `style` 上而不是属性上，
  // 是因为它不是我们的令牌，而是给浏览器的一句承诺。
  root.style.colorScheme = resolved

  // 字号：百分比叠加在浏览器基准之上（§9.9 不写死 px 的原因）。
  root.style.fontSize = FONT_PERCENT[next.fontScale]
}

/**
 * 改一项偏好。
 *
 * @param patch 要改的字段。
 * @param options.broadcast 是否通知其他窗口。默认通知；
 *   收到广播的那个窗口传 `false`，否则两个窗口会来回弹。
 */
export function setPreferences(patch: Partial<Preferences>, options?: { broadcast?: boolean }): void {
  const next: Preferences = { ...current, ...patch }
  current = next

  write(KEY_THEME, next.theme)
  write(KEY_FONT, next.fontScale)
  write(KEY_SEND, next.sendMode)

  applyPreferences(next)
  notify()

  if (options?.broadcast !== false) broadcast(next)
}

/**
 * 把偏好送到其他窗口。
 *
 * 失败不提示：广播丢了最坏的结果是「另一个窗口要下次打开才对」，
 * 而弹一条「同步失败」会把一件几乎无害的事说成故障。
 */
function broadcast(next: Preferences): void {
  if (!isDesktopShell()) return
  void invokeShell<null>('broadcast_preferences', {
    from: currentWindowLabel(),
    prefs: JSON.stringify(next),
  }).catch(() => {
    /* 见函数注释：不提示 */
  })
}

/**
 * 本窗口的 label。
 *
 * 主窗口 `main`、偏好窗口 `preferences`（见 `src-tauri/src/preferences.rs`）。
 * 广播时带上它，壳才能把「发信人」排除在收信名单外——否则两个窗口
 * 会互相回发，形成一条永不停止的来回。
 *
 * 判据是 hash 而不是 `window.label`：后者要等壳注入 `__TAURI__`，
 * 而这个判断可能在页面极早期发生。hash 在解析 HTML 时就确定了。
 */
function currentWindowLabel(): string {
  return globalThis.location.hash === '#preferences' ? 'preferences' : 'main'
}

/**
 * 接收别的窗口发来的偏好。
 *
 * 只落盘并应用，**不再广播**——否则两个窗口会无限对发。
 */
export function adoptPreferences(raw: unknown): void {
  if (typeof raw !== 'string') return
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return
  }
  if (parsed === null || typeof parsed !== 'object') return
  const shaped = parsed as Partial<Preferences>
  setPreferences(
    {
      theme: pick(shaped.theme, ['system', 'light', 'dark'] as const, current.theme),
      fontScale: pick(shaped.fontScale, ['small', 'standard', 'large'] as const, current.fontScale),
      sendMode: pick(shaped.sendMode, ['queue', 'interrupt'] as const, current.sendMode),
    },
    { broadcast: false },
  )
}

/** 订阅偏好变化。返回取消订阅函数。 */
export function subscribePreferences(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * 读偏好的 React 钩子。
 *
 * 用 `useSyncExternalStore` 而不是 `useState` + `useEffect`：后者在
 * 订阅生效之前会先用一次旧快照渲染，窗口刚打开时能看到一帧旧主题。
 */
export function usePreferences(): Preferences {
  return useSyncExternalStore(subscribePreferences, getPreferences, getPreferences)
}

/** 广播事件的载荷类型。与壳发来的字符串一一对应。 */
export type PreferencesPayload = string

/**
 * 启动偏好层。在 `main.tsx` 调用一次，两个窗口都调。
 *
 * 做三件事：读盘并应用、跟随系统主题的变化、接收其他窗口的广播。
 */
export function startPreferences(): void {
  applyPreferences(loadPreferences())

  /*
   * 系统主题变化。
   *
   * 只在 `theme === 'system'` 时响应：用户显式选了浅色，系统切深色时
   * 界面不该跟着变——那不是"跟随系统"，是不听话。
   */
  const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)')
  if (media !== undefined && typeof media.addEventListener === 'function') {
    media.addEventListener('change', () => {
      if (current.theme === 'system') applyPreferences(current)
    })
  }

  /*
   * 接收其他窗口的广播。
   *
   * 壳在 `preferences.rs` 里把发信窗口排除掉，所以这里不必再判
   * 「是不是我自己发的」——判一次反而多一个可能与壳不一致的分支。
   */
  listenShell<string>('preferences-changed', (payload) => { adoptPreferences(payload) })
}