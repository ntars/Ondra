// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ShortcutCatalogEntry, ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { allowAllAccess, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ReactNode } from 'react'
import type {
  SidebarFooterActionOwnerProps, SidebarRootComponentProps, SidebarSectionOwnerProps,
  SidebarSettingsOwnerProps,
} from '../src/client/contract/slots.ts'
import { SidebarRoot } from '../src/client/SidebarRoot.tsx'
import { en } from '../src/client/locales.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

const t: SidebarRootComponentProps['t'] = makeTranslate({ ...commonEn, ...en })

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.platform
  vi.unstubAllEnvs()
  vi.useRealTimers()
  Reflect.deleteProperty(navigator, 'clipboard')
})

// The shell never reads the global hooks itself, but they ride the standard
// props share; stub them as never-called functions.
const neverHook = (() => { throw new Error('shell must not read global hooks') }) as never
type AttentionSnapshot = Parameters<Parameters<SidebarRootComponentProps['useSessionStatus']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionStatus: SidebarRootComponentProps['useSessionStatus'] = selector => selector(noAttention)

function mountShell({ width = 300, shortcuts = [] }: {
  width?: number
  shortcuts?: readonly ShortcutCatalogEntry[]
} = {}) {
  const startSession = vi.fn()
  const trackEntryClick = vi.fn<SidebarRootComponentProps['trackEntryClick']>()
  let regionOwner: SidebarSectionOwnerProps | undefined
  let settingsOwner: SidebarSettingsOwnerProps | undefined
  let footerActionOwner: SidebarFooterActionOwnerProps | undefined
  const brandMark = <span data-testid="custom-brand-mark">M</span>
  const brandName = <span data-testid="custom-brand-name">Custom Brand</span>
  let current = { width }
  const root = () => (
    <SidebarRoot
      width={current.width}
      useSessions={neverHook} useSessionStatus={useSessionStatus} useSessionRetainInfo={neverHook}
      usePanelInfo={usePanelInfo} selectPanel={() => {}} usePanels={selector => selector([])} useEntryPins={selector => selector([])}
      useEntryActions={selector => selector(false)} setPinned={vi.fn()}
      useShortcuts={selector => selector(shortcuts)}
      useResource={useResource} useWorkspaces={neverHook}
      {...allowAllAccess}
      startSession={startSession} trackEntryClick={trackEntryClick} t={t}
      renderSlot={((
        key: string,
        owner: SidebarFooterActionOwnerProps | SidebarSectionOwnerProps | SidebarSettingsOwnerProps,
      ) => {
        if (key === 'sidebar.brand.mark') return brandMark
        if (key === 'sidebar.brand.name') return brandName
        if (key === 'sidebar.settings') {
          settingsOwner = owner
          return <div data-testid="settings-seat" />
        }
        if (key === 'sidebar.footer.action') {
          footerActionOwner = owner
          return <div data-testid="footer-action-seat" />
        }
        regionOwner = owner
        return <div data-testid="region" />
      }) as SidebarRootComponentProps['renderSlot']}
    />
  )
  const view = render(root())
  return {
    startSession,
    trackEntryClick,
    regionOwner: () => {
      if (regionOwner === undefined) throw new Error('region owner not rendered')
      return regionOwner
    },
    settingsOwner: () => {
      if (settingsOwner === undefined) throw new Error('settings owner not rendered')
      return settingsOwner
    },
    footerActionOwner: () => {
      if (footerActionOwner === undefined) throw new Error('footer action owner not rendered')
      return footerActionOwner
    },
    rerender(next: Partial<typeof current>) {
      current = { ...current, ...next }
      view.rerender(root())
    },
  }
}

