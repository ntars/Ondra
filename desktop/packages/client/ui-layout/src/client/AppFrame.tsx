/**
 * Three-column shell frame, registered into the built-in 'root' slot (the web
 * shell renders only 'root'). Owns the grid tracks (sidebar | center |
 * rightbar) and the child-slot render decisions. The root-scoped main slot
 * selects the Conversation or a global panel.
 *
 * The frame is a fixed quarter split — 1/4 | 2/4 | 1/4 — at every frame width.
 * The side columns are neither resizable nor collapsible: there is no drag
 * handle and no collapse control, so what the user cannot adjust cannot drift,
 * and every launch starts on the same proportions.
 *
 * The right column is a track, not a box: its occupant draws its panel anchored
 * to the frame's right edge at the resolved width. Everything arrives through
 * the framework shares — zero cordis or framework imports, zero self-made hooks.
 */
import { useLayoutEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import type {
  PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import { computeColumns } from './columns.ts'
import { DocumentTitle } from './DocumentTitle.tsx'
import type { createLayoutStore } from './stores.ts'
import css from './AppFrame.module.css'

/** Full composed props: runtime share + child-slot render share + store share. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'main' | 'rightbar' | 'shell.bottom' | 'shell.overlay' | 'shell.leading'>
  & PropsStore<ReturnType<typeof createLayoutStore>>
  & PropsLocale<'common'>

/** Center column grid item (session-body building block). */
function CenterColumn(props: { children?: ReactNode }) {
  return <div className={css.centerCol}>{props.children}</div>
}

/** Subscribe to the main key without subscribing the column frame to each panel id. */
function MainPanel({ usePanelInfo, renderSlot }: Pick<PropsRuntime<'root'>, 'usePanelInfo'> & PropsRenderSlots<'main'>) {
  const panelId = usePanelInfo(info => info.activePanelId)
  return renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })
}

/** Right column grid item: its occupant anchors the panel to the frame's right edge. */
function RightbarColumn(props: { children?: ReactNode }) {
  return <div className={css.rightbarCol} data-rightbar-col>{props.children}</div>
}

/** The three-column frame (see module doc). */
export function AppFrame({
  useStore,
  useSessions,
  usePanelInfo,
  actions,
  renderSlot,
  t,
}: AppFrameProps) {
  const viewport = useStore(state => state.layoutInfo.viewportWidth)
  const frameRef = useRef<HTMLDivElement | null>(null)

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  useLayoutEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    let raf: number | null = null
    let disposed = false
    const measure = () => {
      const width = el.getBoundingClientRect().width
      if (width > 0) actions.setViewportWidth(width)
    }
    measure()
    const observer = new ResizeObserver(() => {
      if (disposed) return
      raf ??= requestAnimationFrame(() => {
        raf = null
        measure()
      })
    })
    observer.observe(el)
    return () => {
      disposed = true
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [actions])

  const cols = computeColumns(viewport)

  const productTitle = process.env.DSH_CLIENT_TITLE ?? t('brand.localBuild')
  const sidebar = useMemo(() => renderSlot('sidebar', {
    width: cols.sidebar,
  }), [renderSlot, cols.sidebar])
  const main = useMemo(() => (
    <MainPanel usePanelInfo={usePanelInfo} renderSlot={renderSlot} />
  ), [usePanelInfo, renderSlot])
  const overlays = useMemo(() => renderSlot('shell.overlay', {}), [renderSlot])

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{
        ...(document.documentElement.hasAttribute('data-windows-titlebar')
          ? { '--dsh-windows-sidebar-width': `${cols.sidebar}px` } : {}),
        gridTemplateColumns: `${cols.sidebar}px minmax(0, 1fr) ${cols.rightbar}px`,
      }}
    >
      <DocumentTitle
        productTitle={productTitle}
        useSessions={useSessions}
        usePanelInfo={usePanelInfo}
      />
      <div className={css.sidebarCol}>
        {sidebar}
      </div>
      <>
        <CenterColumn>{main}</CenterColumn>
        <RightbarColumn>
          {renderSlot('rightbar', { width: cols.rightbar, viewportWidth: viewport, canShow: true })}
        </RightbarColumn>
      </>
      <div className={css.bottomRow} data-shell-bottom>
        {renderSlot('shell.bottom', {})}
      </div>
      <div className={css.overlayLayer} data-shell-overlay>
        {overlays}
      </div>
    </div>
  )
}
