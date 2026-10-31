// @vitest-environment jsdom
/** Sidebar presentation and tab subscriptions through the production slot renderer. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent } from '@testing-library/react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { SlotTestRuntime, type SlotView } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ShortcutCatalogEntry, ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { PaneId, SplitId, TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { dockPaneIds, getPane } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'
import { intentsFor } from '../src/client/shell/SidebarRight.tsx'
import type { SidebarRightTabInfo, SidebarRightTabMenuOwnerProps } from '../src/client/contract/slots.ts'
import type { createSidebarRightStore } from '../src/client/stores.ts'

declare module '../src/client/contract/params.ts' {
  interface SidebarRightResourceParamsMap {
    test: { line?: number; x?: number }
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** A Conversation-column stand-in rendered before the seat, opening a resource as soon as a seat is mounted. */
    'sidebar-right.test.opener': { kind: 'single'; scope: 'session'; owner: { armed: boolean } }
  }
}

const SESSION = 's-test' as SessionId
const OTHER = 's-other' as SessionId
const runtimes: SlotTestRuntime[] = []
let getAnimationsDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  getAnimationsDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations')
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, writable: true, value: () => [] })
})

afterEach(async () => {
  try {
    for (const runtime of runtimes.splice(0)) await runtime.dispose()
  } finally {
    vi.restoreAllMocks()
    if (getAnimationsDescriptor === undefined) Reflect.deleteProperty(Element.prototype, 'getAnimations')
    else Object.defineProperty(Element.prototype, 'getAnimations', getAnimationsDescriptor)
  }
})

