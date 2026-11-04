/**
 * The bundle's substance is its patch file: the `ondra.bundle.patch` manifest
 * field must name a real, parseable patch list.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@ntars/cordis-plugin-include'
import { evaluate } from '@ntars/cordis-plugin-loader'

describe('ondra-base bundle', () => {
  it('declares a parseable patch list through the ondra.bundle.patch manifest field', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      ondra?: { bundle?: { patch?: string } }
    }
    expect(manifest.ondra?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.ondra!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    // The base layer is one insert list over the empty profile root.
    const rows = (parsed as { insert?: { id?: string; config?: Record<string, unknown>; disabled?: boolean }[] }[]).flatMap(
      patch => patch.insert ?? [],
    )
    expect(rows.length).toBeGreaterThan(50)
    expect(rows.some(row => row.id === 'agent-loop')).toBe(true)
    // Ondra ships no OTel session upload: the row is absent from the patch on
    // purpose, so no environment variable can turn capture back on. Re-adding
    // the row is a privacy decision, and this assertion is its tripwire.
    expect(rows.filter(row => row.id === 'session-telemetry-otel')).toHaveLength(0)
    expect(rows.find(row => row.id === 'hmr')).toMatchObject({
      config: { root: [] },
    })
    expect(rows.filter(row => row.id === 'subagent-codex')).toHaveLength(0)
    expect(rows.filter(row => row.id === 'subagent-claude-code')).toHaveLength(0)
    expect(rows.find(row => row.id === 'web')?.config).toMatchObject({ fetchProvider: 'http' })
    expect(rows.find(row => row.id === 'web-fetch-http')).toBeDefined()
    expect(rows.find(row => row.id === 'tool-web')?.config).toMatchObject({ fetch: true })
    expect(manifest.dependencies).not.toHaveProperty('@ntars/ondra-subagent-codex')
    expect(manifest.dependencies).not.toHaveProperty('@ntars/ondra-subagent-claude-code')
    expect(manifest.dependencies).toHaveProperty('@ntars/ondra-web-fetch-http')
  })

  it('gates each shell stack by platform with a symmetric disabled expression', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const parsed = yaml.load(
      readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    )
    if (!Array.isArray(parsed)) throw new TypeError('base patch must parse to a patch list')
    const rows = parsed.flatMap((patch): Record<string, unknown>[] =>
      typeof patch === 'object' && patch !== null
        ? (patch as { insert?: Record<string, unknown>[] }).insert ?? []
        : [],
    )
    // Symmetric gating: each stack's executor and tool rows carry the same
    // platform fact, inverted between the bash and pwsh twins, so exactly one
    // shell stack mounts per host. Evaluate with a platform-scoped context
    // (the `with` scope shadows the global `process`) so both outcomes pin on
    // every host.
    for (const [id, win32, linux] of [
      ['bash-sandbox', true, false],
      ['tool-bash', true, false],
      ['pwsh-sandbox', false, true],
      ['tool-pwsh', false, true],
    ] as const) {
      const row = rows.find(candidate => candidate.id === id)
      if (row === undefined) throw new Error(`base patch must mount ${id}`)
      const expression = (row.disabled as { __jsExpr?: string } | undefined)?.__jsExpr
      if (expression === undefined) throw new Error(`${id} must gate on a !!js disabled expression`)
      expect(Boolean(evaluate({ process: { platform: 'win32' } }, expression)), `${id} on win32`).toBe(win32)
      expect(Boolean(evaluate({ process: { platform: 'linux' } }, expression)), `${id} on linux`).toBe(linux)
    }
    // The platform layer folded into these rows: no separate patch file ships.
    expect(existsSync(resolve(root, 'windows.cordis.patch.yml'))).toBe(false)
  })
})
