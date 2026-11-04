/** Root-scoped controller for the right Sidebar's Session content. */
import { useLayoutEffect } from 'react'
import type { HostObservable, InjectFace, PropsRenderSlots, PropsRuntime } from '@ntars/ondra-client-ui-slots'
import type { SessionReference } from '@ntars/ondra-api-session-controller/client'
import type { SidebarSessionViewSnapshot } from '../session-views.ts'
import type {} from '../contract/slots.ts'
import css from './SidebarRight.module.css'

/** Root-only retained Session targets and their committed mount lifetimes. */
export interface RightbarRootInjected {
  readonly hooks: { readonly views: HostObservable<readonly SidebarSessionViewSnapshot[]> }
  readonly mountView: (reference: SessionReference) => () => void
  /**
   * Report the column's presentation to the frame.
   *
   * The seat reports while a Session is on screen; this root reports the empty
   * column, so the frame keeps the right track — and with it the divider —
   * during the moments when no Session is selected yet.
   */
  readonly syncPresentation: (presentation: { readonly shown: boolean; readonly track: boolean }) => void
}

type RootProps = PropsRuntime<'rightbar'> & PropsRenderSlots<'rightbar.session'> & InjectFace<RightbarRootInjected>

function SessionView({ view, visible, SessionProvider, renderSlot, mountView, width, viewportWidth, canShow }:
  Pick<RootProps, 'SessionProvider' | 'renderSlot' | 'mountView' | 'width' | 'viewportWidth' | 'canShow'>
  & { readonly view: SidebarSessionViewSnapshot; readonly visible: boolean }) {
  useLayoutEffect(() => mountView(view.reference), [mountView, view.reference])
  const active = visible && view.selected
  return <div className={css.session} hidden={!active} data-sidebar-right-session={view.sessionId}>
    <SessionProvider session={view.reference}>
      {renderSlot('rightbar.session', { width, viewportWidth, canShow, active, retainTab: view.retainTab })}
    </SessionProvider>
  </div>
}

/**
 * Keep independent Session subtrees and hide those outside the selected Conversation.
 *
 * Ondra's third column is permanent, so the column renders even without a
 * Session: `fallback` draws the panel's own empty surface for a frame that has
 * no Conversation yet, keeping the column where the user expects it instead of
 * letting the whole track collapse into blank frame.
 * @param props - frame geometry, view targets and the authorized Session renderer.
 * @returns the foreground and retained background Sidebars, or the empty column.
 */
export function RightbarRoot({ useViews, syncPresentation, ...props }: RootProps) {
  // Ondra's third column is permanent in a stronger sense than the expanded
  // flag: it must also survive a main-panel switch. Gating on
  // `activePanelId === null` meant a settings page, the plugin manager or a
  // cold-start welcome panel silently took the column away, which reads as the
  // sidebar collapsing on its own. The column now follows the selected Session
  // only, never the panel in the centre.
  const visible = true
  const views = useViews(value => value)
  // With no Session there is no seat to report the column, so the frame closed
  // the track and the window read as two columns with no divider between the
  // centre and where the panel belongs. The empty column asks for the same
  // track the seat asks for, and gives it back when a Session takes over.
  const empty = views.length === 0
  useLayoutEffect(() => {
    if (!empty) return
    syncPresentation({ shown: true, track: true })
    return () => { syncPresentation({ shown: false, track: false }) }
  }, [empty, syncPresentation])
  if (empty) return <RightbarEmpty />
  return <>{views.map(view => <SessionView key={view.sessionId} {...props} view={view} visible={visible} />)}</>
}

/**
 * The column's own empty surface: the same box, track and chrome as a Session
 * panel, with the guide's placeholder in place of a page. It mounts no Session
 * provider, so it needs nothing from the Host and cannot fail on a cold start.
 * @returns the empty third column.
 */
function RightbarEmpty() {
  return (
    <div className={css.session} data-sidebar-right-session="empty">
      <div className={css.panel} data-sidebar-right-panel data-sidebar-right-open>
        <div className={css.panelBody}>
          {/* A card, not a sentence in the corner. The column is permanent, so
              what fills it when there is nothing to show has to read as a
              deliberate empty state: a centred card that names what will appear
              here and what to do first. Left-aligned grey text read as a
              rendering failure rather than an invitation. */}
          <div className={css.emptyCard} data-sidebar-right-empty>
            <div className={css.emptyMark} aria-hidden="true">◫</div>
            <p className={css.emptyTitle}>还没有打开的会话</p>
            <p className={css.emptyBody}>建好工作目录、开一个会话后，这里会跟着显示她的页面。</p>
          </div>
        </div>
      </div>
    </div>
  )
}
