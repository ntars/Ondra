/**
 * The Sidebar's seat in the frame, and the panel it draws.
 *
 * The frame owns the right column's geometry; this package owns one content
 * tree at that column's width. The column is permanent: it has no collapsed
 * state, no second presentation and no way back in, because it never leaves.
 *
 * The panel has no header of its own. Its one remaining control — split — rides
 * the docking kit's chrome seat at the end of the top-right pane's tab strip, so
 * the strip is the panel's whole top edge. Floating panels remain in the same
 * content tree; untransformed ancestors let their fixed-position frames cross
 * the column and conversation.
 *
 * Tab bodies do not live here. Each one is a registration under its type's kind,
 * dispatched through the keyed `sidebar.right.pane.tab` seat (and a live chip
 * title through `sidebar.right.pane.tab.title`), so a new tab type needs no edit
 * to this file. What a body receives beyond the record — navigation, lifetime
 * signal, actions — is read through the slot-owned useTabInfo hook. The Tab
 * domain follows each session's store commits, including sessions off screen.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../contract/slots.ts'
import type { DockIntents, FloatRect, TabId, TabRecord, TabRenderer } from '@deepseek-ai/dsh-client-ui-dockkit'
import { canSplit, dockPaneIds, DockLayout, findPaneContentTab } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { HalvesFit, LayoutState, PaneId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { GUIDE_KIND, pageAddress } from '../contract/seed.ts'
import { dockLabels } from '../labels.ts'
import type { SidebarRightOpenTabOptions } from '../service.ts'
import type { SidebarRightTabDefinition } from '../tab-registry.ts'
import type { createSidebarRightStore, SurfaceState } from '../stores.ts'
import { canCloseTab } from '../stores.ts'
import type { TabOccurrence } from '../tab-domain.ts'
import type { SidebarRightTabNavigation } from '../contract/slots.ts'
import type { TabHookContext } from '../tab-info.ts'
import css from './SidebarRight.module.css'

/** The store share the seat receives. */
type Store = PropsStore<ReturnType<typeof createSidebarRightStore>>

/** The child seats this component renders. */
type Children = PropsRenderSlots<'sidebar.right.pane.tab' | 'sidebar.right.pane.tab.title' | 'sidebar.right.tab.menu.item'>

/** What the panel reports to the frame: drawn or not, and whether it wants a track. */
export interface SidebarRightPresentation {
  /** Whether the panel is drawn at all. */
  readonly shown: boolean
  /** Whether the drawn panel wants the conversation to make room for it. */
  readonly track: boolean
}

/** What this package needs from its host beyond the framework shares. */
export interface SidebarRightInjected {
  /**
   * Report the panel's presentation to the frame.
   *
   * The frame sizes the track and places the resize handle; this only tells it
   * the composition of the facts this package owns, and is called whenever that
   * composition changes.
   */
  readonly syncPresentation: (presentation: SidebarRightPresentation) => void
  /**
   * Record this seat's room rule for `ctx.sidebarRight`'s splits, replacing its previous one.
   *
   * The docking kit measures its panes after it renders; the seat forwards each
   * reading, and the service applies it when it splits this seat's Session.
   * @param canSplitPane - whether two working halves of a docked pane would fit; unmeasured panes fit.
   */
  readonly measureRoom: (canSplitPane: (paneId: PaneId) => boolean) => void
  /**
   * The navigation face's `openTab`, for the strip's add control: a new tab is
   * the guide opened by kind, through the same path as every other open.
   */
  readonly openTab: (kind: string, options?: SidebarRightOpenTabOptions) => void
  /** Close through the resource owner's cleanup handler. */
  readonly closeTab: (tabId: TabId) => void
  /** Split through the same controller as keyboard commands. */
  readonly splitPane: (paneId: PaneId) => void
  readonly hooks: {
    readonly shortcuts: HostObservable<readonly ShortcutCatalogEntry[]>
    readonly tabTypes: HostObservable<readonly SidebarRightTabDefinition[]>
  }
  readonly keyedHooks: {
    readonly tabNavigation: (key: string) => HostObservable<SidebarRightTabNavigation>
  }
  /** Read a committed record's lifetime; never creates an occurrence. */
  readonly occurrence: (tab: Pick<TabRecord, 'id'>) => TabOccurrence
}

/** The column seat's props: session scope, so the session arrives as a standard prop. */
export type RightbarSeatProps =
  & PropsRuntime<'rightbar.session'>
  & Children
  & Store
  & PropsLocale<'sidebarRight'>
  & InjectFace<SidebarRightInjected>

