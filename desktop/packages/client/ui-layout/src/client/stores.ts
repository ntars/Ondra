/**
 * Root-owned frame measurement, panel visibility, and presentation reports.
 * The registration supplies a fresh store and binds its actions to ctx.layout.
 *
 * Ondra's frame is a fixed quarter split (see columns.ts): the store records
 * only which side columns are open — never a width — so window resizes and
 * restarts land on the same proportions. The state is created fresh with every
 * window, which is what makes each launch start from the default layout.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { MainPanelId } from './service.ts'

/**
 * Transient layout state. The side columns carry a single boolean each;
 * nothing here survives the window.
 */
type LayoutState = {
  panelInfo: {
    /** Null selects the Conversation; global panels keep the current Session intact. */
    activePanelId: MainPanelId | null
  }
  layoutInfo: LayoutInfo
}

type LayoutInfo = {
  /** Last positive frame measurement; window width bootstraps the first render. */
  viewportWidth: number
  /**
   * Whether the right panel is drawn at all, in either presentation.
   *
   * Derived chrome, not a source of truth: whether the right surface is
   * expanded is a recorded fact owned by that surface, reported here so the
   * frame can size its fixed quarter. The occupant reports it; nothing else
   * writes it.
   */
  rightbarShown: boolean
  /**
   * Whether the right panel reserves its quarter. Reported by the occupant;
   * always false while hidden.
   */
  rightbarTrack: boolean
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type LayoutActions = {
  selectPanel: (draft: LayoutState, panelId: MainPanelId | null) => void
  retainMainPanels: (draft: LayoutState, panelIds: readonly string[]) => void
  setViewportWidth: (draft: LayoutState, width: number) => void
  openRightbar: (draft: LayoutState, track: boolean) => void
  closeRightbar: (draft: LayoutState) => void
}

/**
 * Create the layout panel store handle.
 *
 * The frame's columns are fixed (columns.ts): this store keeps the measurement
 * and the right panel's reported presentation, never a width or a collapse flag.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createLayoutStore(): EngineStoreHandle<LayoutState, LayoutActions> {
  const handle = defineStore({
    init: (): LayoutState => ({
      panelInfo: { activePanelId: null },
      layoutInfo: {
        viewportWidth: window.innerWidth,
        // The default frame is three columns: the right quarter is reserved from
        // the first paint, before the occupant has reported its own state. The
        // occupant's report replaces this guess on mount.
        rightbarShown: true,
        rightbarTrack: true,
      },
    }),
    actions: {
      selectPanel: (d, panelId: MainPanelId | null) => {
        d.panelInfo.activePanelId = panelId
      },
      retainMainPanels: (d, panelIds: readonly string[]) => {
        if (d.panelInfo.activePanelId !== null && !panelIds.includes(d.panelInfo.activePanelId)) {
          d.panelInfo.activePanelId = null
        }
      },
      setViewportWidth: (d, width: number) => {
        if (d.layoutInfo.viewportWidth === width) return
        d.layoutInfo.viewportWidth = width
      },
      openRightbar: (d, track: boolean) => {
        d.layoutInfo.rightbarShown = true
        d.layoutInfo.rightbarTrack = track
      },
      closeRightbar: (d) => {
        d.layoutInfo.rightbarShown = false
        d.layoutInfo.rightbarTrack = false
      },
    },
  })
  return handle
}
