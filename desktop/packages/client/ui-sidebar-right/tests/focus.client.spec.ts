// @vitest-environment jsdom
/** Focus ownership remains separate from layout selection and validates captured lifetimes. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { activeDockPaneId, findTabPane, getPane } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSidebarRightController } from '../src/client/service.ts'
import { createSidebarRightStore } from '../src/client/stores.ts'
import { SidebarRightTabRegistry } from '../src/client/tab-registry.ts'
import { observeSidebarFocus } from '../src/client/focus.ts'

const SESSION = 'focus-session' as SessionId
const releases: Array<() => void> = []
afterEach(() => { cleanup(); for (const release of releases.splice(0).reverse()) release(); document.body.replaceChildren() })

function harness() {
  const ctx = new Context()
  const tabs = new SidebarRightTabRegistry(ctx)
  for (const kind of ['guide', 'files', 'terminal']) tabs.register({ id: kind, kind, title: () => kind, multiple: kind === 'terminal' })
  const room = { allowed: true }
  const { controller, adopt, show: showSession, measure } = createSidebarRightController(tabs, vi.fn(), {
    openWithFocus: (_sessionId, open) => { open() },
    closeWithFocus: (_sessionId, _paneId, close) => { close() },
  })
  const store = createSidebarRightStore(() => ({ kind: 'guide', title: 'guide' })).create()
  releases.push(adopt(SESSION, store), () => { controller.tabDomain.dispose() })
  store.actions.open(SESSION)
  /** Put a Session on screen the way the plugin does, with the room rule its seat reports. */
  const show = (sessionId = SESSION) => {
    showSession(sessionId)
    measure(sessionId, () => room.allowed)
    return () => { if (controller.mounted.getSnapshot() === sessionId) showSession(undefined) }
  }
  releases.push(show())
  const layout = () => store.getSnapshot().bySession[SESSION]!.layout
  const owner = document.createElement('section')
  owner.dataset.sidebarRightSession = SESSION
  document.body.append(owner)
  const paneElement = (paneId = activeDockPaneId(layout())) => {
    const pane = getPane(layout(), paneId)
    const element = document.createElement('section')
    element.tabIndex = -1
    element.dataset[pane.host === 'dock' ? 'dockkitPane' : 'dockkitFloat'] = paneId
    owner.append(element)
    return element
  }
  const tabElement = (tabId: TabId, parent = paneElement(findTabPane(layout(), tabId).id)) => {
    const element = document.createElement('div')
    element.tabIndex = 0
    element.dataset.dockkitTab = tabId
    element.dataset.sidebarRightOccurrence = controller.tabDomain.occurrence(SESSION, { id: tabId }).id
    parent.append(element)
    return element
  }
  return { controller, store, layout, paneElement, tabElement, room, show }
}

