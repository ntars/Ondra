/** Turns on the official endpoint report credential failures on the model request, after the prompt is recorded. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@ntars/cordis'
import LlmRuntime, { createUserMessage } from '@ntars/ondra-llm'
import AgentRegistry from '@ntars/ondra-agent'
import AgentLoop from '@ntars/ondra-agent-loop'
import SessionStore, { SessionId } from '@ntars/ondra-session'
import SessionProjectionRegistry from '@ntars/ondra-session-projection'
import SystemPrompt from '@ntars/ondra-system-prompt'
import ToolRuntime from '@ntars/ondra-tools'
import * as NativeToolExecutor from '@ntars/ondra-tool-executor-native'
import * as DeepSeek from '@ntars/ondra-llm-deepseek-api-key'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('records the prompt and fails the request when the official endpoint has a malformed key', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'invalid\nheader')
  const fetch = vi.spyOn(globalThis, 'fetch')
  const ctx = new Context()
  contexts.push(ctx)
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) {
    await ctx.plugin(plugin)
  }
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(DeepSeek, {})
  const agent = await ctx.agentLoop.create(SessionId('malformed-official-key'), { provider: 'deepseek-official', model: 'deepseek-flash' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  expect(events.map(event => event.type)).toContain('user/message')
  expect(events.find(event => event.type === 'assistant/attempt')?.data).toMatchObject({
    stream: [{ chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_CREDENTIAL' } } } }],
  })
  expect(fetch).not.toHaveBeenCalled()
})
