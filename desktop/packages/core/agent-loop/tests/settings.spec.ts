/** The `agent-loop` settings section layered over the composition entry. */

import * as NativeToolExecutor from '@ntars/ondra-tool-executor-native'
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@ntars/cordis'
import LlmRuntime from '@ntars/ondra-llm'
import SessionStore from '@ntars/ondra-session'
import SystemPrompt from '@ntars/ondra-system-prompt'
import ToolRuntime from '@ntars/ondra-tools'
import AgentRegistry from '@ntars/ondra-agent'
import SessionProjectionRegistry from '@ntars/ondra-session-projection'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import AgentLoop from '@ntars/ondra-agent-loop'

async function boot(maxParallelToolCalls?: number) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(NativeToolExecutor)
  const live = await liveConfig(ctx, AgentLoop, { agents: [], ...maxParallelToolCalls === undefined ? {} : { maxParallelToolCalls } })
  return { ctx, live }

}

it('updates future scheduler budgets while preserving composed agents and the running loop', async () => {
  const { ctx, live } = await boot(4)
  const before = live.fiber
  await live.update({ maxParallelToolCalls: 1 })
  expect(live.entry.fiber === before).toBe(true)
  expect(ctx.agentLoop.config.maxParallelToolCalls.get()).toBe(1)
  expect(ctx.agentLoop.config.agents).toEqual([])
  await expect(live.update({ maxParallelToolCalls: 0 })).rejects.toThrow()
  expect(ctx.agentLoop.config.maxParallelToolCalls.get()).toBe(1)
})

it('defaults to ten and restores that default without remounting the loop', async () => {
  const { ctx, live } = await boot()
  const loop = ctx.agentLoop
  expect(loop.config.maxParallelToolCalls.get()).toBe(10)
  await live.update({ maxParallelToolCalls: 2 })
  expect(loop.config.maxParallelToolCalls.get()).toBe(2)
  await expect(live.update({ maxParallelToolCalls: 0 })).rejects.toThrow()
  await expect(live.update({ maxParallelToolCalls: 1.5 })).rejects.toThrow()
  expect(loop.config.maxParallelToolCalls.get()).toBe(2)
  await live.replace({ agents: [] })
  expect(loop.config.maxParallelToolCalls.get()).toBe(10)
  expect(ctx.agentLoop.config.maxParallelToolCalls.get()).toBe(10)
  expect(live.entry.fiber === live.fiber).toBe(true)
})
