import { executeToolFixture } from '@ntars/ondra-tool-testkit'
import * as NativeToolExecutor from '@ntars/ondra-tool-executor-native'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { unsupportedModel, provideWorkingDirectoryFixture, unsupportedInbox } from '@ntars/ondra-agent-loop-testkit'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@ntars/cordis'
import Loader from '@ntars/cordis-plugin-loader'
import Include from '@ntars/cordis-plugin-include'
import { ToolCallId } from '@ntars/ondra-llm'
import { Session, SessionId } from '@ntars/ondra-session'
import AgentRegistry from '@ntars/ondra-agent'
import type { Agent } from '@ntars/ondra-agent'
import SystemPrompt from '@ntars/ondra-system-prompt'
import ToolRuntime from '@ntars/ondra-tools'
import TerminalSessionService from '@ntars/ondra-terminal'
import SandboxProvider from '@ntars/ondra-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@ntars/ondra-sandbox'
import SandboxPolicyService from '@ntars/ondra-sandbox-policy'
import SessionProjectionRegistry from '@ntars/ondra-session-projection'
import LocalSubprocessRuntime from '@ntars/ondra-subprocess-local'
import * as TerminalLocal from '@ntars/ondra-terminal-bash'
import * as ToolPty from '@ntars/ondra-tool-terminal'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

class PassthroughSandbox extends SandboxProvider {
  async confine(argv: readonly string[], _policy: SandboxPolicy): Promise<ConfinedArgv> {
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

async function agent(ctx: Context): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const id = SessionId('pty-loader-agent')
  const session = Session.create(id)
  const value: Agent = {
    id, options: {}, session, model: unsupportedModel(),
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(value)
  return value
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

const suite = process.platform === 'linux' || process.platform === 'darwin' ? describe : describe.skip

suite('terminal real Loader composition through cordis.yml', () => {
  it('boots cordis.yml and preserves shell state across real tool calls', async () => {
    root = await mkdtemp(join(tmpdir(), 'ondra-pty-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@ntars/ondra-agent'",
      "- name: '@ntars/ondra-system-prompt'",
      "- name: '@ntars/ondra-tools'",
      "- name: '@ntars/ondra-tool-executor-native'",
      "- name: '@ntars/ondra-terminal'",
      "- name: '@ntars/ondra-test-sandbox'",
      "- name: '@ntars/ondra-session-projection'",
      "- name: '@ntars/ondra-sandbox-policy'",
      '  config:',
      '    mode: danger-full-access',
      `    workspaceRoot: ${JSON.stringify(root)}`,
      "- name: '@ntars/ondra-subprocess-local'",
      "- name: '@ntars/ondra-terminal-bash'",
      '  config:',
      '    pollIntervalMs: 10',
      '    exactProbeAfterMs: 20',
      '    idleSilenceMs: 250',
      '    handoffGraceMs: 250',
      '    timeoutMs: 2000',
      '    disposeGraceMs: 500',
      "- name: '@ntars/ondra-tool-terminal'",
      '',
    ].join('\n'))

    context = new Context()

    provideWorkingDirectoryFixture(context)
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@ntars/ondra-agent', AgentRegistry],
      ['@ntars/ondra-system-prompt', SystemPrompt],
      ['@ntars/ondra-tools', ToolRuntime],
      ['@ntars/ondra-tool-executor-native', NativeToolExecutor],
      ['@ntars/ondra-terminal', TerminalSessionService],
      ['@ntars/ondra-test-sandbox', PassthroughSandbox],
      ['@ntars/ondra-session-projection', SessionProjectionRegistry],
      ['@ntars/ondra-sandbox-policy', SandboxPolicyService],
      ['@ntars/ondra-subprocess-local', LocalSubprocessRuntime],
      ['@ntars/ondra-terminal-bash', TerminalLocal],
      ['@ntars/ondra-tool-terminal', ToolPty],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const owner = await agent(context)
    const signal = new AbortController().signal
    const spawn = await executeToolFixture(context, {
      signal, callId: ToolCallId('spawn'), name: 'terminal_open', arguments: { type: 'shell', name: 'main', cwd: root }, agent: owner,
    })
    expect(resultText(spawn)).toContain('started terminal session pty-1 (main)')

    await executeToolFixture(context, {
      signal, callId: ToolCallId('state'), name: 'terminal_send', arguments: { sessionId: 'pty-1', text: 'export KEEP=loader; cd /' }, agent: owner,
    })
    const read = await executeToolFixture(context, {
      signal, callId: ToolCallId('read'), name: 'terminal_send', arguments: { sessionId: 'pty-1', text: 'printf "cwd=%s keep=%s\\n" "$PWD" "$KEEP"' }, agent: owner,
    })
    expect(resultText(read)).toContain('cwd=/ keep=loader')
    expect(context.terminals.list(owner)).toHaveLength(1)
  }, 15_000)
})
