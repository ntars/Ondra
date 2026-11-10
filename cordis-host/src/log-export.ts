/**
 * 把 cordis 的日志导出到磁盘（`debug.log`）。
 *
 * ## 为什么必须有这个文件
 *
 * `@ntars/cordis` 的 `LoggerService` 在构造时只挂**一个**导出器：把
 * `Message` 推进 `buffer`（上限 1000 条的环形数组）。它**从不落盘、也从不
 * 打到 stdout/stderr**。而本仓的宿主在 `new Context()` 之后从未调用过
 * `ctx.logger.exporter(...)`——于是所有插件通过 `ctx.logger(...)` 打出的
 * `info` / `warn` / `error` 全部进了那个内存数组，进程一退就消失。
 *
 * 症状与本仓反复踩的那一类完全同形：**每一处都是设计好的静默降级**。
 * 举三个真实例子：
 *
 * | 插件里的那一行 | 本该告诉用户什么 |
 * | --- | --- |
 * | 适配器 `log.error('没有 webServer：这个通道完全收不到消息')` | 通道接线断了 |
 * | 适配器 `log.info('飞书通道已打开：路由 /ondra/feishu，上限 4000 字')` | 接线通了、凭据也齐 |
 * | 任何插件 `log.warn('配置条目已丢弃（…）')` | 用户改的设置被回退 |
 *
 * 这三行此前一行都看不到，`debug.log` 里只有宿主自己用 `DebugLog.write()`
 * 显式记的启动 / 配置 / 界面指令。于是「插件为什么不工作」这个问题在
 * 产品里**没有任何一处能回答**，只能靠读源码推断——这正是不该发生的。
 *
 * ## 为什么不用 `ctx.logger.info` 之外的路子
 *
 * 插件的 `log` 对象就是 `ctx.logger(name)` 返回的 `Logger`，它最终只走
 * `service.exporters`。所以唯一的接法就是往 `exporters` 里再加一个。
 * 想「改插件的日志调用」得改 135 个包，而它们的写法本来是对的。
 *
 * ## 为什么不设开关
 *
 * 写的是本机数据目录里的一个文本文件，`tail` 读不到任何网络面；而
 * **不开就没法排查通道 / 配置这类只在运行时才现形的问题**。调试接口
 * （`/api/debug/logs`）仍然受 `debug.enable` 开关约束，两者不是一回事：
 * 这里的「写」永远在，那里的「读」才需要开关。
 *
 * ## 格式
 *
 * ```
 * 2026-11-10T07:12:03.114Z warn  ondra.adapter.feishu 凭据未就绪（appId）：…
 * ```
 *
 * 前面那段时间戳由 `DebugLog.write()` 加，这里只给「级别 + 命名空间 + 正文」。
 * 级别用小写定宽，让 `grep '^.\{24\}error'` 这类筛选能对齐。
 */

import { Logger, type Exporter, type Message } from '@ntars/cordis'

/** 日志落到哪里。与 `DebugLog` 的 `write(line)` 同形，便于直接对接。 */
export interface LogSink {
  /** 记一行（实现方负责加时间戳与限长）。 */
  write(line: string): void
}

/** 安装选项。 */
export interface LogExportOptions {
  /**
   * 是否连 `debug` 级也收。
   *
   * 默认（调试关闭）只收 `info` 及更严重的：插件启动时会打十几行 info，
   * 而 `debug` 级是高频轮询类内容，全收会把 2000 行的环冲掉。
   */
  readonly includeDebug: boolean
  /**
   * 额外屏蔽的命名空间前缀。
   *
   * 用于滤掉框架自身的噪音（若有）。留空即不过滤——**默认不猜**：
   * 屏蔽一条日志的代价是「以后看不见这个子系统说了什么」，必须点名。
   */
  readonly mutePrefixes?: readonly string[]
}

/** 级别的中文/短名。未知类型原样输出，便于发现 cordis 新增的级别。 */
function tagOf(type: Message['type']): string {
  switch (type) {
    case 'error':
      return 'error'
    case 'warn':
      return 'warn '
    case 'info':
      return 'info '
    case 'debug':
      return 'debug'
    default:
      return String(type).padEnd(5).slice(0, 5)
  }
}

/**
 * 挂上落盘导出器。
 *
 * 返回值是 cordis 的 `Disposable`（由 `ctx.effect` 包裹），卸载时自动摘除——
 * 与其余服务一样跟着上下文生命周期走，不需要额外清理。
 *
 * @param ctx 宿主上下文。
 * @param sink 落点（通常是 `DebugLog`）。
 * @param options 选项。
 */
export function installLogExporter(
  ctx: { logger: unknown; effect?: unknown },
  sink: LogSink,
  options: LogExportOptions,
): unknown {
  /*
   * 级别数值与 cordis 的 `LoggerLevel` 一致：ERROR 0 / WARN 1 / INFO 2 / DEBUG 3。
   * `_method` 里的判据是 `if (targetLevel < level) continue`，即「导出器声明的
   * 阈值小于本条级别就跳过」。所以给 2 表示「2 及以上都别给我」（debug=3 被挡），
   * 给 3 表示全收。这里容易反着想，故写死在注释里。
   */
  const threshold = options.includeDebug ? 3 : 2
  const mute = options.mutePrefixes ?? []

  const exporter: Exporter = {
    // 落盘不要 ANSI 转义序列：`sed` / `grep` / 编辑器里都会变成乱码。
    colors: false,
    levels: { default: threshold },
    export: (message: Message): void => {
      if (mute.length > 0 && mute.some((prefix) => message.name.startsWith(prefix))) return
      let text: string
      try {
        // 复用 cordis 自己的格式化：`%s` / `%d` / `%o` 的语义与插件写法一一对应，
        // 自己再实现一遍就会有第二套占位符规则，早迟对不上。
        text = Logger.format(exporter, message)
      } catch {
        // 格式化失败（比如参数里有坏的 getter）不该让调用方那一行日志变成异常。
        text = message.args.map((arg) => String(arg)).join(' ')
      }
      sink.write(`${tagOf(message.type)} ${message.name} ${text}`)
    },
  }

  // `ctx.logger` 是 LoggerService 的可调用实例；`exporter()` 内部走 `ctx.effect`，
  // 因此宿主退出时自动摘除，不必手工 dispose。
  const service = ctx.logger as { exporter?: (value: Exporter) => unknown }
  if (typeof service.exporter !== 'function') {
    /*
     * 走到这里说明 cordis 换了 API。**不抛错**：日志落不了盘是观测能力的缺失，
     * 不该让应用起不来；但必须让人看得见，所以退回 stderr 说一句。
     */
    process.stderr.write('[host] 无法安装日志导出器：ctx.logger.exporter 不存在（cordis 版本变了？）\n')
    return undefined
  }
  return service.exporter(exporter)
}
