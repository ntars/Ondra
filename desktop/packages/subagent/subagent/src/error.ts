/**
 * Typed failures shared by subagent service and provider operations.
 *
 * @module @ntars/ondra-subagent
 */

import { HarnessError } from '@ntars/ondra-llm'

/** Typed failure for the subagent seam. */
export class SubagentError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'SubagentError'
  }
}
