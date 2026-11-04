import { Context } from '@ntars/cordis'
import Sandbox from '@ntars/ondra-sandbox-local'
import SandboxPolicy from '@ntars/ondra-sandbox-policy'
import SessionProjections from '@ntars/ondra-session-projection'
import { onTestFinished } from 'vitest'
import type { SandboxMode } from '@ntars/ondra-sandbox'

/** Mount the Python runtime's policy and confinement providers with owned teardown. */
export async function createRuntimeContext(policy: { mode?: SandboxMode; workspaceRoot?: string } = {}): Promise<Context> {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', ...policy })
  return ctx
}
