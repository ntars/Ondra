import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@ntars/cordis'
import Loader from '@ntars/cordis-plugin-loader'
import Include from '@ntars/cordis-plugin-include'
import SessionProjectionRegistry from '@ntars/ondra-session-projection'
import AgentRegistry from '@ntars/ondra-agent'
import type { Agent, AgentStatus } from '@ntars/ondra-agent'
import CommandRuntime from '@ntars/ondra-commands'
import SessionStore, { SessionId } from '@ntars/ondra-session'
import * as CommandFeedback from '@ntars/ondra-command-feedback'
import { getOrCreateAnonymousUserId } from '@ntars/ondra-anonymous-user-id'
import { unsupportedModel, unsupportedInbox } from '@ntars/ondra-agent-loop-testkit'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

/** Register one idle agent over a store-owned session, as an app's spine does. */
async function agent(ctx: Context): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const id = SessionId('feedback-loader-agent')
  const session = ctx.sessions.create(id)
  let status: AgentStatus = 'idle'
  const value: Agent = {
    id,
    options: {},
    session,
    model: unsupportedModel(),
    inbox: unsupportedInbox(),
    ctx: scope.ctx,
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(value)
  return value
}

describe('/feedback real Loader composition through cordis.yml', () => {
  it('boots cordis.yml and records feedback without model-visible output', async () => {
    root = await mkdtemp(join(tmpdir(), 'ondra-command-feedback-loader-'))
    vi.stubEnv('ONDRA_HOME', root)
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@ntars/ondra-session-projection'",
      "- name: '@ntars/ondra-agent'",
      "- name: '@ntars/ondra-session-projection'",
      "- name: '@ntars/ondra-session'",
      "- name: '@ntars/ondra-commands'",
      "- name: '@ntars/ondra-command-feedback'",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@ntars/ondra-session-projection', SessionProjectionRegistry],
      ['@ntars/ondra-agent', AgentRegistry],
      ['@ntars/ondra-session-projection', SessionProjectionRegistry],
      ['@ntars/ondra-session', SessionStore],
      ['@ntars/ondra-commands', CommandRuntime],
      ['@ntars/ondra-command-feedback', CommandFeedback],
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

    // Discoverable through the composed registry, as a UI adapter finds it.
    expect(context.commands.list(owner).map(command => command.name)).toContain('feedback')

    const accepted = await context.commands.execute(owner, '/feedback the diff view is unreadable', [], signal)
    const userId = getOrCreateAnonymousUserId({ env: { ONDRA_HOME: root } })
    expect(accepted?.result).toEqual({
      kind: 'success',
      text: `Feedback recorded for session feedback-loader-agent\nAnonymous user: ${userId}.`,
    })
    const rejected = await context.commands.execute(owner, '/feedback', [], signal)
    expect(rejected?.result).toEqual({
      kind: 'error',
      text: 'Feedback text is required. Usage: /feedback <text>',
    })

    // The domain event owns the payload; generic command bookkeeping omits it.
    expect(owner.session.snapshotEvents().map(event => event.type))
      .toEqual(['command/run', 'feedback/record', 'command/done', 'command/run', 'command/done'])
    const run = owner.session.snapshotEvents().find(event => event.type === 'command/run')
    expect(run?.type === 'command/run' && Object.hasOwn(run.data, 'args')).toBe(false)
    const feedback = owner.session.snapshotEvents().find(event => event.type === 'feedback/record')
    expect(feedback?.type === 'feedback/record' && feedback.data.text).toBe('the diff view is unreadable')
    expect(JSON.stringify(owner.session.snapshotEvents()).match(/the diff view is unreadable/gu)).toHaveLength(1)

    // Nothing reached the model.
    expect(owner.session.deriveMessages()).toEqual([])
    expect(owner.session.surface.nodes).toEqual([])
  })
})
