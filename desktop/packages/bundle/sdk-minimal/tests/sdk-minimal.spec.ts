/** The standalone SDK-minimal bundle's complete declared Cordis tree. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@ntars/cordis-plugin-include'

function packageName(specifier: string): string {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!
}

describe('ondra-sdk-minimal bundle', () => {
  it('declares one standalone allowlisted tree with every row dependency', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      ondra?: { bundle?: { patch?: string } }
    }
    expect(manifest.ondra?.bundle?.patch).toBe('./cordis.patch.yml')
    const patches = yaml.load(
      readFileSync(resolve(root, manifest.ondra!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    ) as Array<{ insert?: Array<{ id?: string; inject?: string[]; name?: string; config?: Record<string, unknown>; disabled?: unknown }> }>
    expect(patches).toHaveLength(1)
    const rows = patches[0]?.insert ?? []
    expect(rows.map(row => [row.id, row.name])).toEqual([
      ['sdk-app-startup', '@ntars/ondra-sdk-app'],
      ['sdk-jsonrpc-server', '@ntars/ondra-sdk-jsonrpc-server'],
      ['deepseek-llm-api-extensions', '@ntars/ondra-deepseek-llm-api-extensions'],
      ['session-log-deepseek', '@ntars/ondra-session-log-deepseek'],
      ['plugin-package-inventory-deepseek', '@ntars/ondra-plugin-package-inventory-deepseek'],
      ['llm-deepseek', '@ntars/ondra-llm-deepseek-api-key'],
      ['sandbox', '@ntars/ondra-sandbox-local'],
      ['filesystem', '@ntars/ondra-fs-local'],
      ['attachment-local', '@ntars/ondra-attachment-local'],
      ['tool-fs', '@ntars/ondra-tool-fs'],
      ['working-directory', '@ntars/ondra-working-directory'],
      ['tool-working-directory', '@ntars/ondra-tool-working-directory'],
      ['session-projection', '@ntars/ondra-session-projection'],
      ['token-meter', '@ntars/ondra-token-meter'],
      ['compaction-basic', '@ntars/ondra-compaction-basic'],
      ['image-offload', '@ntars/ondra-compaction-image-offload'],
      ['sandbox-policy', '@ntars/ondra-sandbox-policy'],
      ['subprocess', '@ntars/ondra-subprocess-local'],
      ['pty', '@ntars/ondra-terminal'],
      ['terminal-bash', '@ntars/ondra-terminal-bash'],
      ['terminal-pwsh', '@ntars/ondra-terminal-bash'],
      ['timer', '@ntars/cordis-plugin-timer'],
      ['llm', '@ntars/ondra-llm'],
      ['session', '@ntars/ondra-session'],
      ['session-title', '@ntars/ondra-session-title'],
      ['system-prompt', '@ntars/ondra-system-prompt'],
      ['tools', '@ntars/ondra-tools'],
      ['tool-executor-native', '@ntars/ondra-tool-executor-native'],
      ['mcp-resources', '@ntars/ondra-mcp-resources'],
      ['agent', '@ntars/ondra-agent'],
      ['llm-retry', '@ntars/ondra-llm-retry'],
      ['jobs', '@ntars/ondra-jobs-local'],
      ['agent-loop', '@ntars/ondra-agent-loop'],
      ['persistent-bash', '@ntars/ondra-tool-bash-persistent'],
      ['persistent-pwsh', '@ntars/ondra-tool-pwsh-persistent'],
      ['sessions', '@ntars/ondra-session-persistence-jsonl'],
      ['session-checkpoint-policy', '@ntars/ondra-session-checkpoint-policy'],
    ])
    expect(rows.find(row => row.id === 'sdk-app-startup')?.config).toEqual({ profile: 'sdk-minimal' })
    expect(rows.find(row => row.id === 'sdk-jsonrpc-server')).toMatchObject({
      inject: ['sdkAppStartup', 'loader'],
      config: { maxTokensAsSuccess: false },
    })
    expect(rows.find(row => row.id === 'llm-deepseek')?.config).toEqual({
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      defaultContextWindow: { __jsExpr: 'Number(process.env.ONDRA_CONTEXT_WINDOW ?? 1000000)' },
      streamIdleTimeoutMs: 172800000,
    })
    expect(rows.find(row => row.id === 'system-prompt')?.config).toEqual({
      includeProductIdentity: false,
      includeRuntimeContext: false,
      personaPrefix: { __jsExpr: "process.env.ONDRA_SYSTEM_PROMPT ?? 'You are a helpful software engineer assistant.'" },
    })
    expect(rows.find(row => row.id === 'agent-loop')?.config).toEqual({ agents: [] })
    expect(rows.find(row => row.id === 'tool-fs')?.config).toEqual({ read: false, readImage: true, write: false, edit: false })
    expect(rows.find(row => row.id === 'compaction-basic')?.config).toBeUndefined()
    expect(rows.find(row => row.id === 'terminal-bash')).toMatchObject({
      disabled: { __jsExpr: "process.platform === 'win32'" },
    })
    expect(rows.find(row => row.id === 'terminal-pwsh')).toMatchObject({
      disabled: { __jsExpr: "process.platform !== 'win32'" },
      config: { shellDialect: 'pwsh', timeoutMs: 300000 },
    })
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(
      [...new Set(rows.map(row => row.name).filter((name): name is string => name !== undefined).map(packageName))].sort(),
    )
  })
})
