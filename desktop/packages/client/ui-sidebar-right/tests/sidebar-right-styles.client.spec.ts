/** Right sidebar style contracts: one permanent column, no states to animate. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/shell/SidebarRight.module.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')

describe('SidebarRight.module.css', () => {
  it('declares no closed position and no opening animation', () => {
    expect(css).not.toMatch(/translateX/)
    expect(css).not.toMatch(/@starting-style/)
  })

  it('declares no presentation variant: the panel has one layer and one width', () => {
    expect(css).not.toMatch(/data-sidebar-right-panel=/)
    expect(css).not.toMatch(/data-sidebar-right-opening/)
    expect(css).toMatch(/\.panel \{[\s\S]*?--dsh-dockkit-dock-layer: 10;/)
  })
})
