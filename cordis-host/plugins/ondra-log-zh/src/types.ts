/**
 * O-004 `ondra-log-zh` 的对外契约。
 *
 * 定位：**中文双层的唯一写入者**。
 * 上层「给人看的中文日志」与下层「给开发的代码日志」都由本插件写；
 * 其他插件只调 `ctx.logger(...)` 或本服务的 `human()`，**不得自己 `appendFileSync`**。
 *
 * 两层怎么分工（这条决定下游怎么写）：
 * - **中文层**：面向用户与支持，只收显式 `human()` 的句子，一条一行、可读；
 * - **代码层**：面向排障，收全仓 `ctx.logger` 的结构化消息（含插件名、级别、时间戳）。
 * 混在一个文件里，用户翻日志的第一屏永远是内部噪声。
 */

/** 本插件注册的服务键（连字符，非 `ondra:log-zh`）。全仓唯一归属。 */
export const LOG_ZH_SERVICE_KEY = 'ondra-log-zh'

/** 日志级别：与 Cordis `LoggerType` 对齐。 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

/** 一条中文日志的入参。 */
export interface HumanEntry {
  /** 级别。`error` / `warn` 会同时进代码层，`info` / `debug` 只进中文层。 */
  readonly level: LogLevel
  /** 一句话，建议不超过 120 字。 */
  readonly message: string
  /** 归属功能短名，例如 `memory.decay`；会拼进代码层。 */
  readonly feature?: string
  /** 附加上下文，序列化成一行 JSON 附在中文层末尾（可选）。 */
  readonly detail?: Record<string, unknown>
}

/** 写盘统计，供体检面板与自检使用。 */
export interface LogStats {
  /** 中文层已写行数（含仅内存模式下的行）。 */
  readonly humanLines: number
  /** 代码层已写行数。 */
  readonly codeLines: number
  /** 因写盘失败而丢弃的行数。 */
  readonly droppedLines: number
  /** 被写放大保护折叠的重复条数（同一错误每秒 1000 条那种）。 */
  readonly suppressedLines: number
  /** 当前是否已降级为仅内存。 */
  readonly memoryOnly: boolean
  /** 中文日志文件绝对路径（仅内存模式下为空串）。 */
  readonly humanPath: string
  /** 代码日志文件绝对路径（仅内存模式下为空串）。 */
  readonly codePath: string
}

/** 日志服务。 */
export interface LogZhService {
  /** 写一条中文日志（按级别决定是否同时进代码层）。 */
  human(entry: HumanEntry): void
  /** 便捷写法：一般信息。 */
  info(message: string, feature?: string): void
  /** 便捷写法：警告。 */
  warn(message: string, feature?: string): void
  /** 便捷写法：错误。 */
  error(message: string, feature?: string): void
  /** 便捷写法：调试。 */
  debug(message: string, detail?: Record<string, unknown>): void
  /** 读统计（现算，不缓存）。 */
  stats(): LogStats
  /**
   * 取中文日志的最近若干行（供界面日志视图）。
   * @param limit 行数上限，默认 200。
   */
  tailHuman(limit?: number): readonly string[]
}
