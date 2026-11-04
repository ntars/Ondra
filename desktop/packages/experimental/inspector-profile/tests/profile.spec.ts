/** The optional Developer Tools bundle enables both inspectors, including fetch capture. */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@ntars/cordis-plugin-include'
import * as yaml from 'js-yaml'

describe('Inspector profile bundle', () => {
  it('publishes one layer containing both inspectors and the Statistics view', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      publishConfig: { access: string }
      ondra: { bundle: { patch: string } }
      dependencies: Record<string, string>
    }
    expect(manifest.publishConfig.access).toBe('public')
    expect(manifest.ondra.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toEqual({
      '@ntars/ondra-experimental-client-ui-stats': 'workspace:*',
      '@ntars/ondra-experimental-inspector': 'workspace:*',
      '@ntars/ondra-experimental-session-inspector': 'workspace:*',
    })
    expect(yaml.load(readFileSync(new URL(`../${manifest.ondra.bundle.patch}`, import.meta.url), 'utf8'), {
      schema: entryListSchema,
    })).toEqual([{ insert: [
      {
        id: 'experimental-inspector', name: '@ntars/ondra-experimental-inspector',
        disabled: false, config: { captureFetch: true },
      },
      { id: 'session-inspector', name: '@ntars/ondra-experimental-session-inspector' },
      { id: 'client-ui-stats', name: '@ntars/ondra-experimental-client-ui-stats' },
    ] }])
  })
})
