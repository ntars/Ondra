/**
 * 偏好设置窗口（§5.13 第一层）。
 *
 * ## 它是独立文档，不是主窗口里的浮层
 *
 * 壳用 `#preferences` 这个 hash 打开**同一份前端产物**，由 `main.tsx`
 * 决定渲染这一棵树。好处是令牌、主题、平台标记只有一份实现；
 * 代价是这个文件必须自己补齐「一个窗口该有的东西」：标题栏、拖拽区、
 * 关闭键——主窗口那份 `TitleBar` 带着会话标题与 Windows 三键，
 * 语义不同，不能直接复用。
 *
 * ## 八个页面，每一格都必须有真数据
 *
 * §5.13 定的是「主题、语言、字号、发送方式、默认权限、更新、关于」。
 * 逐页对过现有能力：
 *
 * | 页 | 数据来源 | 能不能真的生效 |
 * | --- | --- | --- |
 * | 主题 | `preferences.theme` | 能，写 `data-theme` 并广播 |
 * | 语言 | 无（只有简体中文） | 只能显示一档，不给假下拉 |
 * | 字号 | `preferences.fontScale` | 能，写 `html` 的 `font-size` |
 * | 声音 | `preferences.sound` + `.soundVolume` | 能，`sound.ts` 直接读 |
 * | 发送方式 | `preferences.sendMode` | 能，`Composer` 直接读 |
 * | 默认权限 | 宿主 `/api/config/permission` | 能，写宿主 |
 * | 更新 | 版本号来自构建期常量 | 只能给下载页，没有自动更新通道 |
 * | 关于 | 同上 + 许可证 | 静态 |
 *
 * 「语言」与「更新」两页都**不做假控件**：语言页只列一档并说明原因，
 * 更新页不开一个点了没反应的「检查更新」。§1.2 第 3 条：不做假装。
 *
 * ## 为什么改动即时生效、没有「保存」按钮
 *
 * §6.5 第 1 行：外观类设置「即时生效，延迟上限 0」。加一个保存按钮会
 * 让用户不确定「我刚才拖的那下算不算数」，而这里没有任何需要批量提交的
 * 状态——每一项都是独立的键。
 */

import { useEffect, useState } from 'react'
import { Icon } from './Icon.tsx'
import { IconClose } from './icons.ts'
import { Mark } from './Mark.tsx'
import { invokeShell, isDesktopShell } from '../lib/shell.ts'
import { getConnection, setConnection } from '../lib/host.ts'
import { setPreferences, usePreferences } from '../lib/preferences.ts'
import type { FontScale, SendMode } from '../lib/preferences.ts'
import { getConfig, savePermission } from '../lib/api.ts'
import type { PermissionLevel, ThemeMode } from '../lib/api.ts'
import { playCue, previewCue } from '../lib/sound.ts'
import type { SoundCue } from '../lib/sound.ts'
import { readPermission, requestPermission } from '../lib/notify.ts'
import type { NotifyPermission } from '../lib/notify.ts'

/** 仓库与下载页。关于页与更新页共用，不各写一份。 */
const REPO = 'https://github.com/ntars/Ondra'
const RELEASES = 'https://github.com/ntars/Ondra/releases'

/**
 * 三种音的展示清单。
 *
 * 顺序即用户在会话里听到它们的顺序：先发出去，她才开口，出错收尾。
 * 文案用动词/名词的原样，不写「音效一」「提示音 A」——那种命名
 * 让用户不知道该期待什么。
 */
const CUES: Array<{ key: SoundCue; label: string; hint: string }> = [
  { key: 'send', label: '发送', hint: '一句话送出去时' },
  { key: 'speak', label: '她开口', hint: '她开始回你时' },
  { key: 'error', label: '出错', hint: '这一轮没成时' },
]

/** 九个页面的键。顺序即导航顺序（§5.13 的列举顺序 + §12.12 的声音 + §12.10 的通知）。 */
type PageKey =
  | 'theme'
  | 'language'
  | 'font'
  | 'sound'
  | 'notify'
  | 'send'
  | 'permission'
  | 'update'
  | 'about'

interface Page {
  key: PageKey
  label: string
}