/** Everything the panel needs, already bound to one session. */
interface PanelProps {
  readonly sessionId: SessionId
  readonly surface: SurfaceState
  readonly actions: Store['actions']
  readonly t: RightbarSeatProps['t']
  readonly renderSlot: Children['renderSlot']
  readonly openTab: SidebarRightInjected['openTab']
  readonly closeTab: SidebarRightInjected['closeTab']
  readonly splitPane: SidebarRightInjected['splitPane']
  readonly shortcuts: readonly ShortcutCatalogEntry[]
  readonly useTabTypes: RightbarSeatProps['useTabTypes']
  readonly useTabNavigation: RightbarSeatProps['useTabNavigation']
  readonly useStore: Store['useStore']
  readonly occurrence: SidebarRightInjected['occurrence']
  readonly active: boolean
  readonly retainTab: RightbarSeatProps['retainTab']
  /** Receives the kit's room-rule readings for the service's `split`. */
  readonly reportRoom: (fits: ReadonlyMap<PaneId, HalvesFit>) => void
}

/** The guide tab one pane holds, if any: a pane holds at most one. */
function guideIn(layout: LayoutState, paneId: PaneId): TabId | undefined {
  return findPaneContentTab(layout, paneId, pageAddress(GUIDE_KIND), GUIDE_KIND)
}

/**
 * Build the kit's intent face for one session out of the store's actions.
 * @param sessionId - the session the seat draws; every action is bound to it.
 * @param actions - the seat's bound store actions.
 * @param openTab - the navigation face's `openTab`, which the strip's add control asks for a guide through.
 * @returns the intents the kit reports gestures to.
 */
export function intentsFor(sessionId: SessionId, actions: Store['actions'], openTab: PanelProps['openTab'], closeTab?: PanelProps['closeTab'], splitPane?: PanelProps['splitPane']): DockIntents {
  return {
    focusTab: (tabId) => { actions.focusTab(sessionId, tabId) },
    focusPane: (paneId) => { actions.focusPane(sessionId, paneId) },
    splitPane: splitPane ?? ((paneId) => { actions.splitPane(sessionId, paneId) }),
    // The guide is unique per pane: the control is drawn only while its pane
    // holds none (`canAddTab` below) and asks for one there without regard to
    // guides in other panes; the store settles the open on a guide the pane
    // already holds, so the ask is idempotent all the same.
    addTab: (paneId) => { openTab(GUIDE_KIND, { paneId, revealIfOpened: false }) },
    closeTab: closeTab ?? ((tabId) => { actions.closeTab(sessionId, tabId) }),
    duplicateTab: (tabId) => { actions.duplicateTab(sessionId, tabId) },
    floatTab: (tabId, rect?: FloatRect) => { actions.floatTab(sessionId, tabId, rect) },
    unfloatPane: (paneId) => { actions.unfloatPane(sessionId, paneId) },
    placeTab: (tabId, toPaneId, index) => { actions.placeTab(sessionId, tabId, toPaneId, index) },
    dropTab: (tabId, paneId, zone) => { actions.dropTab(sessionId, tabId, paneId, zone) },
    moveFloat: (paneId, x, y) => { actions.moveFloat(sessionId, paneId, x, y) },
    resizeFloat: (paneId, rect) => { actions.resizeFloat(sessionId, paneId, rect) },
    resizeSplit: (splitId, sizes) => { actions.resizeSplit(sessionId, splitId, sizes) },
  }
}

/** One tab's slot dispatch: which seat, and what to render when no type registered. */
interface TabSlotProps extends Pick<PanelProps, 'renderSlot' | 'occurrence' | 'useTabTypes' | 'useTabNavigation' | 'useStore' | 'active' | 'retainTab' | 'shortcuts'> {
  readonly tab: TabRecord
  readonly seat: 'sidebar.right.pane.tab' | 'sidebar.right.pane.tab.title'
  readonly fallback: ReactNode
}

/**
 * Dispatch one tab's body or title with stable framework hooks and record lifetime.
 */
function TabSlot({
  renderSlot, occurrence, useTabTypes, useTabNavigation, useStore, shortcuts, active, retainTab, tab, seat, fallback,
}: TabSlotProps): ReactNode {
  const { id, signal, tabActions } = occurrence(tab)
  const definition = useTabTypes(types => types.find(definition => definition.kind === tab.kind))
  const retained = seat === 'sidebar.right.pane.tab' && definition?.keepMounted === true
  useLayoutEffect(() => retained ? retainTab(tab.id, signal) : undefined, [retained, retainTab, tab.id, signal])
  const hookContext = useMemo((): TabHookContext => ({
    tabId: tab.id,
    shortcuts,
    title: seat === 'sidebar.right.pane.tab.title',
    active,
    signal,
    actions: tabActions,
    useStore,
    useTabNavigation,
  }), [tab.id, seat, active, signal, tabActions, useStore, useTabNavigation, shortcuts])
  const content = renderSlot(seat, {}, { entryKey: definition?.id ?? tab.kind, fallback, hookContext })
  return seat === 'sidebar.right.pane.tab.title'
    ? <span key={id} className={css.tabTitle} data-sidebar-right-tab={tab.id} data-sidebar-right-occurrence={id}>{content}</span>
    : <div key={id} className={css.tabBody} data-sidebar-right-tab={tab.id} data-sidebar-right-occurrence={id}>{content}</div>
}

