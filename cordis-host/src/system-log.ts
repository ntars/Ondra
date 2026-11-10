/**
 * 进程内系统日志。
 *
 * ## 为什么是内存环形缓冲，而不是写文件
 *
 * 「系统日志」这一栏要回答的是「这次启动到现在，后台发生了什么」：
 * 插件装载了几个、哪条路由报了错、内核重启过没有。这些问题的时间尺度是
 * **本次运行**，重启之后旧记录的价值只剩考古。
 *
 * 落盘会带来三个必须处理的问题：文件轮转、容量上限、以及「日志文件写了
 * 但界面读不到最新几条」的读写竞态。一个固定容量的数组把这三件事一次消掉。
 * 真正需要长期留档的启动失败仍在 stderr 与壳的应用日志里，那是另一条通路。
 *
 * ## 为什么满了丢最旧的
 *
 * 系统日志的读者是「刚遇到问题时打开抽屉的人」。他关心的是最近发生了什么，
 * 而不是启动第一秒。环形覆盖保证了内存占用恒定，也让最坏情况下的检索
 * 成本可预测——不会出现「聊了三小时，打开日志抽屉卡五秒」。
 */

/** 一条系统日志。 */
export interface SystemLogEntry {
  /** 进程内自增序号。同时用作界面 key，重启后从 1 重新开始。 */
  id: number
  /** 发生时刻，Unix 毫秒。 */
  at: number
  /** 级别。只分三档：信息、警告、错误。 */
  level: 'info' | 'warn' | 'error'
  /** 一行正文。 */
  text: string
}

/**
 * 缓冲容量。
 *
 * 300 条的依据：宿主启动期约产生 20–40 行（插件装载、配置扫描、内核握手），
 * 运行期只在出错或用户操作时写。300 条足以覆盖「启动 + 一整天偶发事件」，
 * 而 300 个短字符串的内存占用不到 100 KB。
 */
const CAPACITY = 300

const buffer: SystemLogEntry[] = []
let sequence = 0

/**
 * 追加一条系统日志。
 *
 * @param level 级别。
 * @param text 正文。写入方负责把变量拼进去，这里不做格式化——格式化规则
 *   一旦集中到这里，调用方就会开始传对象，而这个模块不该认识业务概念。
 */
export function pushSystemLog(level: SystemLogEntry['level'], text: string): void {
  sequence += 1
  buffer.push({ id: sequence, at: Date.now(), level, text })
  // 一次只丢一条：`splice(0, n)` 在极端并发下会多算，而这里每写一条
  // 最多超出一条，判断一次就够。
  if (buffer.length > CAPACITY) buffer.shift()
}

/**
 * 读最近若干条。
 *
 * @param limit 最多返回多少条，默认 200。非法值回落到默认值而不是抛错：
 *   它是查询参数，用户手改 URL 不该让抽屉整块报错。
 * @returns 按时间升序（旧 → 新）。界面只做正序渲染，倒序由 CSS 的
 *   `column-reverse` 或调用方决定——数据层给正序，读起来最不容易错。
 */
export function readSystemLog(limit = 200): SystemLogEntry[] {
  const size = Number.isInteger(limit) && limit > 0 ? Math.min(limit, CAPACITY) : 200
  return buffer.slice(-size)
}

/** 当前缓冲里有多少条。供诊断路由核对「写入方真的在写」。 */
export function systemLogSize(): number {
  return buffer.length
}