const PAGES: Page[] = [
  { key: 'theme', label: '主题' },
  { key: 'language', label: '语言' },
  { key: 'font', label: '字号' },
  { key: 'sound', label: '声音' },
  { key: 'notify', label: '通知' },
  { key: 'send', label: '发送方式' },
  { key: 'permission', label: '默认权限' },
  { key: 'update', label: '更新' },
  { key: 'about', label: '关于' },
]

/**
 * 一组单选。
 *
 * ## 为什么不用原生 radio + 自绘圆点
 *
 * 三种主题要显示**三张预览卡**（浅色/深色/跟随系统），原生 radio
 * 接不进去。这里统一成一个分段组：每个选项是一块可点区域，
 * 内部允许带预览图形。键盘行为靠 `role="radiogroup"` + 方向键补。
 */
function Choices<T extends string>({
  name,
  value,
  options,
  onChange,
}: {
  name: string
  value: T
  options: Array<{ value: T; label: string; hint?: string }>
  onChange(next: T): void
}): React.JSX.Element {
  return (
    <div className="pref__choices" role="radiogroup" aria-label={name}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className="pref__choice"
          onClick={() => { onChange(option.value) }}
        >
          <span className="pref__choice-label">{option.label}</span>
          {option.hint === undefined ? null : (
            <span className="pref__choice-hint">{option.hint}</span>
          )}
        </button>
      ))}
    </div>
  )
}

/** 一行的说明文字。每页都用同一种排版，避免八个页面各长一样又各差一点。 */
function Note({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="pref__note">{children}</p>
}

/**
 * 开关。
 *
 * ## 为什么不用 `<input type="checkbox">`
 *
 * 原生复选框的视觉由系统画，改不动尺寸与圆角，在 560 宽的窗口里
 * 会显得比周围所有控件都"外来"。`role="switch"` +
 * `aria-checked` 语义与复选框等价，样式完全可控，且 §13 要求
 * 禁用态用 `aria-disabled` 不用原生 `disabled`——一并在这里成立。
 */
function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange(next: boolean): void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="pref__switch control-switch"
      onClick={() => { onChange(!checked) }}
    >
      <span className="pref__switch-knob control-switch-knob" />
    </button>
  )
}

/**
 * 打开一个外部链接。
 *
 * 走壳的 opener 插件而不是 `window.open`：WebView 里的 `window.open`
 * 会开一个没有地址栏的新窗口，用户拿不到链接也复制不走。
 */
function openExternal(url: string): void {
  void invokeShell<null>('plugin:opener|open_url', { url }).catch(() => {
    /* 不在壳内（浏览器开发态）。不提示：这是开发者才会遇到的情况。 */
  })
}

/**
 * 确保本窗口拿到了宿主连接信息。
 *
 * ## 为什么偏好窗口必须主动要一次
 *
 * 连接信息是壳在**启动宿主成功后**通过 `host-ready` 事件推给页面的。
 * 主窗口在那一刻已经加载完，收得到；偏好窗口是用户后来按 `Cmd/Ctrl + ,`
 * 才创建的——**那条事件早就发过了**，它永远等不到。
 *
 * 不补这一步的表现：主题、字号都能改（不依赖宿主），但「默认权限」页
 * 会永远停在「正在读取…」。而这类缺陷不会报错，只会让人以为宿主挂了。
 *
 * 用 `get_host_state` 主动查一次，比「壳在每次建窗口后补发事件」更稳：
 * 后者要记住所有历史窗口，且时序仍然依赖建窗与发事件的先后。
 */
async function ensureConnection(): Promise<void> {
  if (getConnection() !== undefined) return
  type ShellState = { state: string; url?: string; token?: string; port?: number }
  const snapshot = await invokeShell<ShellState>('get_host_state')
  if (snapshot.state !== 'ready') throw new Error('后台服务还没就绪')
  if (snapshot.url === undefined || snapshot.token === undefined || snapshot.port === undefined) {
    throw new Error('后台服务报告了就绪但没给连接信息')
  }
  setConnection({ url: snapshot.url, token: snapshot.token, port: snapshot.port })
}

