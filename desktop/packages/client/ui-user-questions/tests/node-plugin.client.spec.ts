import * as NativeToolExecutor from '@ntars/ondra-tool-executor-native'
import { Context } from '@ntars/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import ToolRuntime from '@ntars/ondra-tools'
import SystemPrompt from '@ntars/ondra-system-prompt'
import UserQuestionService from '@ntars/ondra-user-questions'
import { apply } from '../src/index.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

describe('ui-user-questions node plugin', () => {
  it('mounts no model-facing tool', async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(UserQuestionService)

    await ctx.plugin({ apply }).await()

    // Host UI registration must leave each preset's model-facing tool list intact.
    expect(ctx.tools.get('ask_user_question')).toBeUndefined()
  })
})
