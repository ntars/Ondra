// @vitest-environment jsdom
/** Frame geometry with a real store and explicitly driven browser measurements. */
import type { GlobalStandardProps, RenderOpts } from '@deepseek-ai/dsh-client-ui-slots'
import { allowAllAccess, bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { AppFrame } from '../src/client/AppFrame.tsx'
import type { AppFrameProps } from '../src/client/AppFrame.tsx'
import type { MainPanelId, RightbarOwnerProps, SidebarOwnerProps } from '../src/client/index.ts'
import { createLayoutStore } from '../src/client/stores.ts'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined })) as GlobalStandardProps['useResource']
let selectedSession: SessionId | undefined
let selectedSessionTitle: string | undefined
let workspacesReady = true
type AttentionSnapshot = Parameters<Parameters<AppFrameProps['useSessionStatus']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionStatus: AppFrameProps['useSessionStatus'] = selector => selector(noAttention)

let observers: ResizeObserverStub[]
class ResizeObserverStub {
  disconnected = false
  constructor(private callback: ResizeObserverCallback) { observers.push(this) }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void { this.disconnected = true }
  fire(): void { this.callback([], this) }
}

let frameWidth: number
let animationFrames: Map<number, FrameRequestCallback>
let nextFrame: number
let originalTitle: string
/** Flush one browser frame without depending on the worker's timer cadence. */
function flushFrames(): void {
  for (const [id, callback] of [...animationFrames]) {
    if (!animationFrames.delete(id)) continue
    callback(0)
  }
}

function resize(width: number): void {
  frameWidth = width
  act(() => {
    for (const observer of observers) if (!observer.disconnected) observer.fire()
    flushFrames()
  })
}

function mountFrame(windowWidth = frameWidth) {
  vi.stubGlobal('innerWidth', windowWidth)
  const instance = createLayoutStore().create()
  const slotCalls: { key: string; props: object; options: RenderOpts | undefined }[] = []
  const renderSlot: AppFrameProps['renderSlot'] = (key, owner, options) => {
    slotCalls.push({ key, props: owner, options })
    return <div data-testid={`${key}-content`} data-entry-key={options?.entryKey} />
  }
  const useSessions: AppFrameProps['useSessions'] = sel => sel({
    ids: selectedSession === undefined ? [] : [selectedSession],
    byId: selectedSession === undefined ? {} : {
      [selectedSession]: {
        id: selectedSession, displayTitle: 'Test', running: false, retainedBy: { mainView: 1 }, blank: false, updatedAt: 1,
        ...(selectedSessionTitle === undefined ? {} : { title: selectedSessionTitle }),
      },
    },
    phase: 'ready',
    projectionsBySession: {},
  })
  const workspaceState: WorkspaceSnapshot = {
    items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    ...(workspacesReady ? {} : { state: 'loading' as const, phase: 'pending' as const }),
  }
  const useStore = bindSnapshotSelector(instance)
  const usePanelInfo = bindSnapshotSelector({
    getSnapshot: () => instance.getSnapshot().panelInfo,
    subscribe: listener => instance.subscribe(listener),
  })
  const element = () => (
    <AppFrame
      useStore={useStore}
      actions={instance.actions}
      renderSlot={renderSlot}
      useSessions={useSessions}
      usePanelInfo={usePanelInfo}
      useSessionStatus={useSessionStatus}
      useSessionRetainInfo={() => undefined}
      useResource={useResource}
      useWorkspaces={sel => sel(workspaceState)}
      {...allowAllAccess}
      t={key => key === 'brand.localBuild' ? 'DSH Local Build' : key}
    />
  )
  const utils = render(element())
  const frame = utils.container.firstElementChild as HTMLElement
  return {
    ...utils, instance, frame, slotCalls,
    rerenderFrame: () => { utils.rerender(element()) },
    rightOwner: () => slotCalls.findLast(c => c.key === 'rightbar')!.props as RightbarOwnerProps,
    sidebarOwner: () => slotCalls.findLast(c => c.key === 'sidebar')!.props as SidebarOwnerProps,
  }
}

/* jsdom does no layout, so specs read the specified tracks: [sidebar px, rightbar px]. */
function tracks(frame: HTMLElement): number[] {
  const match = /^([\d.]+)px minmax\(0, 1fr\) ([\d.]+)px$/.exec(frame.style.gridTemplateColumns)
  if (match === null) throw new Error(`unexpected template: ${frame.style.gridTemplateColumns}`)
  return [Number(match[1]), Number(match[2])]
}

