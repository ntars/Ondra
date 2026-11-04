/** Shipped profile templates, and the offline catalog that does not depend on installed provider packages or registry requests. */

import { describe, expect, it } from 'vitest'
import { OFFICIAL_ON_DEMAND_CATALOG, ON_DEMAND_BUNDLES, PROFILE_TEMPLATES } from '../src/index.ts'

describe('Official on-demand catalog', () => {
  it('offers exactly the two native subagent integrations with offline localized metadata', () => {
    expect(ON_DEMAND_BUNDLES).toEqual(['@ntars/ondra-subagent-claude-code', '@ntars/ondra-subagent-codex'])
    expect(OFFICIAL_ON_DEMAND_CATALOG.map(entry => entry.packageName)).toEqual(ON_DEMAND_BUNDLES)
    for (const entry of OFFICIAL_ON_DEMAND_CATALOG) {
      expect(entry.meta.icon).toMatch(/^data:image\/svg\+xml;base64,/)
      for (const text of [entry.meta.title, entry.meta.description]) {
        if (typeof text === 'string') throw new Error('Official metadata requires both shipped languages')
        expect(text.en).toMatch(/\S/)
        expect(text.zh).toMatch(/\S/)
      }
      expect(entry).not.toHaveProperty('version')
    }
  })
})

describe('Shipped profile templates', () => {
  it('stack each mode bundle on base except the standalone minimal SDK', () => {
    expect(PROFILE_TEMPLATES).toEqual({
      acp: { bundles: ['@ntars/ondra-base', '@ntars/ondra-acp-app'] },
      web: { bundles: ['@ntars/ondra-base', '@ntars/ondra-web-app'] },
      headless: { bundles: ['@ntars/ondra-base', '@ntars/ondra-headless'] },
      sdk: { bundles: ['@ntars/ondra-base', '@ntars/ondra-sdk-app'] },
      'sdk-minimal': { bundles: ['@ntars/ondra-sdk-minimal'] },
    })
  })
})
