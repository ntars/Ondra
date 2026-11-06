/**
 * 服务实现：把三件能力挂到一个服务键上，**本体零状态**。
 *
 * 三件能力的位置，正好对应适配器收到一条消息之后的三个动作：
 *
 * ```
 * 收到消息 → history().push()        记一句（本通道自己的 12 条）
 *          → callPersona()            问一次（走对话链）
 *          → chunk(text, 平台上限)     切条（平台允许多长）
 *          → 发出去（适配器自己的事）
 * ```
 *
 * 这里刻意**没有任何 Map / Set / 数组字段**：三件能力的实例全由调用方持有。
 * 唯一的两个常量（`peerHistoryLimit`）是只读配置值。
 */

import { callPersona } from './call.js'
import type { CallDeps } from './call.js'
import { chunkText } from './chunk.js'
import { PeerHistoryBuffer } from './history.js'
import type { Config } from './settings.js'
import type {
  CallInput,
  CallResult,
  ChannelKitService,
  ChunkResult,
  DialogueLike,
  KitUnavailableReason,
  LogLike,
  PeerHistory,
} from './types.js'
import { PEER_HISTORY_LIMIT } from './types.js'

/** 构造依赖。 */
export interface KitDeps {
  /** 已补全的配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 现取对话链。 */
  readonly dialogue: () => DialogueLike | undefined
}

/** 服务实现。 */
export class ChannelKit implements ChannelKitService {
  private readonly deps: CallDeps

  /** 对端历史上限（恒为 12）。 */
  readonly peerHistoryLimit: number = PEER_HISTORY_LIMIT

  constructor(deps: KitDeps) {
    this.deps = { settings: deps.settings, log: deps.log, dialogue: deps.dialogue }
  }

  /** 是否启用（只看配置开关）。 */
  get available(): boolean {
    return this.deps.settings.enable
  }

  /** 不可用原因。 */
  get reason(): KitUnavailableReason | undefined {
    return this.deps.settings.enable ? undefined : 'disabled'
  }

  /** 造一份对端历史（每次新的，实例归调用方）。 */
  history(options?: { readonly capacity?: number }): PeerHistory {
    return new PeerHistoryBuffer(options?.capacity ?? this.deps.settings.maxPeerHistory)
  }

  /** 按平台上限切条。 */
  chunk(text: string, max: number): ChunkResult {
    return chunkText(text, max)
  }

  /** 问一次人格。 */
  callPersona(input: CallInput): Promise<CallResult> {
    return callPersona(this.deps, input)
  }
}
