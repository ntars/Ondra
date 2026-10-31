// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLayoutStore } from '../src/client/stores.ts'
import type { MainPanelId } from '../src/client/service.ts'

beforeEach(() => { vi.stubGlobal('innerWidth', 1920) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('createLayoutStore', () => {
  it('starts with all three columns present and no saved geometry', () => {
    const { store } = createLayoutStore().create()
    expect(store.getSnapshot()).toEqual({
      panelInfo: { activePanelId: null },
      layoutInfo: {
        viewportWidth: 1920,
        rightbarShown: true,
        rightbarTrack: true,
      },
    })
  })

  it('creates independent instances without browser persistence', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem')
    const a = createLayoutStore().create()
    const b = createLayoutStore().create()
    a.actions.closeRightbar()
    expect(b.store.getSnapshot().layoutInfo).toMatchObject({ rightbarTrack: true })
    expect(write).not.toHaveBeenCalled()
  })

})

describe('main panel selection', () => {
  const panelA = 'panel-a' as MainPanelId
  const panelB = 'panel-b' as MainPanelId

  it('changes only panelInfo when switching panels and returning to the Conversation', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openRightbar(true)
    actions.closeRightbar()
    const layoutInfo = store.getSnapshot().layoutInfo
    for (const activePanelId of [panelA, panelB, null]) {
      const previousPanelInfo = store.getSnapshot().panelInfo
      actions.selectPanel(activePanelId)
      expect(store.getSnapshot().panelInfo).toEqual({ activePanelId })
      expect(store.getSnapshot().panelInfo).not.toBe(previousPanelInfo)
      expect(store.getSnapshot().layoutInfo).toBe(layoutInfo)
    }
  })

  it('keeps the complete snapshot when selecting the current panel again', () => {
    const { store, actions } = createLayoutStore().create()
    actions.selectPanel(panelA)
    const selected = store.getSnapshot()
    actions.selectPanel(panelA)
    expect(store.getSnapshot()).toBe(selected)
    expect(store.getSnapshot().panelInfo.activePanelId).toBe(panelA)
  })

  it('returns to the Conversation only when the selected main registration disappears', () => {
    const { store, actions } = createLayoutStore().create()
    const initial = store.getSnapshot()
    actions.retainMainPanels([])
    expect(store.getSnapshot()).toBe(initial)
    actions.selectPanel(panelA)
    const selected = store.getSnapshot()
    actions.retainMainPanels(['conversation', panelA, panelB])
    expect(store.getSnapshot()).toBe(selected)
    actions.retainMainPanels(['conversation', panelB])
    expect(store.getSnapshot().panelInfo).toEqual({ activePanelId: null })
    expect(store.getSnapshot().layoutInfo).toBe(selected.layoutInfo)
  })

  it.each(['setViewportWidth', 'openRightbar', 'closeRightbar'] as const)(
    'preserves panelInfo identity when %s changes layoutInfo', (action) => {
      const { store, actions } = createLayoutStore().create()
      actions.selectPanel(panelA)
      // Start from the other state, so the action has something to change:
      // reporting a column open that is already open changes nothing.
      if (action === 'closeRightbar') actions.openRightbar(true)
      else actions.closeRightbar()
      const previous = store.getSnapshot()
      switch (action) {
        case 'setViewportWidth': actions.setViewportWidth(980); break
        case 'openRightbar': actions.openRightbar(true); break
        case 'closeRightbar': actions.closeRightbar(); break
      }
      expect(store.getSnapshot().panelInfo).toBe(previous.panelInfo)
      expect(store.getSnapshot().layoutInfo).not.toBe(previous.layoutInfo)
    },
  )
})

describe('right panel', () => {
  it('records the reported track and clears it on close', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openRightbar(true)
    expect(store.getSnapshot().layoutInfo).toMatchObject({ rightbarShown: true, rightbarTrack: true })
    actions.openRightbar(false)
    expect(store.getSnapshot().layoutInfo).toMatchObject({ rightbarShown: true, rightbarTrack: false })
    actions.closeRightbar()
    expect(store.getSnapshot().layoutInfo).toMatchObject({ rightbarShown: false, rightbarTrack: false })
  })

  it('carries no width preference across resize, close, and reopen', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openRightbar(true)
    actions.setViewportWidth(800)
    actions.closeRightbar()
    actions.openRightbar(false)
    expect(Object.keys(store.getSnapshot().layoutInfo).sort()).toEqual([
      'rightbarShown', 'rightbarTrack', 'viewportWidth',
    ])
  })
})