/** 渲染偏好设置窗口。 */
export function Preferences(): React.JSX.Element {
  const prefs = usePreferences()
  const [page, setPage] = useState<PageKey>('theme')
  /** 权限档位来自宿主，不在本地存。读到之前是 undefined。 */
  const [permission, setPermissionState] = useState<PermissionLevel | undefined>(undefined)
  const [permissionError, setPermissionError] = useState('')
  /** 通知权限。打开「通知」页时读一次，不改就不请求。 */
  const [notifyPermission, setNotifyPermission] = useState<NotifyPermission>('default')

  /*
   * 权限档位只在打开「默认权限」页时去读。
   *
   * 偏好窗口打开的默认页是「主题」，而读权限要走一次 HTTP。为了一个
   * 用户可能不看的页在窗口出现时多一次请求，会让窗口打开的那一帧
   * 多一个竞态（列表还没回来时的空白）。按需读，延迟落在用户点导航
   * 的那一刻，人感觉不到。
   */
  useEffect(() => {
    if (page !== 'permission') return
    let alive = true
    void ensureConnection()
      .then(() => getConfig())
      .then(
        (config) => { if (alive) { setPermissionState(config.permission); setPermissionError('') } },
        (caught: unknown) => {
          if (!alive) return
          setPermissionError(caught instanceof Error ? caught.message : '读不到权限设置')
        },
      )
    return () => { alive = false }
  }, [page])

  /** 关掉窗口。壳内走命令；浏览器里没有窗口可关，退化为返回主界面。 */
  const close = (): void => {
    void invokeShell<null>('close_preferences').catch(() => {
      globalThis.location.hash = ''
    })
  }

  /**
   * 打开或关闭提示音。
   *
   * ## 打开的同时播一声
   *
   * §6.5 把「音量」列为可预演的一项：「播放一声 200ms 的提示音」。
   * 开声音的那一刻同样该有一个确认——否则用户不知道它到底开没开，
   * 只能等下一次真实发消息。这一声用 `previewCue`：它绕开开关，
   * 但此刻开关刚被设为开，走哪一条都一样。
   */
  const changeSound = (next: boolean): void => {
    setPreferences({ sound: next })
    if (next) previewCue('send')
  }

  /**
   * 打开或关闭系统通知（§12.10、§7.5 最后一条）。
   *
   * ## 请求权限的时机只能在这里
   *
   * §7.5：「系统通知权限只在用户开启"主动消息"时才请求，不在首启请求」。
   * 这一条决定了整个函数的形状——它必须是**用户点开关**触发的，
   * 不能在窗口打开时顺手请求。
   *
   * ## 被拒绝时开关要弹回去
   *
   * 用户点了「不允许」，如果开关还停在「开」，他会以为设置成功了，
   * 然后一直等一条永远不会来的通知。弹回去 + 一句说明（去哪开）
   * 是唯一诚实的做法。
   */
  const changeNotify = async (next: boolean): Promise<void> => {
    if (!next) {
      setPreferences({ notify: false })
      return
    }
    /*
     * 先落开关再请求：请求会弹系统框，用户点完才返回。若等他点完
     * 才写偏好，那几百毫秒里界面上的开关是不动的——点了没反应。
     * 落完再请求，若被拒则回滚。
     */
    setPreferences({ notify: true })
    const result = await requestPermission()
    setNotifyPermission(result)
    if (result !== 'granted') {
      setPreferences({ notify: false })
    }
  }

  /*
   * 读一次通知权限（只读，不请求）。
   *
   * 与「默认权限」页同一个理由：不为用户可能不看的页在窗口打开时
   * 多跑一次 IPC。但这里还要多做一件事——用户可能已经授权过、
   * 开关却因为别的原因关着（比如上次被拒后回滚）。读到已授权就
   * 不显示那句「去系统设置」的提示，免得他自己都授权了还被告知去开。
   */
  useEffect(() => {
    if (page !== 'notify') return
    let alive = true
    void readPermission().then((next) => { if (alive) setNotifyPermission(next) })
    return () => { alive = false }
  }, [page])

  /** Esc 关窗（§9.3 最外层）。 */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    globalThis.addEventListener('keydown', onKeyDown)
    return () => { globalThis.removeEventListener('keydown', onKeyDown) }
  }, [])

  /**
   * 改权限。
   *
   * 先改本地（界面立刻跟手，§6.5），再写宿主。写失败时回滚并说明原因——
   * 不回滚的话界面会一直显示一个宿主持有的旧值，而用户以为已经改了。
   */
  const changePermission = (next: PermissionLevel): void => {
    const previous = permission
    setPermissionState(next)
    void savePermission(next).catch((caught: unknown) => {
      setPermissionState(previous)
      setPermissionError(caught instanceof Error ? caught.message : '写入失败')
    })
  }

  return (
    <div className="pref">
      {/*
        标题栏。与主窗口一样 44px、整条可拖拽。
        标题固定在左（导航栏宽 160），不居中：这个窗口只有一块内容，
        没有「主列居中」与「全窗居中」的分歧，居中没有额外收益。
      */}
      <header className="pref__titlebar" data-tauri-drag-region>
        <span className="pref__title">偏好设置</span>
        {/*
          macOS 上红绿灯在左上（trafficLightPosition 18,16），
          所以标题要让位；Windows 上三键在右上，标题不用动。
          用 CSS 的 `[data-platform]` 分支处理，与主窗口一致。
        */}
        <button type="button" className="pref__close" aria-label="关闭" onClick={close}>
          <Icon icon={IconClose} size={16} />
        </button>
      </header>

      <div className="pref__body">
        <nav className="pref__nav" aria-label="设置分类">
          {PAGES.map((item) => (
            <button
              key={item.key}
              type="button"
              className="pref__nav-item"
              aria-current={item.key === page ? 'page' : undefined}
              onClick={() => { setPage(item.key) }}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <main className="pref__content">
          {page === 'theme' ? (
            <section className="pref__section">
              <h2 className="pref__heading">主题</h2>
              <Choices<ThemeMode>
                name="主题"
                value={prefs.theme}
                onChange={(next) => { setPreferences({ theme: next }) }}
                options={[
                  { value: 'system', label: '跟随系统', hint: '系统换深色时她也换' },
                  { value: 'light', label: '浅色', hint: '纸白' },
                  { value: 'dark', label: '深色', hint: '墨夜' },
                ]}
              />
              <Note>
                跟随系统时，系统在日落前后切换，这里也跟着换。选了浅色或深色就不再随系统动——
                那不是「跟随」，是听话。
              </Note>
            </section>
          ) : null}

          {page === 'language' ? (
            <section className="pref__section">
              <h2 className="pref__heading">语言</h2>
              <Choices<'zh-CN'>
                name="语言"
                value="zh-CN"
                onChange={() => { /* 只有一档，无从切换 */ }}
                options={[{ value: 'zh-CN', label: '简体中文', hint: '当前唯一语言' }]}
              />
              <Note>
                界面文案、错误提示、日期格式与人格语料都是简体中文写死的，没有可切换的第二套。
                这一页保留一个不可选的原因是：**让它明确地只有一档**，比藏起来好——
                用户找不到语言选项时会怀疑是没装全。
              </Note>
            </section>
          ) : null}

          {page === 'font' ? (
            <section className="pref__section">
              <h2 className="pref__heading">字号</h2>
              <Choices<FontScale>
                name="字号"
                value={prefs.fontScale}
                onChange={(next) => { setPreferences({ fontScale: next }) }}
                options={[
                  { value: 'small', label: '小', hint: '15px' },
                  { value: 'standard', label: '标准', hint: '16px' },
                  { value: 'large', label: '大', hint: '18px' },
                ]}
              />
              {/*
                预演（§6.5）：拖动后下方示例句按新字号重排。
                它用的是真实的正文字号令牌，所以不是"画一个大概"。
              */}
              <div className="pref__sample">
                <p className="pref__sample-text">于无声处，听见共鸣。这句话按当前字号排出来。</p>
                <span className="pref__sample-meta">
                  示例用正文字号（--text-body），不是缩放整个示例块
                </span>
              </div>
              <Note>
                这里改的是全局比例，会在系统字号的基础上再放大或缩小。系统里已经调大过的人，
                用「标准」不会把他调回小字。
              </Note>
            </section>
          ) : null}

          {page === 'sound' ? (
            <section className="pref__section">
              <h2 className="pref__heading">声音</h2>

              <div className="pref__row">
                <div className="pref__row-text">
                  <span className="pref__row-label">提示音</span>
                  <span className="pref__row-hint">发送、她开口、出错时各一声</span>
                </div>
                <Toggle
                  label="提示音"
                  checked={prefs.sound}
                  onChange={changeSound}
                />
              </div>

              <div className="pref__slider" data-off={prefs.sound ? undefined : ''}>
                <div className="pref__slider-head">
                  <span className="pref__row-label">音量</span>
                  <span className="pref__slider-readout" aria-hidden="true">{prefs.soundVolume}</span>
                </div>
                <input
                  type="range"
                  className="pref__range control-range"
                  min={0}
                  max={100}
                  step={1}
                  value={prefs.soundVolume}
                  aria-label="提示音音量"
                  aria-valuetext={`${String(prefs.soundVolume)}`}
                  disabled={!prefs.sound}
                  /* 已填充比例（§12.16）。0–100 的连续档，直接用值当百分比。 */
                  style={{ '--fill': `${String(prefs.soundVolume)}%` } as React.CSSProperties}
                  onChange={(event) => {
                    setPreferences({ soundVolume: Number(event.target.value) })
                  }}
                  /*
                    松手才试听（§6.5「音量 → 播放一声 200ms 的提示音」）。
                    拖动过程中每帧都响会变成一串机关枪，那不是预演是噪音。
                    `onChange` 在 WebKit 上随拖动连续触发，所以预演挂在
                    `onPointerUp` / `onKeyUp` 上，而不是 `onChange`。
                  */
                  onPointerUp={() => { playCue('send') }}
                  onKeyUp={() => { playCue('send') }}
                />
                <p className="pref__note">
                  这一档音量只影响这三个音，不动系统音量——你调系统音量是为了别的应用，
                  这里不该跟着变。
                </p>
              </div>

              {/*
                三种音逐个可听。
                没有这三个入口，「只有三种音」就只是一句话：用户没法知道
                「她开口」和「发送」听起来有什么不同，也就没法判断要不要开。
              */}
              <div className="pref__cues">
                {CUES.map((cue) => (
                  <button
                    key={cue.key}
                    type="button"
                    className="pref__cue"
                    aria-disabled={prefs.sound ? undefined : 'true'}
                    title={prefs.sound ? undefined : '先打开提示音'}
                    onClick={() => {
                      if (!prefs.sound) return
                      playCue(cue.key)
                    }}
                  >
                    <span className="pref__cue-name">{cue.label}</span>
                    <span className="pref__cue-hint">{cue.hint}</span>
                  </button>
                ))}
              </div>

              <Note>
                不做打字音，也不做环境音。打字音会跟着逐字流出的文字响成一片，
                环境音则把陪伴做成一个播放器——两件都不是这里想要的。
                托盘菜单的「静音 1 小时」对这三个音同样生效。
              </Note>
            </section>
          ) : null}

          {page === 'notify' ? (
            <section className="pref__section">
              <h2 className="pref__heading">通知</h2>

              <div className="pref__row">
                <div className="pref__row-text">
                  <span className="pref__row-label">系统通知</span>
                  <span className="pref__row-hint">窗口不在桌面时，她说的话会弹到通知栏</span>
                </div>
                <Toggle
                  label="系统通知"
                  checked={prefs.notify}
                  onChange={(next) => { void changeNotify(next) }}
                />
              </div>

              {/*
                权限被拒时给一条可执行的出路，而不是只说「不可用」。
                §7.6 的三段式在这里同样适用：发生了什么（没授权）·
                为什么（系统里关着）· 下一步（去系统设置打开）。
              */}
              {notifyPermission === 'denied' ? (
                <p className="pref__note pref__note--warn">
                  系统里拒绝了通知权限。去「系统设置 → 通知 → 空谷 Ondra」打开，
                  再回来打开这个开关。
                </p>
              ) : null}
              {notifyPermission === 'unsupported' ? (
                <p className="pref__note">
                  这台机器上读不到通知权限（浏览器里预览时也会这样）。桌面端才能发系统通知。
                </p>
              ) : null}

              <Note>
                只有窗口看不见的时候才发。窗口在屏幕上、只是焦点在别的应用，不会弹——
                你回来一眼就能看到，那时候弹反而是打扰。
              </Note>
              <Note>
                她主动开口仍受每天的上限与作息约束，通知只是把已经在时间轴上的那一句
                搬到你看得见的地方。静音期间不发任何通知。
              </Note>
            </section>
          ) : null}

          {page === 'send' ? (
            <section className="pref__section">
              <h2 className="pref__heading">发送方式</h2>
              <Choices<SendMode>
                name="发送方式"
                value={prefs.sendMode}
                onChange={(next) => { setPreferences({ sendMode: next }) }}
                options={[
                  { value: 'interrupt', label: '打断', hint: '她正在说时，按 Enter 立刻改说你的' },
                  { value: 'queue', label: '排队', hint: '等她说完这一轮再接你的' },
                ]}
              />
              <Note>
                这只影响「她正在生成时」按 Enter 的行为。空闲时 Enter 永远是发送，
                Shift + Enter 永远是换行。选「排队」时，生成中按 Cmd/Ctrl + Enter 可以越过队列立刻发。
              </Note>
            </section>
          ) : null}

          {page === 'permission' ? (
            <section className="pref__section">
              <h2 className="pref__heading">默认权限</h2>
              {permission === undefined ? (
                <p className="pref__note">
                  {permissionError === '' ? '正在读取…' : `读不到权限设置：${permissionError}`}
                </p>
              ) : (
                <Choices<PermissionLevel>
                  name="默认权限"
                  value={permission}
                  onChange={changePermission}
                  options={[
                    { value: 'chat', label: '只在对话内', hint: '不碰文件、不跑命令' },
                    { value: 'workspace', label: '限于工作区', hint: '能在绑定的目录里读写' },
                    { value: 'full', label: '不限制', hint: '能读到整台机器' },
                  ]}
                />
              )}
              {permissionError === '' ? null : (
                <p className="pref__error" role="alert">{permissionError}</p>
              )}
              <Note>
                这是新会话的默认档位，不是当前会话的。已经开着的对话各自记住自己建立时的档位——
                否则改一次默认值，正在进行的对话会在中途悄悄扩大权限。
              </Note>
            </section>
          ) : null}

          {page === 'update' ? (
            <section className="pref__section">
              <h2 className="pref__heading">更新</h2>
              <dl className="pref__facts">
                <dt>当前版本</dt>
                <dd>{__APP_VERSION__}</dd>
                <dt>更新方式</dt>
                <dd>手动替换</dd>
              </dl>
              <button type="button" className="pref__action" onClick={() => { openExternal(RELEASES) }}>
                打开下载页
              </button>
              <Note>
                这一版没有内置的更新通道：下载新的安装包覆盖安装即可，配置与对话都留在原来的位置，
                不会被覆盖掉。做成「检查更新」按钮要先有一个能签名的更新源，现在没有，
                所以不放一个点了没反应的按钮。
              </Note>
            </section>
          ) : null}

          {page === 'about' ? (
            <section className="pref__section">
              <h2 className="pref__heading">关于</h2>
              <div className="pref__brand">
                <Mark size={48} variant="tile" label="空谷 Ondra" />
                <div>
                  <div className="pref__brand-name">空谷 Ondra</div>
                  <div className="pref__brand-slogan">于无声处，听见共鸣。</div>
                </div>
              </div>
              <dl className="pref__facts">
                <dt>版本</dt>
                <dd>{__APP_VERSION__}</dd>
                <dt>许可证</dt>
                <dd>AGPL-3.0</dd>
                <dt>仓库</dt>
                <dd>
                  <button type="button" className="pref__link" onClick={() => { openExternal(REPO) }}>
                    github.com/ntars/Ondra
                  </button>
                </dd>
              </dl>
              {/*
                初始引导尚未实现（§5.14 四步卡片没做）。按 §5.9 的规则：
                禁用项**保留**、灰显、`title` 写原因——而不是删掉这一行。
                删掉的话，用户看过文档再来找会以为界面缺了一块。
              */}
              <button
                type="button"
                className="pref__action"
                aria-disabled="true"
                title="初始引导还没做，做完之后这里可以重看"
                onClick={(event) => { event.preventDefault() }}
              >
                重新观看引导
              </button>
              <p className="pref__note">引导还没做，所以这一项暂时点不动。</p>
            </section>
          ) : null}
        </main>
      </div>
    </div>
  )
}

/**
 * 打开偏好设置窗口。
 *
 * ## 壳内与浏览器两条路
 *
 * 壳内开原生窗口（`preferences.rs`）。浏览器里没有第二个窗口，
 * 退化为同页跳转 `#preferences`——开发者仍然能看到这块界面，
 * 而不是收到一句「不在壳内」。
 *
 * @returns 是否由壳打开了窗口。`false` 时调用方可以据此决定要不要提示。
 */
export function requestPreferences(): void {
  if (!isDesktopShell()) {
    globalThis.location.hash = '#preferences'
    return
  }
  void invokeShell<null>('open_preferences').catch((caught: unknown) => {
    console.error('打开偏好设置失败', caught)
  })
}