async function mountSeat(viewportWidth = 1440, canShow = true, entryCount = 0, opener = false, keepMounted = false) {
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  const frame = { openRightbar: vi.fn(), closeRightbar: vi.fn(), panelInfo: runtime.panelInfo }
  const pin = vi.fn<(address: string, signal: AbortSignal) => void>()
  runtime.ctx.provide('layout', frame as never)
  runtime.ctx.provide('resources', { pin } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  const catalog = createSnapshotStore<readonly ShortcutCatalogEntry[]>([])
  runtime.ctx.provide('shortcuts', { register: () => () => {}, catalog } as never)
  runtime.slots.installLocale(locale)
  await runtime.declare({
    'sidebar-right.test.opener': { kind: 'single', scope: 'session' },
    'rightbar': { kind: 'single', scope: 'root' },
    'conversation.session.header.corner': { kind: 'single', scope: 'session' },
  })
  await runtime.sessions.add({ id: SESSION })
  let reference = runtime.sessions.retainFor(runtime.ctx, SESSION, { source: 'mainView' })
  const feature = await runtime.mount({ inject: [...inject], apply })
  // The frame mounts the Conversation column before the right column, so a
  // Conversation component's mount effect runs before the seat's. The opener
  // stands in for one that opens a resource as soon as a seat is mounted — it
  // reads `mounted` the way a slot component reads its bound hook — and shows
  // only while the Conversation is selected, as the main panel does.
  const opened: string[] = []
  function OpenerMount() {
    const { mounted } = runtime.ctx.sidebarRight
    const seat = useSyncExternalStore(listener => mounted.subscribe(listener), () => mounted.getSnapshot())
    useEffect(() => {
      if (seat === undefined) return
      const address = `dsh-resource://file/session/s-test/arrival-${opened.length + 1}.txt`
      runtime.ctx.sidebarRight.openResource(address)
      opened.push(address)
    }, [seat])
    return null
  }
  function Opener({ usePanelInfo, armed }: PropsRuntime<'sidebar-right.test.opener'>) {
    const visible = usePanelInfo(info => info.activePanelId === null)
    return armed && visible ? <OpenerMount /> : null
  }
  let arm = (_armed: boolean): void => { throw new Error('mountSeat(opener = true) renders the opener') }
  let openerView: SlotView<'sidebar-right.test.opener'> | undefined
  if (opener) {
    await act(async () => { runtime.slots.register({ name: 'sidebar-right.test.opener' }, Opener) })
    const view = runtime.renderSlot('sidebar-right.test.opener', { armed: false }, { session: reference })
    openerView = view
    arm = (armed) => { view.update({ armed }) }
  }
  const bodies = new Map<string, SidebarRightTabInfo>()
  const titles = new Map<string, SidebarRightTabInfo>()
  const hooks = new Map<string, PropsRuntime<'sidebar.right.pane.tab'>['useTabInfo']>()
  let mounts = 0
  function Body(props: PropsRuntime<'sidebar.right.pane.tab'>) {
    const info = props.useTabInfo()
    const [instance] = useState(() => ++mounts)
    bodies.set(info.tab.id, info)
    hooks.set(info.tab.id, props.useTabInfo)
    expect(['tabInfo', 'tab', 'paneId', 'visible', 'navigation', 'signal', 'tabActions'].filter(key => key in props)).toEqual([])
    return <span data-tab-body={info.tab.id} data-instance={instance} data-revision={info.tab.navigation.revision} />
  }
  function Title({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>) {
    const info = useTabInfo()
    titles.set(info.tab.id, info)
    return <span data-tab-title={info.tab.id}>{info.tab.title}</span>
  }
  await act(async () => {
    runtime.ctx.sidebarRightTabs.register({
      id: 'test/text', kind: 'text', priority: 'builtin', patterns: ['dsh-resource://file/**'],
      title: address => address.slice(address.lastIndexOf('/') + 1),
      keepMounted,
      guide: Array.from({ length: entryCount }, (_, order) => ({ id: String(order), order, title: () => 'Test', description: () => 'Test page' })),
    })
    runtime.slots.register({ name: 'sidebar.right.pane.tab', key: 'test/text' }, Body)
    runtime.slots.register({ name: 'sidebar.right.pane.tab.title', key: 'test/text' }, Title)
  })
  const view = runtime.renderSlot('rightbar', { width: 420, viewportWidth, canShow })
  const registerPage = (kind: string, multiple = false): void => {
    runtime.ctx.sidebarRightTabs.register({ id: `test/${kind}`, kind, multiple, title: () => kind })
    runtime.slots.register({ name: 'sidebar.right.pane.tab', key: `test/${kind}` }, Body)
  }
  const instance = runtime.storeOf('rightbar.session', reference) as ReturnType<ReturnType<typeof createSidebarRightStore>['create']>
  const controller = runtime.ctx.sidebarRight
  const layout = () => instance.getSnapshot().bySession[SESSION]!.layout
  const open = (name = 'a.txt', options?: Parameters<typeof controller.openResource>[1]) => {
    act(() => { controller.openResource(`dsh-resource://file/session/s-test/${name}`, options) })
    return controller.active()!
  }
  const selectSession = (id: SessionId): void => {
    const next = runtime.sessions.retainFor(runtime.ctx, id, { source: 'mainView' })
    reference.release()
    reference = next
  }
  return {
    runtime, feature, controller, instance, actions: instance.actions, layout,
    open, selectSession, frame, pin, bodies, titles, hooks, view, arm, opened, registerPage, catalog,
    openerView: () => openerView!,
  }
}

it('keeps duplicate Session Tabs independent and preserves a body through docking and float focus', async () => {
  const h = await mountSeat()
  await act(async () => {
    h.runtime.ctx.sidebarRightTabs.register({ id: 'test/shared', kind: 'shared', keepMounted: true, title: () => 'Shared' })
    h.runtime.slots.register({ name: 'sidebar.right.pane.tab', key: 'test/shared' }, () => <input data-page-input />)
  })
  act(() => { h.controller.openTab('shared') })
  const tab = h.controller.active()!
  const body = document.querySelector<HTMLInputElement>('[data-page-input]')!
  const cell = body.closest('[data-dockkit-host]')
  const close = vi.fn()
  h.runtime.ctx.effect(() => h.controller.registerCloseHandler('shared', close))
  act(() => { h.controller.openTab('shared', { replaceTab: tab.id, revealIfOpened: false }) })
  expect(close).not.toHaveBeenCalled()
  let otherPane: PaneId | undefined
  act(() => { otherPane = h.controller.split() })
  fireEvent.click(body)
  expect(h.controller.active()?.id).toBe(tab.id)
  expect(otherPane).toBeDefined()
  act(() => { h.controller.openTab('shared', { paneId: otherPane!, revealIfOpened: false, preferNewPane: true }) })
  expect(h.controller.tabsIn(SESSION).filter(tab => tab.kind === 'shared')).toHaveLength(2)
  const duplicate = h.controller.active()!
  expect(duplicate.id).not.toBe(tab.id)
  expect(document.querySelectorAll('[data-page-input]')).toHaveLength(2)
  act(() => { h.controller.close(duplicate.id) })
  act(() => { h.controller.float(tab.id) })
  expect(document.querySelector('[data-page-input]')).toBe(body)
  expect(body.closest('[data-dockkit-host]')).toBe(cell)
  const floating = h.controller.focusedTarget(body)!
  expect(floating.host).toBe('float')
  // A floating page is never taken off screen: the column cannot be hidden, so
  // focus stays with the page and docking it back keeps the same element.
  expect(h.layout().expanded).toBe(true)
  expect(body.closest('[hidden]')).toBeNull()
  expect(body.closest('[aria-hidden="true"]')).toBeNull()
  act(() => { body.focus() })
  expect(h.controller.focusedTarget()?.tabId).toBe(tab.id)
  act(() => { h.controller.dock(floating.paneId) })
  expect(document.querySelector('[data-page-input]')).toBe(body)
  expect(body.closest('[data-dockkit-host]')).toBe(cell)
  expect(h.layout().expanded).toBe(true)
})

it('retains a background Session Tab and remounts an unretained hidden body', async () => {
  const h = await mountSeat()
  let latest: SidebarRightTabInfo | undefined
  function Body(props: PropsRuntime<'sidebar.right.pane.tab'>) {
    latest = props.useTabInfo()
    return <input data-retention-parity />
  }
  await act(async () => {
    h.runtime.ctx.sidebarRightTabs.register({ id: 'test/retention', kind: 'retention', title: () => 'Retention' })
    h.runtime.slots.register({ name: 'sidebar.right.pane.tab', key: 'test/retention' }, Body)
  })
  act(() => { h.controller.openTab('retention') })
  const tab = h.controller.active()!
  const body = document.querySelector('[data-retention-parity]')!
  const signal = latest!.tab.signal
  expect(latest!.tab.visible).toBe(true)
  // The column never leaves the screen, so a tab goes out of sight only when
  // another tab takes its pane — and even then its record and lifetime stay.
  act(() => { h.controller.openTab('guide') })
  expect(body.isConnected).toBe(false)
  expect(signal.aborted).toBe(false)
  expect(h.layout().expanded).toBe(true)
  expect(h.layout().tabs[tab.id]).toBeDefined()
  act(() => { h.controller.focus(tab.id) })
  expect(document.querySelector('[data-retention-parity]')).not.toBe(body)
  expect(latest!.tab.signal).toBe(signal)
})

it('rebinds a restored Session Tab lifetime even when close and undo share one render', async () => {
  const h = await mountSeat()
  let lifetime: AbortSignal | undefined
  function Body(props: PropsRuntime<'sidebar.right.pane.tab'>) {
    lifetime = props.useTabInfo().tab.signal
    const [count, setCount] = useState(0)
    return <button data-restored-tab onClick={() => { setCount(value => value + 1) }}>{count}</button>
  }
  await act(async () => {
    h.runtime.ctx.sidebarRightTabs.register({ id: 'test/restored', kind: 'restored', keepMounted: true, title: () => 'Restored' })
    h.runtime.slots.register({ name: 'sidebar.right.pane.tab', key: 'test/restored' }, Body)
  })
  act(() => { h.controller.openTab('restored') })
  const tab = h.controller.active()!
  const original = document.querySelector('[data-restored-tab]')!
  const before = lifetime!
  fireEvent.click(original)
  act(() => { h.controller.close(tab.id); h.controller._undo() })
  expect(h.controller.active()?.id).toBe(tab.id)
  expect(before.aborted).toBe(true)
  expect(lifetime).not.toBe(before)
  expect(document.querySelector('[data-restored-tab]')).not.toBe(original)
  expect(original.isConnected).toBe(false)
  expect(document.querySelector('[data-restored-tab]')?.textContent).toBe('0')
})

function element(container: HTMLElement, selector: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(selector)
  if (node === null) throw new Error(`expected ${selector}`)
  return node
}

describe('RightbarSeat presentation', () => {
  it('keeps a background retained body through standard-source registration and removal', async () => {
    const h = await mountSeat(1440, true, 0, false, true)
    const tab = h.open('retained.txt')
    const body = element(h.view.container, `[data-tab-body="${tab.id}"]`)
    await act(async () => { await h.runtime.sessions.add({ id: OTHER }) })
    act(() => { h.selectSession(OTHER) })
    expect(body.isConnected).toBe(true)
    let withdraw = () => {}
    act(() => {
      withdraw = h.runtime.ctx.uiSession.provide({
        props: ['sidebarRetentionProbe'],
        resolve: () => ({ props: { sidebarRetentionProbe: true } }),
      })
    })
    expect(element(h.view.container, `[data-tab-body="${tab.id}"]`)).toBe(body)
    act(withdraw)
    expect(element(h.view.container, `[data-tab-body="${tab.id}"]`)).toBe(body)
    act(() => { h.selectSession(SESSION) })
    expect(element(h.view.container, `[data-tab-body="${tab.id}"]`)).toBe(body)
    expect(h.bodies.get(tab.id)?.tab.signal.aborted).toBe(false)
  })

  it('releases the departing editable selection while retaining its draft', async () => {
    const h = await mountSeat()
    act(() => { h.registerPage('files') })
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    editor.tabIndex = 0
    editor.textContent = 'unsent draft'
    // jsdom does not implement the browser's inherited contenteditable flag.
    Object.defineProperty(editor, 'isContentEditable', { value: true })
    h.view.container.append(editor)
    editor.focus()
    const selection = document.getSelection()!
    selection.selectAllChildren(editor)
    selection.collapseToEnd()
    act(() => { h.controller.openTabFromTarget('files', h.controller.commandTarget()!) })
    expect(document.activeElement?.hasAttribute('data-dockkit-pane')).toBe(true)
    expect(editor.contains(selection.anchorNode)).toBe(false)
    expect(editor.textContent).toBe('unsent draft')
  })

  it('focuses the new pane after splitting replaces the focused pane DOM', async () => {
    const h = await mountSeat()
    h.open()
    element(h.view.container, '[data-dockkit-tab]').focus()
    let created: PaneId | undefined
    act(() => { created = h.controller.split() })
    expect(document.activeElement?.getAttribute('data-dockkit-pane')).toBe(created)
  })

  it('retains the focused page when its body moves between docked and floating panes', async () => {
    const h = await mountSeat()
    const tab = h.open()
    const input = document.createElement('input')
    document.querySelector<HTMLElement>('[data-tab-body]')!.append(input)
    input.focus()
    await act(async () => { h.controller.float(tab.id) })
    expect(document.activeElement).toBe(input)
    const paneId = input.closest<HTMLElement>('[data-dockkit-float]')?.dataset.dockkitFloat as PaneId | undefined
    expect(paneId).toBeDefined()
    await act(async () => { h.controller.dock(paneId!) })
    expect(document.activeElement).toBe(input)
    expect(input.closest<HTMLElement>('[data-dockkit-pane]')?.dataset.dockkitPane).toBe(h.layout().activePaneId)
  })

  it('keeps its column across a global main panel and retains the Session state', async () => {
    const h = await mountSeat()
    h.open('retained.txt')
    const retained = h.layout()
    act(() => { h.runtime.panelInfo.set({ activePanelId: 'other-panel' as MainPanelId }) })
    // The column stays where the user put it — a settings page or the plugin
    // manager in the middle is not a reason to take it away. The seat only
    // stops asking the frame for a track, because no Conversation is beside it.
    expect(element(h.view.container, '[data-sidebar-right-session]').hidden).toBe(false)
    expect(h.frame.closeRightbar).toHaveBeenCalled()
    expect(h.layout()).toBe(retained)
    act(() => { h.runtime.panelInfo.set({ activePanelId: null }) })
    expect(h.view.container.querySelector('[data-sidebar-right-panel]')).not.toBeNull()
    expect(h.layout()).toBe(retained)
  })

  it('names the on-screen Session before a Conversation opener acts in the commit that returns from a global panel', async () => {
    const h = await mountSeat(1440, true, 0, true)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(h.controller.mounted.getSnapshot()).toBe(SESSION)
    // Armed while the Session is already on screen: the ordinary case.
    act(() => { h.arm(true) })
    expect(h.opened).toHaveLength(1)
    // The seat seeds the default page on its first commit, so the opened
    // resource sits beside it rather than being the column's only tab.
    expect(Object.values(h.layout().tabs).map(tab => tab.contentId)).toContain(h.opened[0])
    // A global panel takes the Conversation's place; the column keeps its page.
    act(() => { h.runtime.panelInfo.set({ activePanelId: 'other-panel' as MainPanelId }) })
    expect(Object.values(h.layout().tabs).map(tab => tab.contentId)).toContain(h.opened[0])
    expect(h.controller.mounted.getSnapshot()).toBeUndefined()
    // Returning names the Session before the Conversation renders, so the
    // opener's effect in that commit opens into the Session's store.
    act(() => { h.runtime.panelInfo.set({ activePanelId: null }) })
    expect(h.controller.mounted.getSnapshot()).toBe(SESSION)
    expect(h.opened).toHaveLength(2)
    expect(Object.values(h.layout().tabs).map(tab => tab.contentId)).toContain(h.opened[1])
    expect(h.controller.active()?.contentId).toBe(h.opened[1])
    expect(errors.mock.calls.map(call => String(call[0])).filter(text => text.includes('slot entry crashed'))).toEqual([])
    expect(document.querySelector('[data-slot-error]')).toBeNull()
  })

  it('keeps the on-screen Session through its own store commits', async () => {
    const h = await mountSeat(1440, true, 0, true)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const published: (SessionId | undefined)[] = []
    const stop = h.controller.mounted.subscribe(() => { published.push(h.controller.mounted.getSnapshot()) })
    try {
      // The opener mounts in the commit that also carries a store commit of the
      // seat, and its effect runs before the seat's own effects.
      act(() => {
        h.actions.open(SESSION)
        h.arm(true)
      })
      expect(published).toEqual([])
      expect(h.opened).toHaveLength(1)
      expect(Object.values(h.layout().tabs).map(tab => tab.contentId)).toContain(h.opened[0])
      expect(errors.mock.calls.map(call => String(call[0])).filter(text => text.includes('slot entry crashed'))).toEqual([])
    } finally { stop() }
  })

  it('names the arriving Session before a Conversation opener acts in the commit that switches Sessions', async () => {
    const h = await mountSeat(1440, true, 0, true)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    // The opener holds its own reference, as the Conversation does for its Session.
    const conversation = h.runtime.sessions.retainFor(h.runtime.ctx, SESSION)
    act(() => { h.openerView().update({ armed: false }, { session: conversation }) })
    await act(async () => { await h.runtime.sessions.add({ id: OTHER }) })
    await act(async () => { h.selectSession(OTHER) })
    expect(h.controller.mounted.getSnapshot()).toBe(OTHER)
    // Switching back swaps the seats in the commit that mounts the opener: the
    // departing seat leaves, and the arriving one renders after the opener.
    await act(async () => {
      h.selectSession(SESSION)
      h.openerView().update({ armed: true }, { session: conversation })
    })
    expect(h.controller.mounted.getSnapshot()).toBe(SESSION)
    expect(h.opened).toHaveLength(1)
    expect(Object.values(h.layout().tabs).map(tab => tab.contentId)).toContain(h.opened[0])
    expect(errors.mock.calls.map(call => String(call[0])).filter(text => text.includes('slot entry crashed'))).toEqual([])
    conversation.release()
  })

  it.each([0, 1, 2])('selects the default from %i guide entries and protects only a sole guide', async (entryCount) => {
    const h = await mountSeat(1440, true, entryCount)
    act(() => { h.actions.open(SESSION) })
    const initial = Object.values(h.layout().tabs)[0]!
    expect(initial.kind).toBe(entryCount === 1 ? 'text' : 'guide')
    if (entryCount !== 1) {
      expect(h.view.container.querySelectorAll('[data-dockkit-tab-close]')).toHaveLength(0)
      const before = h.layout()
      act(() => { h.controller.close(initial.id) })
      expect(h.layout()).toBe(before)
      fireEvent.contextMenu(element(h.view.container, '[data-dockkit-tab]'))
      expect(document.querySelector('[data-dockkit-tab-menu] [role^="menuitem"]')).toBeNull()
      expect(h.view.container.querySelector('[data-dockkit-add-tab]')).toBeNull()
      return
    }
    expect(h.view.container.querySelector(`[data-dockkit-tab-close="${initial.id}"]`)).not.toBeNull()
    act(() => { h.controller.close(initial.id) })
    // The column never empties: the close reseeds the then-current default page
    // in the same entry, so there is no empty state to expand out of.
    expect(h.layout().expanded).toBe(true)
    const reseeded = Object.values(h.layout().tabs)[0]!
    expect(reseeded.kind).toBe('text')
    expect(reseeded.id).not.toBe(initial.id)
    fireEvent.click(element(h.view.container, '[data-dockkit-add-tab]'))
    const guide = Object.values(h.layout().tabs).find(tab => tab.kind === 'guide')!
    expect(h.view.container.querySelector('[data-dockkit-add-tab]')).toBeNull()
    expect(h.view.container.querySelector(`[data-dockkit-tab-close="${reseeded.id}"]`)).not.toBeNull()
    expect(h.view.container.querySelector(`[data-dockkit-tab-close="${guide.id}"]`)).not.toBeNull()
    act(() => { h.controller.close(reseeded.id) })
    expect(h.layout().tabs[reseeded.id]).toBeUndefined()
    expect(h.view.container.querySelector(`[data-dockkit-tab-close="${guide.id}"]`)).toBeNull()
    const preview = h.open('ordinary.txt')
    expect(h.view.container.querySelector(`[data-dockkit-tab-close="${preview.id}"]`)).not.toBeNull()
    act(() => { h.controller.close(preview.id) })
    expect(h.layout().tabs[preview.id]).toBeUndefined()
    expect(Object.keys(h.layout().tabs)).toEqual([guide.id])
    expect(h.view.container.querySelectorAll('[data-dockkit-tab-close]')).toHaveLength(0)
    act(() => { h.controller.split() })
    expect(Object.values(h.layout().tabs).map(tab => tab.kind)).toEqual(['guide', 'text'])
  })

  it('offers close for a floating tab while the docked pane keeps its sole tab', async () => {
    const h = await mountSeat()
    const floating = h.open('floating.txt')
    act(() => { h.controller.float(floating.id) })
    const paneId = getPane(h.layout(), h.layout().floats[0]!).id
    expect(h.view.container.querySelector('[data-dockkit-tab-close]')).toBeNull()
    const close = document.querySelector<HTMLButtonElement>(`[data-dockkit-float-close="${paneId}"]`)
    expect(close).not.toBeNull()

    fireEvent.click(close!)

    expect(h.layout().tabs[floating.id]).toBeUndefined()
    expect(h.layout().floats).toHaveLength(0)
    expect(getPane(h.layout(), h.layout().rootId).tabs).toHaveLength(1)
  })

  it('keeps the panel shown and mounted, and releases the frame on unmount', async () => {
    const h = await mountSeat()
    const panel = element(h.view.container, '[data-sidebar-right-panel]')
    // The third column is permanent: no stored layout can hide it or announce
    // it as hidden, so both marks are decided by the render alone.
    expect(panel.hasAttribute('data-sidebar-right-open')).toBe(true)
    expect(panel.getAttribute('aria-hidden')).toBeNull()
    expect(h.frame.closeRightbar).toHaveBeenCalled()
    h.open()
    expect(element(h.view.container, '[data-sidebar-right-panel]')).toBe(panel)
    expect(panel.hasAttribute('data-sidebar-right-open')).toBe(true)
    expect(h.frame.openRightbar).toHaveBeenLastCalledWith(true)
    await h.runtime.dispose()
    expect(h.frame.closeRightbar).toHaveBeenCalled()
  })

})

describe('slot-owned useTabInfo', () => {
  it('updates body and title navigation with no layout commit and retains the bound hook', async () => {
    const h = await mountSeat()
    const tab = h.open('a.txt', { params: { line: 3 } })
    const stored = h.instance.getSnapshot()
    const hook = h.hooks.get(tab.id)
    const signal = h.bodies.get(tab.id)!.tab.signal
    act(() => { h.controller.tabDomain.navigate(SESSION, tab.id, { address: tab.contentId, params: { line: 7 } }) })
    expect(h.instance.getSnapshot()).toBe(stored)
    expect(h.hooks.get(tab.id)).toBe(hook)
    expect(h.bodies.get(tab.id)?.tab.navigation).toEqual({ address: tab.contentId, params: { line: 7 }, revision: 2 })
    expect(h.titles.get(tab.id)?.tab.navigation).toBe(h.bodies.get(tab.id)?.tab.navigation)
    expect(h.bodies.get(tab.id)?.tab.signal).toBe(signal)
    expect(element(h.view.container, '[data-tab-body]').dataset['revision']).toBe('2')
  })

  it('isolates same-kind record state and reports inactive titles, visibility, floating and docking', async () => {
    const h = await mountSeat()
    const a = h.open('a.txt')
    const b = h.open('b.txt')
    const bodyB = element(h.view.container, '[data-tab-body]')
    expect(h.titles.get(a.id)?.tab.visible).toBe(true)
    act(() => { h.actions.focusTab(SESSION, a.id) })
    const bodyA = element(h.view.container, '[data-tab-body]')
    expect(bodyA.dataset['instance']).not.toBe(bodyB.dataset['instance'])
    expect(bodyA.dataset['tabBody']).toBe(a.id)
    const signal = h.bodies.get(a.id)!.tab.signal
    // Nothing can hide the column, so visibility follows each tab's own place
    // in its pane: `a` is the one on show and `b` is not, body and title alike.
    expect(h.bodies.get(a.id)?.tab.visible).toBe(true)
    // A chip is drawn for every tab, so only the body reports the difference:
    // one body on screen, and `b` keeps its record while it has none.
    expect(h.titles.get(b.id)?.tab.visible).toBe(true)
    expect(h.layout().tabs[b.id]).toBeDefined()
    expect(element(h.view.container, '[data-tab-body]')).toBe(bodyA)
    expect(signal.aborted).toBe(false)
    act(() => { h.controller.float(a.id) })
    expect(h.bodies.get(a.id)?.tab.visible).toBe(true)
    const paneId = h.bodies.get(a.id)!.panel.id
    expect(h.layout().floats).toContain(paneId)
    act(() => { h.controller.dock(paneId) })
    expect(h.layout().floats).toHaveLength(0)
    expect(h.bodies.get(a.id)?.tab.signal).toBe(signal)
  })

  it('keeps session records and navigation while unmounted, aborting only removal and plugin unload', async () => {
    const h = await mountSeat()
    const own = h.open()
    const info = h.bodies.get(own.id)!
    const stored = h.instance.getSnapshot()
    await h.runtime.sessions.add({ id: OTHER })
    expect(h.instance.getSnapshot()).toBe(stored)
    expect(info.tab.signal.aborted).toBe(false)
    act(() => { h.selectSession(OTHER) })
    act(() => { h.controller.openResource('dsh-resource://file/session/s-other/other.txt', { params: { line: 9 } }) })
    const otherTab = h.controller.active()!
    expect(otherTab.id).toBe(own.id)
    const otherInfo = h.bodies.get(otherTab.id)!
    expect(otherInfo.tab.signal).not.toBe(info.tab.signal)
    act(() => { info.tab.actions.openResource('dsh-resource://file/session/s-test/b.txt') })
    expect(Object.values(h.layout().tabs).map(tab => tab.title)).toContain('b.txt')
    expect(h.controller.active()?.contentId).toBe(otherTab.contentId)
    expect(h.bodies.get(otherTab.id)?.tab.navigation.params).toEqual({ line: 9 })
    act(() => { info.tab.actions.close() })
    expect(info.tab.signal.aborted).toBe(true)
    expect(otherInfo.tab.signal.aborted).toBe(false)
    const remaining = h.bodies.get(h.controller.active()!.id)!
    expect(remaining.tab.navigation.revision).toBe(1)
    await h.feature.dispose()
    expect(remaining.tab.signal.aborted).toBe(true)
    expect(otherInfo.tab.signal.aborted).toBe(true)
    expect(h.runtime.ctx.get('sidebarRight')).toBeUndefined()
  })

  it('updates guide replacements through the same hook and guide boxes through framework injection', async () => {
    const h = await mountSeat()
    // The first open seeds the guide the replacement renders over.
    act(() => { h.actions.open(SESSION) })
    let captured: SidebarRightTabInfo | undefined
    await act(async () => {
      h.runtime.ctx.sidebarRightTabs.register({
        id: 'test/files', kind: 'files', title: () => 'Files',
        guide: [{ id: 'default', order: 1, title: () => 'Files' }],
      })
    })
    expect(h.view.container.querySelector('[data-sidebar-right-guide-entry="files"]')).not.toBeNull()
    await act(async () => {
      h.runtime.slots.register({ name: 'sidebar.right.tab.guide', select: () => true },
        ({ useTabInfo }: PropsRuntime<'sidebar.right.tab.guide'>) => {
          captured = useTabInfo()
          return <span data-guide-replacement={captured.tab.navigation.revision} />
        })
    })
    expect(h.view.container.querySelector('[data-sidebar-right-guide]')).toBeNull()
    expect(captured?.tab.kind).toBe('guide')
    act(() => { h.controller.openTab('guide') })
    const stored = h.instance.getSnapshot()
    const guide = h.controller.active()!
    act(() => { h.controller.tabDomain.navigate(SESSION, guide.id, { address: guide.contentId, params: undefined }) })
    expect(h.instance.getSnapshot()).toBe(stored)
    expect(captured?.tab.navigation.revision).toBe(2)
    expect(element(h.view.container, '[data-guide-replacement]').dataset['guideReplacement']).toBe('2')
    expect(captured?.sidebar.expanded).toBe(true)
  })

  it('follows type replacement and returns to the builtin when it leaves', async () => {
    const h = await mountSeat()
    h.open()
    let release = () => {}
    await act(async () => {
      release = h.runtime.ctx.sidebarRightTabs.register({ id: 'extension/text', kind: 'text', title: () => 'Extension' })
      h.runtime.slots.register({ name: 'sidebar.right.pane.tab', key: 'extension/text' },
        ({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab'>) => <b data-extension>{useTabInfo().tab.title}</b>)
    })
    expect(element(h.view.container, '[data-extension]').textContent).toBe('a.txt')
    await act(async () => { release() })
    expect(h.view.container.querySelector('[data-extension]')).toBeNull()
    expect(h.view.container.querySelector('[data-tab-body]')).not.toBeNull()
  })

  it('renders unavailable kinds and keeps menu tab/dismiss arguments', async () => {
    const h = await mountSeat()
    let menu: SidebarRightTabMenuOwnerProps | undefined
    await act(async () => {
      h.runtime.slots.register({ name: 'sidebar.right.tab.menu.item', id: 'test' },
        (props: PropsRuntime<'sidebar.right.tab.menu.item'>) => { menu = props; return null })
      h.actions.openContent(SESSION, { kind: 'missing', contentId: 'missing://content', title: 'Missing' }, () => {})
    })
    expect(h.view.container.querySelector('[data-sidebar-right-unavailable]')).not.toBeNull()
    const chip = element(h.view.container, '[data-dockkit-tab]')
    fireEvent.contextMenu(chip)
    expect(menu?.tab.id).toBe(chip.getAttribute('data-dockkit-tab'))
    act(() => { menu?.dismiss() })
    expect(document.querySelector('[data-dockkit-tab-menu]')).toBeNull()
  })

  it('keeps the current binding in the disabled split tooltip when it changes or is cleared', async () => {
    const h = await mountSeat()
    const split: ShortcutCatalogEntry = {
      id: 'pane.split' as ShortcutCommandId, label: 'Split', aliases: [],
      binding: { code: 'Backslash', modifiers: ['meta'] }, modified: false, conflicts: [], issue: null,
      keys: ['⌘', '\\'], aria: 'Meta+\\',
    }
    act(() => {
      h.runtime.ctx.locale.setLocale('en')
      h.catalog.set([split])
      h.actions.open(SESSION)
      h.controller.split()
    })
    const anchor = element(h.view.container, '[data-dockkit-split-button]').parentElement!
    fireEvent.keyDown(anchor, { key: 'Tab' })
    fireEvent.focus(anchor)
    expect(document.querySelector('[role="tooltip"]')?.getAttribute('aria-label')).toBe('Two panes is the limit ⌘ \\')
    act(() => { h.catalog.set([{ ...split, binding: { code: 'KeyG', modifiers: ['control'] },
      keys: ['Ctrl', '+', 'G'], aria: 'Control+G' }]) })
    expect(document.querySelector('[role="tooltip"]')?.getAttribute('aria-label')).toBe('Two panes is the limit Ctrl + G')
    act(() => { h.catalog.set([{ ...split, binding: null, keys: [], aria: undefined }]) })
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Two panes is the limit')
  })

  it('explains the two-pane limit and adds a guide only to a pane without one', async () => {
    const h = await mountSeat()
    // Opening first seeds the left pane's guide; only the right pane will lack one.
    act(() => { h.actions.open(SESSION) })
    h.open()
    const splitButtons = () => h.view.container.querySelectorAll<HTMLButtonElement>('[data-dockkit-split-button]')
    expect(splitButtons()).toHaveLength(1)
    act(() => { h.controller.split() })
    expect(dockPaneIds(h.layout())).toHaveLength(2)
    const stored = h.instance.getSnapshot()
    act(() => { expect(h.controller.split()).toBeUndefined() })
    expect(h.instance.getSnapshot()).toBe(stored)
    expect(splitButtons()).toHaveLength(2)
    expect([...splitButtons()].every(button => button.hasAttribute('disabled'))).toBe(true)
    const right = dockPaneIds(h.layout())[1]!
    h.open('right.txt', { paneId: right })
    const guide = getPane(h.layout(), right).tabs.find(id => h.layout().tabs[id]?.kind === 'guide')!
    act(() => { h.actions.closeTab(SESSION, guide) })
    const add = element(h.view.container, '[data-dockkit-add-tab]')
    expect(add.closest('[data-dockkit-pane]')?.getAttribute('data-dockkit-pane')).toBe(right)
    fireEvent.click(add)
    expect(getPane(h.layout(), right).tabs.filter(id => h.layout().tabs[id]?.kind === 'guide')).toHaveLength(1)
    const closing = [...getPane(h.layout(), right).tabs]
    act(() => { for (const tabId of closing) h.actions.closeTab(SESSION, tabId) })
    expect(dockPaneIds(h.layout())).toHaveLength(1)
    expect(splitButtons()).toHaveLength(1)
    expect(splitButtons()[0]?.disabled).toBe(false)
  })
})

describe('intentsFor — the kit\'s gestures as one session\'s store actions', () => {
  it('binds every intent to the session, and asks the navigation face for a guide on add', () => {
    const actions = {
      focusTab: vi.fn(), focusPane: vi.fn(), splitPane: vi.fn(), closeTab: vi.fn(), duplicateTab: vi.fn(),
      floatTab: vi.fn(), unfloatPane: vi.fn(), placeTab: vi.fn(), dropTab: vi.fn(), moveFloat: vi.fn(),
      resizeFloat: vi.fn(), resizeSplit: vi.fn(),
    }
    const openTab = vi.fn()
    const intents = intentsFor(SESSION, actions as unknown as Parameters<typeof intentsFor>[1], openTab)
    const rect = { x: 1, y: 2, width: 300, height: 200 }
    const TAB_1 = 'tab-1' as TabId
    const PANE_1 = 'pane-1' as PaneId
    const PANE_2 = 'pane-2' as PaneId
    const SPLIT_1 = 'split-1' as SplitId
    intents.focusTab(TAB_1)
    intents.focusPane(PANE_1)
    intents.splitPane(PANE_1)
    intents.closeTab(TAB_1)
    intents.duplicateTab(TAB_1)
    intents.floatTab(TAB_1, rect)
    intents.unfloatPane(PANE_2)
    intents.placeTab(TAB_1, PANE_1, 0)
    intents.dropTab(TAB_1, PANE_1, 'right')
    intents.moveFloat(PANE_2, 30, 40)
    intents.resizeFloat(PANE_2, rect)
    intents.resizeSplit(SPLIT_1, [0.3, 0.7])
    expect(actions.focusTab).toHaveBeenCalledWith(SESSION, TAB_1)
    expect(actions.focusPane).toHaveBeenCalledWith(SESSION, PANE_1)
    expect(actions.splitPane).toHaveBeenCalledWith(SESSION, PANE_1)
    expect(actions.closeTab).toHaveBeenCalledWith(SESSION, TAB_1)
    expect(actions.duplicateTab).toHaveBeenCalledWith(SESSION, TAB_1)
    expect(actions.floatTab).toHaveBeenCalledWith(SESSION, TAB_1, rect)
    expect(actions.unfloatPane).toHaveBeenCalledWith(SESSION, PANE_2)
    expect(actions.placeTab).toHaveBeenCalledWith(SESSION, TAB_1, PANE_1, 0)
    expect(actions.dropTab).toHaveBeenCalledWith(SESSION, TAB_1, PANE_1, 'right')
    expect(actions.moveFloat).toHaveBeenCalledWith(SESSION, PANE_2, 30, 40)
    expect(actions.resizeFloat).toHaveBeenCalledWith(SESSION, PANE_2, rect)
    expect(actions.resizeSplit).toHaveBeenCalledWith(SESSION, SPLIT_1, [0.3, 0.7])
    // The add control is the guide opened by kind, in that pane, beside any guide elsewhere.
    intents.addTab(PANE_1)
    expect(openTab).toHaveBeenCalledWith('guide', { paneId: PANE_1, revealIfOpened: false })
  })
})

it('keeps a resource tab and reports a synchronous cleanup failure from its close button', async () => {
  const h = await mountSeat()
  const tab = h.open('terminal')
  const failure = new Error('process still running')
  const release = h.controller.registerCloseHandler('text', () => { throw failure })
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    fireEvent.click(element(h.view.container, `[data-dockkit-tab-close="${tab.id}"]`))
    await expect.poll(() => logged.mock.calls).toEqual([['Sidebar tab close failed:', failure]])
    expect(h.layout().tabs[tab.id]).toBeDefined()
    release()
    fireEvent.click(element(h.view.container, `[data-dockkit-tab-close="${tab.id}"]`))
    expect(h.layout().tabs[tab.id]).toBeUndefined()
  } finally {
    logged.mockRestore()
    release()
  }
})
