/**
 * TypeScript client SDK for the Ondra runtime: spawn the
 * same-version `ondra --profile sdk` runtime as a subprocess and drive agent
 * turns over stdio JSON-RPC. `Ondra` is the high-level run API;
 * `HarnessClient` is the lower-level protocol client. A pure library — it
 * registers nothing on a Cordis context; named profiles and ordered patch
 * files customize the runtime process it spawns.
 *
 * @module @ntars/ondra-sdk-client
 */

export { Ondra, HarnessSession, validatedSessionEvent } from './api.ts'
export type { RunOptions } from './api.ts'
export {
  HarnessClient,
  RequestTimeoutError,
  SdkProtocolError,
  TransportClosedError,
} from './client.ts'
export type { NotificationSubscription } from './client.ts'
export { JsonRpcResponseError } from '@ntars/ondra-sdk-protocol'
export type {
  ContentBlock,
  SdkPromptContentBlock,
  SdkUserQuestionAnswer,
  SdkUserQuestionRequest,
  OndraOptions,
  HarnessClientOptions,
  HarnessNotification,
  NotificationFilter,
  RunResult,
} from './types.ts'
