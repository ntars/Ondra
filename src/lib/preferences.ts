/**
 * 偏好设置（§5.13）的数据层。
 *
 * ## 为什么这一个文件同时管「存」与「生效」
 *
 * 偏好有三个消费方：`App`（主题与发送方式）、`Composer`（Enter 的行为）、
 * `sound.ts` / `notify.ts`（声音与通知的开关）。它们分散在不同的组件里，
 * 若各自读一份 `localStorage`，就必然出现「这一处改了、那一处没跟上」。
 *
 * 所以三件事收到这里，且只在这里定义一次：
 *
 * | 偏好 | 生效方式 |
 * | --- | --- |
 * | 主题 | `data-theme` + `color-scheme` |
 * | 字号 | `html` 的 `font-size` 百分比 |
 * | 发送方式 | 由 `Composer` 读 |
 *
 * ## 为什么只有「磁盘」一条腿
 *
 * 上一版设置是独立窗口，两个 WebView 文档各有一份内存副本，必须再由壳
 * 转发一次广播才能对齐（`preferences-changed` + `broadcast_preferences`）。
 * 现在设置是主界面上的浮层，同一个文档、同一个模块级变量——广播整条链路
 * 连同它带来的「别把自己发的再收回来」判断一起删掉了。
 *
 * 剩下的这条腿仍然必要：`localStorage` 负责**重启后还在**。
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
  /** 提示音开关（§12.12）。默认关闭。 */
  sound: boolean
  /** 提示音音量 0–100，独立于系统音量。 */
  soundVolume: number
  /**
   * 系统通知开关（§12.10）。默认关闭。
   *
   * 只管「窗口不可见时她主动开口」这一件事。与 `sound` 不是同一层：
   * 声音是应用自己出的声，通知是系统替他提醒；关掉一个不影响另一个。
   */
  notify: boolean
  /**
   * 当前选用的自定义模型提供商 id（§G3）。
   *
   * 空串表示使用内置的三档预设来源。非空时指向用户在「对话」页添加的
   * 某个 OpenAI 兼容端点。实际推理路由由宿主按此值切换——偏好只负责
   * 「选了哪一个」，不负责「怎么连」。
   */
  provider: string
  /**
   * 是否启用语音输入（§G2）。
   *
   * 默认关闭。开启后输入框出现麦克风按钮，可录音并转写为文字。
   * 麦克风授权由系统在首次使用时请求；本机需装有本地语音识别模型才能真正转写。
   */
  voiceInput: boolean
  /**
   * 开发者模式：插件参数里是否显示高级字段。
   *
   * ## 为什么是一个持久偏好而不是面板内的临时开关
   *
   * 会开它的人，通常每次都要开。存成临时状态等于让他每次进来点一下，
   * 而这一步没有任何信息量。反过来，普通用户从默认值开始就看不到它，
   * 也不会误触——所以持久化的风险为零。
   */
  developerMode: boolean
}

