/** MCP resource ownership in the shipped Desktop composition. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { composeEntries, loadProfileDirectory } from '@ntars/ondra-app-boot'
import { createPluginProfile } from '../src/project-manager.ts'

it('retains one shared resource consumer in the Desktop Web profile', () => {
  const home = mkdtempSync(join(tmpdir(), 'ondra-desktop-profile-mcp-'))
  try {
    const profileDir = join(home, 'profiles', 'desktop')
    createPluginProfile(profileDir)
    const installAnchor = fileURLToPath(new URL('../../cli/package.json', import.meta.url))
    const profile = loadProfileDirectory('ondra desktop', profileDir, installAnchor)
    const warnings: string[] = []
    const rows = composeEntries([
      ...profile.layers.map(layer => layer.patches),
      profile.patches,
    ], message => warnings.push(message))

    expect(rows.filter(row => row.name === '@ntars/ondra-mcp-resources')).toEqual([
      { id: 'mcp-resources', name: '@ntars/ondra-mcp-resources' },
    ])
    expect(rows.filter(row => row.name === '@ntars/ondra-mcp-client')).toEqual([])
    expect(rows.find(row => row.id === 'webserver')).toMatchObject({ name: '@ntars/ondra-host-webserver' })
    expect(rows.find(row => row.id === 'webserver')?.disabled).not.toBe(true)
    expect(warnings).toEqual([])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
