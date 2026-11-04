// @vitest-environment jsdom
import type { GlobalStandardProps } from '@ntars/ondra-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { allowAllAccess } from '@ntars/ondra-client-test-runtime'
import type { GeneralSectionComponentProps } from '../src/client/GeneralSection.tsx'
import { GeneralSection } from '../src/client/GeneralSection.tsx'
import { CloseLabel, HeaderContent, TriggerContent } from '../src/client/chrome.tsx'
import type { TriggerContentProps } from '../src/client/chrome.tsx'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

import { en, zh } from '../src/client/locales.ts'
import { CurrentVersionRow } from '../src/client/CurrentVersionRow.tsx'
import { DesktopUpdateBadge } from '../src/client/DesktopUpdateIndicator.tsx'
import { HostReleasePrompt, type HostReleasePromptProps } from '../src/client/HostReleasePrompt.tsx'
import type { DesktopUpdateView } from '../src/types.ts'

afterEach(() => { cleanup(); vi.unstubAllEnvs() })

// The seat's key domain is settings ∪ common; the stub answers from the
// package dictionary and falls back to the key like the real chain.
const t: TriggerContentProps['t'] = key => (en as Record<string, string>)[key] ?? key

// Global standard kit stubs: none of these components consume the hooks.
const unusedHook = (() => { throw new Error('unused by settings-general components') }) as never
type AttentionSnapshot = Parameters<Parameters<GlobalStandardProps['useSessionStatus']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionStatus: GlobalStandardProps['useSessionStatus'] = selector => selector(noAttention)
const kit = {
  useSessions: unusedHook, useSessionStatus,
  usePanelInfo, useSessionRetainInfo: () => undefined, useResource, useWorkspaces: unusedHook,
  ...allowAllAccess,
}

describe('Desktop update badge', () => {
  it('shows update and retry status and yields to connection feedback', () => {
    let state: DesktopUpdateView = { failed: false, opening: false }
    let connection: 'connected' | 'connecting' | 'disconnected' = 'connected'
    const props = { ...kit, t, wide: true,
      useDesktopUpdate: (select => select(state)) as Parameters<typeof DesktopUpdateBadge>[0]['useDesktopUpdate'],
      useConnectionState: (select => select(connection)) as Parameters<typeof DesktopUpdateBadge>[0]['useConnectionState'],
    }
    const view = render(<DesktopUpdateBadge {...props} />)
    expect(screen.queryByRole('img')).toBeNull()
    state = { ...state, presentation: { phase: 'available', version: '1.0.1' } }
    view.rerender(<DesktopUpdateBadge {...props} />)
    expect(screen.getByRole('img', { name: 'Update' })).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    state = { ...state, failed: true }
    view.rerender(<DesktopUpdateBadge {...props} />)
    expect(screen.getByRole('img', { name: en['desktop.update.retry'] })).toBeTruthy()
    state = { failed: true, opening: false }
    view.rerender(<DesktopUpdateBadge {...props} />)
    expect(screen.getByRole('img', { name: en['desktop.update.retry'] })).toBeTruthy()
    state = { failed: false, opening: false, presentation: { phase: 'error', failure: 'install' } }
    view.rerender(<DesktopUpdateBadge {...props} />)
    expect(screen.getByRole('img', { name: en['desktop.update.retry'] })).toBeTruthy()
    for (const value of ['connecting', 'disconnected'] as const) {
      connection = value
      view.rerender(<DesktopUpdateBadge {...props} />)
      expect(screen.queryByRole('img')).toBeNull()
    }
  })
})

describe('chrome content', () => {
  it('TriggerContent renders the icon with the label', () => {
    const { container } = render(<TriggerContent t={t} />)
    expect(container.querySelector('svg')).toBeTruthy()
    expect(screen.getByText('Settings')).toBeTruthy()
  })

  it('HeaderContent and CloseLabel render their translated text', () => {
    render(<HeaderContent {...kit} t={t} />)
    render(<CloseLabel {...kit} t={t} />)
    expect(screen.getByText('Settings')).toBeTruthy()
    expect(screen.getByText('Close')).toBeTruthy()
  })
})