beforeEach(() => {
  originalTitle = document.title
  frameWidth = 1920
  selectedSession = 's-test' as SessionId
  selectedSessionTitle = undefined
  workspacesReady = true
  observers = []
  animationFrames = new Map()
  nextFrame = 1
  vi.stubEnv('DSH_CLIENT_TITLE', undefined)
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++
    animationFrames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { animationFrames.delete(id) })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    width: frameWidth, height: 1080, top: 0, left: 0, right: frameWidth, bottom: 1080,
    x: 0, y: 0, toJSON: () => ({}),
  }))
})

afterEach(() => {
  try {
    cleanup()
  } finally {
    delete document.documentElement.dataset.platform
    document.title = originalTitle
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  }
})

describe('AppFrame', () => {
  it('localizes the product title without a configured build title', () => {
    mountFrame()
    expect(document.title).toBe('DSH Local Build')
  })

  it('follows the selected durable Session title', () => {
    vi.stubEnv('DSH_CLIENT_TITLE', 'Product')
    selectedSessionTitle = 'First'
    const { rerenderFrame } = mountFrame()
    expect(document.title).toBe('First — Product')
    selectedSessionTitle = 'Revised'
    rerenderFrame()
    expect(document.title).toBe('Revised — Product')
    selectedSession = undefined
    rerenderFrame()
    expect(document.title).toBe('Product')
  })

  it('renders the three columns as quarters: 1/4 | 2/4 | 1/4', () => {
    const { frame, rightOwner, sidebarOwner, slotCalls } = mountFrame()
    expect(tracks(frame)).toEqual([480, 480])
    expect(sidebarOwner()).toEqual({ width: 480 })
    expect(rightOwner()).toEqual({ width: 480, viewportWidth: 1920, canShow: true })
    expect(slotCalls.find(c => c.key === 'main')).toEqual({ key: 'main', props: {}, options: { entryKey: 'conversation' } })
  })

  it('holds the quarter split at every frame width', () => {
    const { frame } = mountFrame()
    resize(1200)
    expect(tracks(frame)).toEqual([300, 300])
    resize(900)
    expect(tracks(frame)).toEqual([225, 225])
    resize(2400)
    expect(tracks(frame)).toEqual([600, 600])
  })

  it('offers neither a resize handle nor a collapse control', () => {
    const { frame } = mountFrame()
    expect(frame.querySelector('[data-side]')).toBeNull()
    // Every column stays mounted at its quarter: nothing in the frame can hide one.
    expect(frame.querySelector('[data-sidebar-collapsed]')).toBeNull()
    expect(frame.querySelector('[data-rightbar-collapsed]')).toBeNull()
  })

  it('renders the column and bottom outlets without a current Session', () => {
    selectedSession = undefined
    const { frame, getByTestId } = mountFrame()
    expect(getByTestId('main-content').getAttribute('data-entry-key')).toBe('conversation')
    expect(getByTestId('sidebar-content')).toBeTruthy()
    expect(getByTestId('rightbar-content')).toBeTruthy()
    expect(getByTestId('shell.bottom-content').parentElement?.hasAttribute('data-shell-bottom')).toBe(true)
    expect(tracks(frame)).toEqual([480, 480])
  })

  it('switches only the keyed main outlet when the active panel changes', () => {
    selectedSessionTitle = 'Session title'
    const { instance, frame, slotCalls, getByTestId } = mountFrame()
    const sessionId = selectedSession
    const layoutInfo = instance.getSnapshot().layoutInfo
    for (const panelId of ['panel-a' as MainPanelId, 'panel-b' as MainPanelId, null]) {
      slotCalls.length = 0
      act(() => { instance.actions.selectPanel(panelId) })
      expect(slotCalls).toEqual([{ key: 'main', props: {}, options: { entryKey: panelId ?? 'conversation' } }])
      expect(getByTestId('main-content').getAttribute('data-entry-key')).toBe(panelId ?? 'conversation')
      expect(instance.getSnapshot().panelInfo).toEqual({ activePanelId: panelId })
      expect(instance.getSnapshot().layoutInfo).toBe(layoutInfo)
      expect(tracks(frame)).toEqual([480, 480])
      expect(selectedSession).toBe(sessionId)
      expect(document.title).toBe(panelId === null ? 'Session title — DSH Local Build' : 'DSH Local Build')
    }
  })
})