describe('sidebar focus targets', () => {
  it('ignores floating pane markup outside a Session owner', () => {
    const pane = document.createElement('section')
    pane.tabIndex = -1
    pane.dataset.dockkitFloat = 'orphan'
    document.body.append(pane)
    releases.push(observeSidebarFocus(document))
    pane.focus()
    expect(document.activeElement).toBe(pane)
  })

  it('does not restore a removed editor over focus captured by another component', async () => {
    const h = harness(), pane = h.paneElement()
    pane.parentElement!.setAttribute('data-sidebar-right-open', '')
    const input = document.createElement('input'), outside = document.createElement('button')
    pane.append(input)
    document.body.append(outside)
    releases.push(observeSidebarFocus(document))
    input.focus()
    pane.append(document.createElement('span'))
    await Promise.resolve()
    expect(document.activeElement).toBe(input)
    input.remove()
    document.addEventListener('focusin', (event) => { event.stopImmediatePropagation() }, { capture: true, once: true })
    outside.focus()
    await Promise.resolve()
    expect(document.activeElement).toBe(outside)
  })
  it('uses keyboard-focused inactive tabs and iframe ownership instead of the last selected pane', () => {
    const h = harness()
    const left = activeDockPaneId(h.layout())
    h.controller.openTab('files')
    const files = h.controller.active()!.id
    const right = h.controller.split(left)!
    expect(h.layout().activePaneId).toBe(right)
    const chip = h.tabElement(files)
    chip.focus()
    expect(h.controller.focusedTarget()).toMatchObject({ sessionId: SESSION, paneId: left, tabId: files })
    const iframe = document.createElement('iframe')
    chip.append(iframe)
    iframe.focus()
    expect(h.controller.focusedTarget()).toMatchObject({ paneId: left, tabId: files })
    const composer = document.createElement('textarea')
    document.body.append(composer)
    composer.focus()
    expect(h.controller.focusedTarget()).toBeUndefined()
    expect(h.controller.commandTarget()?.paneId).toBe(right)
  })

  it('rejects disconnected, switched-session, moved and reopened targets', () => {
    const h = harness()
    h.controller.openTab('files')
    const files = h.controller.active()!.id
    const chip = h.tabElement(files)
    const target = h.controller.focusedTarget(chip)!
    expect(h.controller.isTargetCurrent(target)).toBe(true)
    releases.push(h.show('another-session' as SessionId))
    expect(h.controller.isTargetCurrent(target)).toBe(false)
    expect(h.controller.focusedTarget(chip)).toBeUndefined()
    releases.push(h.show())
    h.controller.float(files)
    expect(h.controller.isTargetCurrent(target)).toBe(false)
    h.controller.dock(findTabPane(h.layout(), files).id)
    h.controller.close(files)
    h.controller._undo()
    expect(h.controller.isTargetCurrent(target)).toBe(false)
    expect(h.controller.focusedTarget(chip)).toBeUndefined()
    chip.remove()
    expect(h.controller.focusedTarget(chip)).toBeUndefined()
  })

  it('rejects a pane removed by closing its final content page', () => {
    const h = harness()
    h.controller.split()
    h.controller.openTabFromTarget('files', h.controller.commandTarget(null)!)
    const captured = h.controller.focusedTarget(h.tabElement(h.controller.active()!.id))!
    h.controller.close(captured.tabId!)
    expect(h.controller.isTargetCurrent(captured)).toBe(false)
    h.controller.openTabFromTarget('terminal', captured)
    expect(Object.values(h.layout().tabs).map(tab => tab.kind)).toEqual(['guide'])
  })

  it('invalidates navigation captures and keeps opens scoped to the target pane', () => {
    const h = harness()
    const first = h.controller.commandTarget(null)!
    h.controller.openTabFromTarget('files', first)
    expect(Object.values(h.layout().tabs).map(tab => tab.kind)).toEqual(['files'])
    const files = h.controller.commandTarget(null)!
    h.controller.openTabFromTarget('files', files)
    expect(Object.values(h.layout().tabs)).toHaveLength(1)
    expect(h.controller.isTargetCurrent(files)).toBe(false)
    h.controller.openTabFromTarget('terminal', h.controller.commandTarget(null)!)
    h.controller.openTabFromTarget('terminal', h.controller.commandTarget(null)!)
    const terminals = Object.values(h.layout().tabs).filter(tab => tab.kind === 'terminal')
    expect(terminals).toHaveLength(2)
    expect(terminals[0]!.contentId).not.toBe(terminals[1]!.contentId)
    h.controller.float(terminals[0]!.id)
    const floating = h.controller.focusedTarget(h.tabElement(terminals[0]!.id))!
    h.controller.openTabFromTarget('terminal', floating)
    expect(Object.values(h.layout().tabs).filter(tab => tab.kind === 'terminal')).toHaveLength(3)
    expect(h.layout().tabs[terminals[0]!.id]).toBeDefined()
    expect(getPane(h.layout(), floating.paneId).tabs).toHaveLength(1)
  })

  it('shares split limits while preserving floating pages', () => {
    const h = harness()
    const target = h.controller.commandTarget(null)!
    h.room.allowed = false
    expect(h.controller.splitBlock(target)).toBe('width')
    h.room.allowed = true
    expect(h.controller.splitBlock(target)).toBeUndefined()
    h.controller.split(target.paneId)
    expect(h.controller.splitBlock(target)).toBe('budget')
    h.controller.openTab('files')
    const files = h.controller.active()!.id
    h.controller.float(files)
    const floated = h.controller.focusedTarget(h.tabElement(files))!
    expect(h.controller.splitBlock(floated)).toBe('float')
  })

  it('rejects orphaned markup and reports a floating page as its own kind of target', () => {
    const h = harness()
    const pane = h.paneElement()
    const owner = pane.parentElement!
    const orphan = document.createElement('button')
    owner.append(orphan)
    expect(h.controller.focusedTarget(orphan)).toBeUndefined()
    const staleTab = document.createElement('div')
    staleTab.dataset.dockkitTab = 'removed-tab'
    pane.append(staleTab)
    expect(h.controller.focusedTarget(staleTab)).toBeUndefined()
    const stalePane = pane.cloneNode() as HTMLElement
    stalePane.dataset.dockkitPane = 'removed-pane'
    owner.append(stalePane)
    expect(h.controller.focusedTarget(stalePane)).toBeUndefined()
    h.controller.openTabFromTarget('files', h.controller.commandTarget(null)!)
    const closedFile = h.controller.active()!.id
    h.controller.close(closedFile)
    // Closing the last non-guide tab reseeds the default page, so the closed
    // record is gone and the column still names a page.
    expect(h.layout().tabs[closedFile]).toBeUndefined()
    expect(h.controller.commandTarget(null)?.tabId).toBeDefined()
    h.controller.openTabFromTarget('files', h.controller.commandTarget(null)!)
    const floatingFile = h.controller.active()!.id
    h.controller.float(floatingFile)
    const floating = h.controller.focusedTarget(h.tabElement(floatingFile))!
    expect(findTabPane(h.layout(), floatingFile).id).toBe(floating.paneId)
    expect(h.layout().expanded).toBe(true)
    expect(h.controller.splitBlock(floating)).toBe('float')
    releases.push(h.show('missing-session' as SessionId))
    expect(h.controller.commandTarget(null)).toBeUndefined()
    expect(h.controller.splitBlock(floating)).toBe('stale')
  })

  it('focuses pointer-activated pane contents and releases document listeners', async () => {
    const h = harness()
    const pane = h.paneElement()
    const body = document.createElement('div')
    pane.append(body)
    const release = observeSidebarFocus(document)
    body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(document.activeElement).toBe(pane)
    const button = document.createElement('button')
    pane.append(button)
    button.focus()
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(document.activeElement).toBe(button)
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    window.dispatchEvent(new Event('blur'))
    await Promise.resolve()
    window.dispatchEvent(new Event('blur'))
    release()
    await Promise.resolve()
    expect(document.activeElement).toBe(button)
    body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(document.activeElement).toBe(button)
  })

  it.each([
    { name: 'outside editor range', inside: false, editable: true, textAnchor: true, collapsed: false },
    { name: 'outside editor caret', inside: false, editable: true, textAnchor: true, collapsed: true },
    { name: 'outside editor element', inside: false, editable: true, textAnchor: false, collapsed: false },
    { name: 'pane editor text', inside: true, editable: true, textAnchor: true, collapsed: false },
    { name: 'outside page text', inside: false, editable: false, textAnchor: true, collapsed: false },
  ])('preserves text selection while focusing a pane: $name', ({ inside, editable, textAnchor, collapsed }) => {
    const h = harness()
    const pane = h.paneElement()
    const selected = document.createElement('div')
    selected.setAttribute('contenteditable', String(editable))
    selected.textContent = 'preserved text'
    ;(inside ? pane : document.body).append(selected)
    releases.push(observeSidebarFocus(document))
    pane.focus()
    const selection = document.getSelection()!
    // Chromium retains the departing editor selection on focus; jsdom moves it to the pane.
    const anchor = textAnchor ? selected.firstChild! : selected
    selection.setBaseAndExtent(anchor, 0, anchor, textAnchor ? 'preserved text'.length : selected.childNodes.length)
    if (collapsed) selection.collapseToEnd()
    pane.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(document.activeElement).toBe(pane)
    expect(selection.rangeCount).toBe(1)
    expect(selection.toString()).toBe(collapsed ? '' : 'preserved text')
    expect(selected.textContent).toBe('preserved text')
  })

  it('follows the active tab when a focused pane is replaced and its tabs move to different panes', async () => {
    const h = harness()
    const pane = h.paneElement()
    const owner = pane.parentElement!
    owner.setAttribute('data-sidebar-right-open', '')
    const tab = (id: string, selected: boolean) => {
      const button = document.createElement('button')
      button.setAttribute('role', 'tab')
      button.setAttribute('aria-selected', String(selected))
      const marker = document.createElement('span')
      marker.dataset.sidebarRightOccurrence = id
      button.append(marker)
      return button
    }
    const first = tab('first', false)
    const selected = tab('selected', true)
    pane.append(first, selected)
    releases.push(observeSidebarFocus(document))
    pane.focus()
    const firstPane = pane.cloneNode() as HTMLElement
    firstPane.dataset.dockkitPane = 'first-destination'
    firstPane.append(first)
    const selectedPane = pane.cloneNode() as HTMLElement
    selectedPane.dataset.dockkitPane = 'selected-destination'
    selectedPane.append(selected)
    pane.replaceWith(firstPane, selectedPane)
    await Promise.resolve()
    expect(document.activeElement).toBe(selectedPane)
  })

  it.each(['input', 'iframe'] as const)('retains the owning pane after its focused %s is remounted', async (kind) => {
    const h = harness()
    const pane = h.paneElement()
    pane.parentElement!.setAttribute('data-sidebar-right-open', '')
    const input = document.createElement(kind)
    pane.append(input)
    const release = observeSidebarFocus(document)
    releases.push(release)
    input.focus()
    input.replaceWith(document.createElement(kind))
    await Promise.resolve()
    expect(document.activeElement).toBe(pane)
  })

  it.each(['outside-pointer', 'other-focus', 'blur', 'hidden', 'session-change', 'dispose'] as const)('does not reclaim focus after %s', async (reason) => {
    const h = harness()
    const pane = h.paneElement()
    const owner = pane.parentElement!
    owner.setAttribute('data-sidebar-right-open', '')
    const input = document.createElement('input')
    pane.append(input)
    const outside = document.createElement('button')
    document.body.append(outside)
    const release = observeSidebarFocus(document)
    releases.push(release)
    input.focus()
    if (reason === 'outside-pointer') outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    else if (reason === 'other-focus') outside.focus()
    else if (reason === 'blur') input.blur()
    else if (reason === 'hidden') owner.removeAttribute('data-sidebar-right-open')
    else if (reason === 'session-change') owner.dataset.sidebarRightSession = 'different-session'
    else release()
    input.remove()
    await Promise.resolve()
    expect(document.activeElement).toBe(reason === 'other-focus' ? outside : document.body)
  })
})
