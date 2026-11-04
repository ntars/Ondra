/**
 * 内置浏览器面板的界面。
 *
 * ## 这个组件为什么没有地址栏
 *
 * 不是「先不做」，是**刻意不做**。一旦有地址栏，就必然有输入框；有输入框，
 * 用户就能把地址改成任意站点，白名单也就失去意义。所以这里连只读的地址展示都没有：
 * 用户看不到任何 URL，也就没有「改一下试试」的入口。
 *
 * ## 为什么用 iframe 而不是 `<webview>`
 *
 * `<webview>` 需要 Electron 的 `will-attach-webview` 配合独立 partition
 * （见 `desktop/apps/desktop/src/browser-guests.ts`），那套机制是为「用户自己输地址
 * 上网」设计的，带来的是地址栏、历史、每个 workspace 一个持久分区。本面板不需要这些。
 *
 * iframe 的代价是：只能加载**同源**页面。这恰好与需求一致——首屏永远是本机 `/pane/*`，
 * 跨域只发生在页面内部向白名单域名的跳转，那次跳转由宿主 `/pane/allow` 放行。
 *
 * ## file:// 下会显示明确提示，而不是白屏
 *
 * 若渲染页自身就是从 `file://` 加载的，相对路径拿不到宿主路由，iframe 只会白屏。
 * 白屏是最糟的失败形态——用户会以为「功能坏了」而不是「环境不支持」。
 * 所以这里先判协议，不满足就渲染一句人话。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@ntars/ondra-client-ui-slots'
import { zh, type BrowserPaneKey } from './locales.ts'
import css from './PaneBody.module.css'

/** 宿主状态接口的形状（只声明本组件用到的字段）。 */
interface PaneState {
  readonly pages: readonly { readonly id: string; readonly title: string; readonly plugin: string }[]
  readonly pending: { readonly page: string; readonly title: string } | null
}

/** 面板状态机。 */
type PaneStatus =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly pageId: string; readonly title: string; readonly pages: PaneState['pages'] }

/** 面板 body 的 props：由 tab seat 组装。 */
export type PaneBodyProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'browserPane'>

/** 判断当前渲染页能否使用同源相对路径。 */
function supportsLocalHost(): boolean {
  const protocol = globalThis.location?.protocol
  // http(s) 才有同源宿主；file: 与自定义协议都不行。
  return protocol === 'http:' || protocol === 'https:'
}

/**
 * 内置浏览器面板。
 * @param props tabs 运行时信息与本地化文案。
 * @returns 面板内容。
 */
export function PaneBody({ useTabInfo, t }: PaneBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const [status, setStatus] = useState<PaneStatus>(() => (
    supportsLocalHost() ? { kind: 'loading' } : { kind: 'unsupported' }
  ))
  const [reloadToken, setReloadToken] = useState(0)

  const load = useCallback(async (signal: AbortSignal): Promise<void> => {
    if (!supportsLocalHost()) return
    try {
      const response = await fetch('/pane/state', { signal, headers: { Accept: 'application/json' } })
      if (!response.ok) {
        setStatus({ kind: 'error' })
        return
      }
      const state = (await response.json()) as PaneState
      if (state.pages.length === 0) {
        setStatus({ kind: 'empty' })
        return
      }
      // 优先用宿主给的待处理请求，其次留在当前页，最后退回第一页。
      const wanted = state.pending?.page
      const current = status.kind === 'ready' ? status.pageId : undefined
      const chosen = state.pages.find(page => page.id === wanted)
        ?? state.pages.find(page => page.id === current)
        ?? state.pages[0]
      if (chosen === undefined) {
        setStatus({ kind: 'empty' })
        return
      }
      setStatus({ kind: 'ready', pageId: chosen.id, title: chosen.title, pages: state.pages })
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') return
      setStatus({ kind: 'error' })
    }
  }, [status])

  useEffect(() => {
    if (!supportsLocalHost()) return
    const controller = new AbortController()
    void load(controller.signal)
    return () => { controller.abort() }
    // `reloadToken` 是显式的重试开关；`tab.id` 变化表示切到了另一个 tab 实例。
  }, [load, reloadToken, tab.id])

  const retry = (): void => {
    setStatus({ kind: 'loading' })
    setReloadToken(value => value + 1)
  }

  if (status.kind === 'unsupported') {
    return (
      <div className={css.state}>
        <p className={css.stateTitle}>{t('unsupported.title')}</p>
        <p className={css.stateBody}>{t('unsupported.body')}</p>
      </div>
    )
  }

  if (status.kind === 'loading') {
    return <div className={css.state}><p className={css.stateBody}>{t('reload')}…</p></div>
  }

  if (status.kind === 'empty') {
    return (
      <div className={css.state}>
        <p className={css.stateTitle}>{t('empty.title')}</p>
        <p className={css.stateBody}>{t('empty.body')}</p>
      </div>
    )
  }

  if (status.kind === 'error') {
    return (
      <div className={css.state}>
        <p className={css.stateTitle}>{t('error.title')}</p>
        <p className={css.stateBody}>{t('error.body')}</p>
        <button type="button" className={css.retry} onClick={retry}>{t('error.retry')}</button>
      </div>
    )
  }

  return (
    <div className={css.pane}>
      <div className={css.bar}>
        <span className={css.title} title={status.title}>{status.title}</span>
        <button type="button" className={css.action} onClick={retry} aria-label={t('reload')} title={t('reload')}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.714" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M13.25 2.75v3.5h-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <iframe
        // key 里带 reloadToken，重试时强制重建 iframe（直接改 src 会保留上一页的滚动位置与表单状态）。
        key={`${status.pageId}-${String(reloadToken)}`}
        className={css.frame}
        src={`/pane/view/${encodeURIComponent(status.pageId)}`}
        title={status.title}
        // 允许脚本与表单（注册页要填写），但不给弹窗、不给顶层跳转：
        // 前者会绕开「不开新窗口」的约定，后者能把整个应用导航走。
        sandbox="allow-scripts allow-same-origin allow-forms"
        referrerPolicy="no-referrer"
      />
    </div>
  )
}

/** 空导出，保证 `zh` 的类型在打包后仍被引用（避免 tree-shaking 掉键集合校验的锚点）。 */
export const LOCALE_KEYS: readonly BrowserPaneKey[] = Object.keys(zh) as BrowserPaneKey[]
