/** Module-HMR ownership across the real shipped profile bundle layers. */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches } from '@ntars/ondra-app-boot'
import type { PatchOptions } from '@ntars/cordis-plugin-include'

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** Load one shipped bundle patch through the same parser as profile boot. */
function bundle(name: 'acp-app' | 'base' | 'headless' | 'sdk-app' | 'sdk-minimal' | 'web-app'): PatchOptions[] {
  return loadOverlayPatches('profile-hmr test', join(REPOSITORY_ROOT, 'packages', 'bundle', name, 'cordis.patch.yml'))
}

/** Resolve the effective HMR row after the supplied layers. */
function hmr(layers: PatchOptions[][]) {
  const row = composeEntries(layers).find(entry => entry.id === 'hmr')
  if (row === undefined) throw new Error('the base bundle must insert the hmr row')
  return row
}

describe('YAML-owned profile HMR', () => {
  // Ondra ships no module hot-swap: the base row declares an empty module-root
  // list and stays disabled, so a packaging build never watches the tree for
  // edits. A later layer (a developer overlay) still turns it on, which the
  // override cases below keep covered.
  it('ships HMR off in the base and web compositions', () => {
    expect(hmr([bundle('base'), bundle('web-app')])).toMatchObject({ disabled: true, config: { root: [] } })
    expect(hmr([bundle('base')]).disabled).toBe(true)
  })

  it.each(['headless', 'sdk-app', 'acp-app'] as const)('%s disables HMR with a bundle override', (mode) => {
    expect(hmr([bundle('base'), bundle(mode)])).toMatchObject({ disabled: true })
    expect(hmr([bundle('base'), bundle(mode), [{ id: 'hmr', disabled: false }]])).toMatchObject({
      disabled: false, config: { root: [] },
    })
  })

  it('selects module roots through a later YAML layer', () => {
    expect(hmr([bundle('base'), [{ id: 'hmr', config: { root: ['.'] } }]])).toMatchObject({
      config: { root: ['.'] },
    })
  })

  it('keeps the standalone sdk-minimal tree free of HMR', () => {
    expect(composeEntries([bundle('sdk-minimal')]).find(entry => entry.id === 'hmr')).toBeUndefined()
  })
})