describe('SidebarRoot shell', () => {
  it('advertises the effective new-session binding', () => {
    const shortcut: ShortcutCatalogEntry = { id: 'session.new' as ShortcutCommandId, label: 'New', aliases: [],
      binding: null, modified: true, conflicts: [], issue: null, keys: ['Ctrl', 'N'], aria: 'Control+N' }
    mountShell({ shortcuts: [shortcut] })
    for (const button of screen.getAllByRole('button', { name: 'New session' })) {
      expect(button.getAttribute('aria-keyshortcuts')).toBe('Control+N')
    }
    const expanded = screen.getAllByRole('button', { name: 'New session' }).find(button => button.querySelector('kbd') !== null)!
    fireEvent.pointerEnter(expanded)
    fireEvent.focus(expanded)
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(Array.from(expanded.querySelectorAll('kbd'), key => key.textContent)).toEqual(['Ctrl', 'N'])
  })
  it('routes New Session from the capsule and the wordmark', () => {
    const b = mountShell()
    expect(screen.getByTestId('custom-brand-mark')).toBeTruthy()
    expect(screen.getByTestId('custom-brand-name')).toBeTruthy()
    // Expanded, both the wordmark and the capsule start a session and report a sidebar New Session click first.
    const starters = screen.getAllByRole('button', { name: 'New session' })
    expect(starters).toHaveLength(2)
    for (const button of starters) fireEvent.click(button)
    expect(b.startSession).toHaveBeenCalledTimes(2)
    expect(b.trackEntryClick.mock.calls).toEqual([
      [{ menu_name: 'new_session', position: 'sidebar' }],
      [{ menu_name: 'new_session', position: 'sidebar' }],
    ])
    expect(b.trackEntryClick.mock.invocationCallOrder[0]).toBeLessThan(b.startSession.mock.invocationCallOrder[0]!)
  })

  it('offers no New Session control while the access snapshot excludes session/create', () => {
    const useRemoteAccess = vi.fn((action: string) => action !== 'session/create')
    render(<SidebarRoot
      width={300}
      useSessions={neverHook} useSessionStatus={useSessionStatus} useSessionRetainInfo={neverHook}
      usePanelInfo={usePanelInfo} selectPanel={() => {}} usePanels={selector => selector([])} useEntryPins={selector => selector([])}
      useEntryActions={selector => selector(false)} setPinned={vi.fn()}
      useShortcuts={selector => selector([])}
      useResource={useResource} useWorkspaces={neverHook}
      {...allowAllAccess}
      useRemoteAccess={useRemoteAccess}
      startSession={vi.fn()} trackEntryClick={vi.fn()} t={t}
      renderSlot={((key: string) => {
        if (key === 'sidebar.brand.mark') return <span data-testid="brand-mark">M</span>
        if (key === 'sidebar.brand.name') return <span data-testid="brand-name">Brand</span>
        return null
      }) as SidebarRootComponentProps['renderSlot']}
    />)

    // Neither the brand row nor the dedicated button starts a Session; the brand still renders.
    expect(useRemoteAccess).toHaveBeenCalledWith('session/create')
    expect(screen.queryByRole('button', { name: 'New session' })).toBeNull()
    expect(screen.getByTestId('brand-mark')).toBeTruthy()
    expect(screen.getByTestId('brand-name')).toBeTruthy()
  })

  it('renders the persona fallback when no package fills the brand slots', () => {
    const { container } = render(<SidebarRoot
      width={300}
      useSessions={neverHook} useSessionStatus={useSessionStatus} useSessionRetainInfo={neverHook}
      usePanelInfo={usePanelInfo} selectPanel={() => {}} usePanels={selector => selector([])} useEntryPins={selector => selector([])}
      useEntryActions={selector => selector(false)} setPinned={vi.fn()}
      useShortcuts={selector => selector([])}
      useResource={useResource} useWorkspaces={neverHook}
      {...allowAllAccess}
      startSession={vi.fn()} trackEntryClick={vi.fn()} t={t}
      renderSlot={((_key: string, _owner: unknown, options?: { fallback?: ReactNode }) =>
        options?.fallback ?? null) as SidebarRootComponentProps['renderSlot']}
    />)

    // The brand row presents the current persona instead of the product
    // wordmark: the short name sits above a presence line, the mark carries
    // the product fish, and no build version appears — nothing copies it now.
    expect(screen.getByText('哦鲸鲸')).toBeTruthy()
    expect(screen.getByText('Online')).toBeTruthy()
    expect(container.querySelector('svg')).not.toBeNull()
    expect(screen.queryByText('Ondra Local Build')).toBeNull()
  })

  it.each([false, true])('routes the brand row to New Session without copying anything (darwin=%s)', (darwin) => {
    if (darwin) document.documentElement.dataset.platform = 'darwin'
    const startSession = vi.fn()
    const trackEntryClick = vi.fn<SidebarRootComponentProps['trackEntryClick']>()
    render(<SidebarRoot
      width={300}
      useSessions={neverHook} useSessionStatus={useSessionStatus} useSessionRetainInfo={neverHook}
      usePanelInfo={usePanelInfo} selectPanel={() => {}} usePanels={selector => selector([])} useEntryPins={selector => selector([])}
      useEntryActions={selector => selector(false)} setPinned={vi.fn()}
      useShortcuts={selector => selector([])}
      useResource={useResource} useWorkspaces={neverHook}
      {...allowAllAccess}
      startSession={startSession} trackEntryClick={trackEntryClick} t={t}
      renderSlot={((_key: string, _owner: unknown, options?: { fallback?: ReactNode }) =>
        options?.fallback ?? null) as SidebarRootComponentProps['renderSlot']}
    />)

    // Nothing in the brand row copies a build version any more, so a click is
    // either a New Session (web) or a window drag (macOS) — never a toast.
    expect(screen.queryAllByRole('alert')).toEqual([])
    if (darwin) {
      // The macOS brand stays a drag surface, so only the capsule is a button.
      expect(screen.getAllByRole('button', { name: 'New session' })).toHaveLength(1)
    } else {
      fireEvent.click(screen.getAllByRole('button', { name: 'New session' })[0]!)
      expect(startSession).toHaveBeenCalledOnce()
      expect(trackEntryClick).toHaveBeenCalledExactlyOnceWith({ menu_name: 'new_session', position: 'sidebar' })
    }
  })

  it('hands every seat an empty owner share', () => {
    const b = mountShell()
    // The column is permanent, so no seat receives fold state any more.
    expect(Object.keys(b.regionOwner())).toEqual([])
    expect(Object.keys(b.settingsOwner())).toEqual([])
    expect(Object.keys(b.footerActionOwner())).toEqual([])
  })

})

describe('Windows caption New Session analytics', () => {
  afterEach(() => { document.documentElement.removeAttribute('data-windows-titlebar') })

  it('reports the expanded brand and New Session button as sidebar clicks', () => {
    document.documentElement.setAttribute('data-windows-titlebar', '')
    const b = mountShell()
    const starters = screen.getAllByRole('button', { name: 'New session' })
    expect(starters).toHaveLength(2)
    for (const button of starters) fireEvent.click(button)
    expect(b.startSession).toHaveBeenCalledTimes(2)
    expect(b.trackEntryClick.mock.calls).toEqual([
      [{ menu_name: 'new_session', position: 'sidebar' }],
      [{ menu_name: 'new_session', position: 'sidebar' }],
    ])
  })
})