describe('GeneralSection', () => {
  function mount() {
    const renderSlot = vi.fn(
      ((key: string) => <div data-testid={`slot-${key}`} />) as GeneralSectionComponentProps['renderSlot'],
    )
    const props: GeneralSectionComponentProps = { ...kit, renderSlot, close: vi.fn() }
    const view = render(<GeneralSection {...props} />)
    return { view, renderSlot }
  }

  it('renders the item slot as the section body', () => {
    const { renderSlot } = mount()
    expect(renderSlot).toHaveBeenCalledWith('settings.general.item', {})
    expect(screen.getByTestId('slot-settings.general.item')).toBeTruthy()
  })
})

describe('current version', () => {
  it.each([
    ['Current version: 1.2.3-rc.4', en],
    ['当前版本：1.2.3-rc.4', zh],
  ])('renders the localized release label %s', (expected, dictionary) => {
    vi.stubEnv('ONDRA_CLIENT_VERSION', '1.2.3-rc.4')
    const translate: TriggerContentProps['t'] = (key, params) => {
      let text = (dictionary as Record<string, string>)[key] ?? key
      for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
      return text
    }
    render(<CurrentVersionRow {...kit} t={translate} />)
    expect(screen.getByText(expected)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('omits the row when a partial build has no version metadata', () => {
    vi.stubEnv('ONDRA_CLIENT_VERSION', undefined)
    const view = render(<CurrentVersionRow {...kit} t={t} />)
    expect(view.container.textContent).toBe('')
  })
})

describe('Host release change confirmation', () => {
  type Release = { version: string; commit?: string }
  type Change = { page: Release | undefined; previous: Release | undefined; host: Release | undefined } | undefined
  function prompt(change: Change, dictionary: Record<string, string> = en) {
    const dismissRelease = vi.fn()
    const reloadPage = vi.fn()
    const props: HostReleasePromptProps = {
      ...kit,
      t: key => dictionary[key] ?? key,
      useReleaseChange: select => select(change),
      dismissRelease,
      reloadPage,
    }
    return { dismissRelease, reloadPage, view: render(<HostReleasePrompt {...props} />) }
  }

  it('stays hidden while no release change is announced', () => {
    prompt(undefined)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the service and page transitions and either reloads or keeps the page', () => {
    const { dismissRelease, reloadPage } = prompt({
      page: { version: '0.2.1' }, previous: { version: '0.2.2' }, host: { version: '0.2.3', commit: 'abc1234' },
    })
    const dialog = screen.getByRole('dialog', { name: 'Service version changed' })
    // Changed versions show only the versions.
    expect(dialog.textContent).toContain('Service0.2.20.2.3Page0.2.10.2.3')
    expect(dialog.textContent).toContain(en['hostRelease.description'])
    // The dialog opens without a user gesture; initial focus keeps the page.
    expect(document.activeElement?.textContent).toBe('Not now')
    fireEvent.click(screen.getByRole('button', { name: 'Reload to load the new version' }))
    expect(reloadPage).toHaveBeenCalledOnce()
    expect(dismissRelease).not.toHaveBeenCalled()
    const keep = screen.getAllByRole('button', { name: 'Not now' })
    // The footer action and the dialog's close control both keep the page.
    expect(keep).toHaveLength(2)
    for (const button of keep) fireEvent.click(button)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(dismissRelease).toHaveBeenCalledTimes(3)
  })

  it('shows commits for a transition within one version and labels what the Host did not publish', () => {
    prompt({
      page: { version: '0.2.0' },
      previous: { version: '0.2.1', commit: 'aaaaaaa' },
      host: { version: '0.2.1', commit: 'bbbbbbb' },
    })
    expect(screen.getByRole('dialog').textContent).toContain('Serviceaaaaaaabbbbbbb' + 'Page0.2.00.2.1')
    cleanup()
    prompt({ page: { version: '0.2.1' }, previous: { version: '0.2.1' }, host: { version: '0.2.1', commit: 'bbbbbbb' } }, zh)
    expect(screen.getByRole('dialog', { name: '服务版本变化' }).textContent)
      .toContain('服务未解析bbbbbbb页面未解析bbbbbbb')
    cleanup()
    prompt({ page: undefined, previous: undefined, host: { version: '0.2.1' } })
    expect(screen.getByRole('dialog').textContent).toContain('ServiceUnknown0.2.1PageUnknown0.2.1')
    cleanup()
    prompt({ page: { version: '0.2.1' }, previous: { version: '0.2.1' }, host: undefined })
    expect(screen.getByRole('dialog').textContent).toContain('Service0.2.1UnknownPage0.2.1Unknown')
  })
})