/** 出厂默认值。 */
const DEFAULTS: Preferences = {
  theme: 'system',
  fontScale: 'standard',
  sendMode: 'interrupt',
  /*
   * §12.12 第一行就是「默认关闭」。
   *
   * 这不是保守，是唯一正确的默认：声音是**用户主动要的**一层打扰。
   * 在图书馆、会议、深夜打开应用的人，第一声提示音就够他把它关掉——
   * 而默认关着的人，只会在想开的时候去开，永远不会因为被吵到而离开。
   */
  sound: false,
  /*
   * 默认 60 而不是 100。
   *
   * 用户打开声音的那一刻就要立刻听到一声，那一声的响度决定他对这个
   * 功能的印象。100 在耳机上偏响；60 是"能听见但不惊人"的位置，
   * 想要更响的人自己会去拉。
   */
  soundVolume: 60,
  /*
   * 通知默认关（§12.10 原话：「系统通知 默认关闭」）。
   *
   * 这条比声音那条更硬：系统通知是**跨出应用边界**的打扰——它会出现在
   * 用户看别的应用时、在锁屏上、在会议共享的屏幕上。声音最坏是吵到旁边
   * 的人，通知最坏是让一屋子人看到你的屏幕。
   */
  notify: false,
  provider: '',
  voiceInput: false,
  developerMode: false,
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
const KEY_SOUND = 'ondra.sound'
const KEY_VOLUME = 'ondra.soundVolume'
const KEY_NOTIFY = 'ondra.notify'
const KEY_PROVIDER = 'ondra.provider'
const KEY_VOICE = 'ondra.voiceInput'
const KEY_DEVELOPER = 'ondra.developerMode'

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

/**
 * 把音量收窄到 0–100 的整数。
 *
 * 存的是字符串，读回来可能是 `"70"`、`""`、`"abc"`，也可能是旧版本
 * 留下的 `"0.7"`（比例写法）。`Number()` 对后两者给出 `NaN` 与 `0.7`：
 * 前者回落默认，后者若不处理会被当成 0.7% 的音量——近乎无声。
 * 小于 1 的非零值按比例理解，是唯一能同时兼容两种写法的判据。
 */
function pickVolume(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const raw = Number(value)
  if (!Number.isFinite(raw)) return fallback
  const scaled = raw > 0 && raw < 1 ? raw * 100 : raw
  return Math.min(100, Math.max(0, Math.round(scaled)))
}

/** 从磁盘读。启动时调一次。 */
export function loadPreferences(): Preferences {
  current = {
    theme: pick(read(KEY_THEME), ['system', 'light', 'dark'] as const, DEFAULTS.theme),
    fontScale: pick(read(KEY_FONT), ['small', 'standard', 'large'] as const, DEFAULTS.fontScale),
    sendMode: pick(read(KEY_SEND), ['queue', 'interrupt'] as const, DEFAULTS.sendMode),
    // 开关只认 `'on'`：`localStorage` 里只可能有我们自己写的这一个值，
    // 出现别的一律当没开——声音这种东西，坏方向的默认才安全。
    sound: read(KEY_SOUND) === 'on',
    soundVolume: pickVolume(read(KEY_VOLUME), DEFAULTS.soundVolume),
    /*
     * 通知：**没存过**才用出厂值，存过就只认 `'on'`。
     *
     * 这一行与上面 `sound` 那行的差别看着琐碎，其实是「一处真源」的
     * 要求：上一版写成 `read(KEY_NOTIFY) === 'on'`，等于把默认值硬编码
     * 在这里，`DEFAULTS.notify` 从此无论改成什么都不生效——两个地方
     * 各说一套，而真正起作用的那一处没有注释说明。
     *
     * 这是反向验证抓出来的：把 `DEFAULTS.notify` 改成 `true`，断言
     * **不报红**。那一刻红的不是测试，是这份重复。
     *
     * `sound` 那行暂时保留原样：它的行为与默认值恰好一致（都是关），
     * 改它属于另一件事，不在本轮范围内混着动。
     */
    notify: read(KEY_NOTIFY) === undefined ? DEFAULTS.notify : read(KEY_NOTIFY) === 'on',
    provider: read(KEY_PROVIDER) ?? DEFAULTS.provider,
    voiceInput: read(KEY_VOICE) === 'on',
    developerMode: read(KEY_DEVELOPER) === 'on',
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
 * ## 为什么不再有「广播到其他窗口」
 *
 * 上一版有两个窗口（主界面 + 独立偏好窗口），两边各有自己的 JS 文档与
 * 内存副本，改一项必须由壳转发一次才能对齐。现在设置是主界面上的一个
 * 浮层，同一个文档、同一份 `current`——广播这件事整个消失了。
 *
 * 顺带消失的还有三个由此而生的东西：`broadcast_preferences` 命令、
 * `preferences-changed` 监听、以及「别把自己发的再收回来」那条判断。
 *
 * @param patch 要改的字段。
 */
export function setPreferences(patch: Partial<Preferences>): void {
  const next: Preferences = { ...current, ...patch }
  current = next

  write(KEY_THEME, next.theme)
  write(KEY_FONT, next.fontScale)
  write(KEY_SEND, next.sendMode)
  write(KEY_SOUND, next.sound ? 'on' : 'off')
  write(KEY_VOLUME, String(next.soundVolume))
  write(KEY_NOTIFY, next.notify ? 'on' : 'off')
  write(KEY_PROVIDER, next.provider)
  write(KEY_VOICE, next.voiceInput ? 'on' : 'off')
  write(KEY_DEVELOPER, next.developerMode ? 'on' : 'off')

  applyPreferences(next)
  notify()
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

/**
 * 启动偏好层。在 `main.tsx` 调用一次。
 *
 * 做两件事：读盘并应用、跟随系统主题的变化。
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
}