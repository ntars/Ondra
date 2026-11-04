/**
 * Issue #4573: a profile install of this package sits beside the ondra
 * installation and installs its own copy of `@ntars/ondra-scope`, so two
 * scope module instances coexist in one host process. `ondra-scope` mints its
 * scope-tag symbol per module instance, so the copy's `createScope` writes a
 * tag every host registry ignores: each Agent's MCP tools register in the
 * global tool layer, the first Agent succeeds, and every later Agent's tool
 * synchronization collides.
 *
 * The first case reproduces that install layout and pins the failure. The
 * second pins the shipped layout the peer declaration produces: one instance,
 * two Agents, each with its own browser client.
 *
 * The first case is a characterization of the duplicated package, not a
 * behavior to preserve. Delete it once `ondra-scope` stops depending on module
 * identity (for example a `Symbol.for` tag shared across copies).
 *
 * Run: `pnpm vitest run packages/experimental/browser-use-runtime/tests/host-runtime-duplication.spec.ts`
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@ntars/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@ntars/ondra-agent-loop-testkit'
import BrowserUse from '@ntars/ondra-browser-use'
import { SessionId } from '@ntars/ondra-session'
import type { Agent } from '@ntars/ondra-agent'
import { mountSessionMcp } from '../src/mcp.ts'

const FIXTURE = fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url))
const TOOL = 'mcp__browser-fixture__visit'
const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Composition with the registries a browser provider contributes to. */
async function load(): Promise<{ ctx: Context; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ondra-browser-duplication-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(BrowserUse)
  return { ctx, root }
}

const toolNames = (ctx: Context, agent?: Agent): string[] =>
  ctx.tools.schemas(agent).map(schema => schema.name)

it('rejects a missing working-directory provider before mounting browser resources', () => {
  const ctx = new Context()
  contexts.push(ctx)
  expect(() => { mountSessionMcp(ctx, {
    name: 'browser-fixture', exclusive: false, command: process.execPath, args: [FIXTURE],
  }) }).toThrow('browser-fixture: browser MCP requires a working-directory provider')
  expect(ctx.get('browserUse')).toBeUndefined()
})

it('reproduces the second-Agent failure a profile install causes', async () => {
  const { ctx, root } = await load()
  // What npm installs beside the installation: one second copy of both packages
  // in the profile, so the copy's client resolves the copy's scope module.
  vi.resetModules()
  const profileScope = await import('@ntars/ondra-scope')
  const profileMcpClient = await import('@ntars/ondra-mcp-client')
  ctx.on('agent/created', async ({ agent }) => {
    await profileScope.createScope(ctx, agent).ctx.plugin(profileMcpClient, profileMcpClient.Config({
      transport: 'stdio', serverName: 'browser-fixture', command: process.execPath, args: [FIXTURE, root],
      failOnStartupError: true, reconnect: { enabled: false },
    }))
  }, { prepend: true })

  await ctx.agents.create({ sessionId: SessionId('first'), meta: { cwd: root } })
  expect(toolNames(ctx)).toContain(TOOL)
  await expect(ctx.agents.create({ sessionId: SessionId('second'), meta: { cwd: root } }))
    .rejects.toThrow('mcp-client(browser-fixture): initial connection or tool synchronization failed')
})

it('keeps every Agent browser tool in that Agent scope under the shipped layout', async () => {
  const { ctx, root } = await load()
  await ctx.plugin({
    inject: ['browserUse', 'agents', 'tools', 'systemPrompt'],
    apply(provider: Context) {
      mountSessionMcp(provider, {
        name: 'browser-fixture', exclusive: false, command: process.execPath, args: [FIXTURE, root],
      })
    },
  })

  const first = await ctx.agents.create({ sessionId: SessionId('first'), meta: { cwd: root } })
  const second = await ctx.agents.create({ sessionId: SessionId('second'), meta: { cwd: root } })
  expect(toolNames(ctx)).toEqual([])
  for (const agent of [first.agent, second.agent]) {
    expect(toolNames(ctx, agent)).toContain(TOOL)
  }
})
