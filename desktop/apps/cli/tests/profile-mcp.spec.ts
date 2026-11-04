/** MCP resource ownership across the resolved shipped profile templates. */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { composeEntries, loadProfile } from '@ntars/ondra-app-boot'
import { PROFILE_TEMPLATES } from '@ntars/ondra-official-bundles'

const installAnchor = fileURLToPath(new URL('../package.json', import.meta.url))
const resourcePackage = '@ntars/ondra-mcp-resources'

describe('shipped MCP resource composition', () => {
  it.each(Object.keys(PROFILE_TEMPLATES))('%s declares one shared, disabled resource consumer and no server', (name) => {
    const home = mkdtempSync(join(tmpdir(), 'ondra-profile-mcp-'))
    try {
      const profile = loadProfile('ondra', name, installAnchor, home)
      const warnings: string[] = []
      const rows = composeEntries([
        ...profile.layers.map(layer => layer.patches),
        profile.patches,
      ], message => warnings.push(message))

      // Ondra ships no MCP surface: the consumer row stays declared (one owner,
      // every mode) but disabled, so no server connects and no resource tab
      // appears. Re-enabling it is a product decision, and this pin notices.
      expect(rows.filter(row => row.name === resourcePackage)).toEqual([
        { id: 'mcp-resources', name: resourcePackage, disabled: true },
      ])
      expect(rows.filter(row => row.name === '@ntars/ondra-mcp-client')).toEqual([])
      expect(warnings).toEqual([])

      const owners = profile.layers.filter((layer) => {
        const manifest = JSON.parse(readFileSync(join(layer.packageDir, 'package.json'), 'utf8')) as {
          dependencies?: Record<string, string>
        }
        return manifest.dependencies?.[resourcePackage] !== undefined
      })
      expect(owners.map(owner => owner.packageName)).toEqual([
        name === 'sdk-minimal' ? '@ntars/ondra-sdk-minimal' : '@ntars/ondra-base',
      ])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