/**
 * Dispatch a tab's body to its registered type.
 *
 * A kind with no registrant is a real state, not a defect: a session log can
 * carry a tab whose type shipped in a plugin that is no longer mounted. Saying so
 * is better than an empty pane.
 */
function bodiesFor(panel: PanelProps): TabRenderer {
  const { t, ...rest } = panel
  // Slot dispatch selects a type; the record key separates bodies of that type.
  return tab => (
    <TabSlot
      key={tab.id}
      {...rest}
      tab={tab}
      seat="sidebar.right.pane.tab"
      fallback={<p className={css.unavailable} data-sidebar-right-unavailable>{t('tab.unavailable')}</p>}
    />
  )
}

/** Dispatch a tab's title to its registered type; without one the chip shows the title captured at open time. */
function titlesFor(panel: PanelProps): TabRenderer {
  return tab => <TabSlot key={tab.id} {...panel} tab={tab} seat="sidebar.right.pane.tab.title" fallback={tab.title} />
}

/**
 * The panel: the docked surface, occupying the frame's permanent right column.
 *
 * There is no opening or closing to animate — the column never leaves — so the
 * panel renders at its final position from the first commit.
 */
function SidebarPanel(panel: PanelProps & { width: number }): ReactNode {
  const { sessionId, surface, actions, t, renderSlot, openTab, width, reportRoom } = panel
  const types = panel.useTabTypes(value => value)
  return (
    <div
      className={css.panel}
      style={{ width, '--dsh-sidebar-width': `${width}px` } as CSSProperties}
      data-sidebar-right-session={sessionId}
      data-sidebar-right-panel
      // Always on: the column never collapses, so no layout and no width rule
      // can take it off screen. The same bare-attribute convention the empty
      // column uses, so both states of the seat are styled by one selector.
      data-sidebar-right-open
    >
      <div className={css.panelBody}>
        <DockLayout
          state={surface.layout}
          canSplit={canSplit(surface.layout) && dockPaneIds(surface.layout).length < 2}
          dropZones="horizontal"
          minPaneFraction={0.2}
          canAddTab={paneId => guideIn(surface.layout, paneId) === undefined}
          canCloseTab={tabId => canCloseTab(surface, tabId)}
          intents={intentsFor(sessionId, actions, openTab, panel.closeTab, panel.splitPane)}
          labels={dockLabels(t, panel.shortcuts.find(entry => entry.id === 'pane.split'), panel.shortcuts.find(entry => entry.id === 'page.close'))}
          renderTab={bodiesFor(panel)}
          renderTabTitle={titlesFor(panel)}
          active={panel.active}
          keepMounted={tab => types.find(type => type.kind === tab.kind)?.keepMounted === true}
          renderTabMenuItems={(tab, dismiss) =>
            renderSlot('sidebar.right.tab.menu.item', { tab, dismiss })}
          onRoom={reportRoom}
        />
      </div>
    </div>
  )
}

/**
 * The right column's occupant: stable tab containers, docked or floating.
 * It is also where the frame learns whether the column is drawn and whether it
 * wants a track, because this is the seat that knows both.
 */
export function RightbarSeat({
  sessionId, width, useStore, actions, t, renderSlot, syncPresentation, measureRoom,
  openTab, closeTab, useTabTypes, useTabNavigation, occurrence, retainTab, active, useShortcuts, splitPane,
}: RightbarSeatProps): ReactNode {
  // One store instance per session, so this map holds this session's surface.
  const shortcuts = useShortcuts(entries => entries)
  const surface = useStore(state => state.bySession[sessionId])
  const shown = active && surface !== undefined
  // A reading never re-renders anything: the service applies it when it splits.
  const reportRoom = useCallback((fits: ReadonlyMap<PaneId, HalvesFit>): void => {
    measureRoom(paneId => fits.get(paneId)?.row !== false)
  }, [measureRoom])
  const track = shown

  useEffect(() => {
    if (active && surface === undefined) actions.open(sessionId)
  }, [actions, sessionId, surface, active])

  useLayoutEffect(() => {
    if (active) syncPresentation({ shown, track })
  }, [sessionId, shown, track, syncPresentation, active])
  // Leaving is part of that report: a seat that unmounts with its session must
  // hand the track back rather than leave one sized for a surface nobody draws.
  useLayoutEffect(() => active
    ? () => { syncPresentation({ shown: false, track: false }) }
    : undefined, [syncPresentation, active])

  // The Tab domain is not synced here: the controller adopted this session's
  // store as the runtime minted it and reconciles on the store's own commits,
  // on screen or not.

  if (surface === undefined) return null
  const panel: PanelProps = {
    sessionId, actions, t, renderSlot, surface, openTab, closeTab, useTabTypes, useTabNavigation, useStore, occurrence,
    reportRoom, active, retainTab, shortcuts, splitPane,
  }
  return <SidebarPanel {...panel} width={width} />
}
