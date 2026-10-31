/** Sidebar shell style contracts shared with its slot-owned controls. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/SidebarRoot.module.css', import.meta.url)), 'utf8')

/**
 * Declarations of one exact selector, keyed by property.
 * @param selector - exact selector text.
 * @returns the normalized declarations, or undefined when absent.
 */
function declarations(selector: string): Map<string, string> | undefined {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const [, selectorList = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    const found = new Map<string, string>()
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
    return found
  }
  return undefined
}

describe('SidebarRoot.module.css', () => {
  it('uses a compact navigation gap', () => {
    expect(declarations('.panelList')?.get('gap')).toBe('2px')
  })

  it('shares and cancels the wide shell trailing padding structurally', () => {
    const root = declarations('.root')
    expect(root?.get('--dsh-sidebar-inline-padding')).toBe('8px')
    expect(root?.get('--dsh-sidebar-row-padding')).toBe('12px')
    expect(root?.get('--dsh-sidebar-label-gap')).toBe('6px')
    expect(root?.get('--dsh-sidebar-paint-inset')).toBe('3px')
    expect(root?.get('padding')).toBe('6px var(--dsh-sidebar-inline-padding)')
    expect(declarations('.regionArea')?.get('margin-left')).toBe('-4px')
    expect(declarations('.regionArea')?.get('padding-left')).toBe('4px')
    expect(declarations('.regionArea')?.get('margin-right')).toBe(
      'calc(-1 * var(--dsh-sidebar-inline-padding))',
    )
  })

  it('keeps the reviewed spacing separate from the caption controls', () => {
    expect(declarations('.logoRow')?.get('padding')).toBe('8px 0 8px 8px')
    expect(declarations('.logoRow')?.get('margin-bottom')).toBe('0')
    expect(declarations('.newSession')?.get('margin')).toBe('0 calc(var(--dsh-sidebar-paint-inset) + 1px) 10px')
    expect(declarations('.newSessionContent')?.get('justify-content')).toBe('center')
    expect(declarations('.topStrip')?.get('height')).toBe('52px')
  })

  it('carries no folded-column rules at all', () => {
    // The frame locks the three-column split (AppFrame columns.ts), so this
    // sheet must not regain a rail state: no fold classes, no rail keyframes,
    // no fold transition. Guarding the absence keeps a future refactor from
    // quietly reintroducing a layout the product no longer has.
    expect(css).not.toContain('.collapsed')
    expect(css).not.toContain('.railIn')
    expect(css).not.toContain('.fading')
    expect(css).not.toContain('rail-in')
    expect(css).not.toContain('.toggle')
  })

  it('keeps the persona disc and its two-line name stack snug in the logo row', () => {
    expect(declarations('.brandIdentity')?.get('gap')).toBe('9px')
    expect(declarations('.brandIdentity')?.get('height')).toBe('34px')
    expect(declarations('.brandName')?.get('height')).toBe('34px')
    // The disc is the product fish on a white ground, not a per-persona
    // portrait, because no pack ships one.
    expect(declarations('.personaAvatar')?.get('width')).toBe('28px')
    expect(declarations('.personaAvatar')?.get('height')).toBe('28px')
    expect(declarations('.personaAvatar')?.get('border-radius')).toBe('50%')
    // Name over presence: two lines inside the 34px identity box.
    expect(declarations('.personaName')?.get('font-size')).toBe('15px')
    expect(declarations('.personaName')?.get('line-height')).toBe('17px')
    expect(declarations('.personaName')?.get('white-space')).toBe('nowrap')
    expect(declarations('.personaPresence')?.get('font-size')).toBe('11px')
    expect(declarations('.presenceDot')?.get('border-radius')).toBe('50%')
  })
})
