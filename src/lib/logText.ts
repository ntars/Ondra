/**
 * 日志说人话：工具名、工具主体、时长口径。
 *
 * ## 这一个文件只做「翻译」，不做渲染
 *
 * 三条规矩，来自上一版的实践：
 *
 * 1. **工具名说人话**。读日志的人不需要知道 `bash` 是什么，他需要知道
 *    「跑了个命令」。表里没有的工具保留原名——一个这个版本没见过的工具
 *    仍然是她真的拿起来用了的东西，改名就是日志在猜。
 * 2. **工具主体要指出来**。只写「读了个文件」而不说是哪个文件，等于没写。
 *    参数里最像宾语的那个键优先，路径只留尾名（列已经说了她在哪）。
 * 3. **时长只说一次**。回复与轮次的时长已经写在句子里（「想了 1.2 秒」），
 *    再在行尾挂一个数字就是把同一件事说两遍。只有工具没有这样的句子，
 *    所以独立时长只属于工具行。
 *
 * 全部是纯函数：输入字符串，输出字符串。没有 React、没有请求，
 * 因此可以单独验证，也方便将来给导出或第二视图复用。
 */

/**
 * 工具名 → 人话动词。
 *
 * 键一律小写。同义词合并到同一个动词（`bash` / `shell` / `terminal`
 * 都是「执行命令」），因为对读者来说它们是同一件事。
 */
const TOOL_VERBS: Readonly<Record<string, string>> = Object.freeze({
  bash: '执行命令',
  shell: '执行命令',
  terminal: '执行命令',
  exec: '执行命令',
  read: '读取文件',
  readfile: '读取文件',
  write: '写入文件',
  writefile: '写入文件',
  create: '写入文件',
  edit: '修改文件',
  multiedit: '修改文件',
  applypatch: '修改文件',
  patch: '修改文件',
  glob: '查找文件',
  grep: '查找文件',
  search: '查找文件',
  filesearch: '查找文件',
  list: '列出目录',
  ls: '列出目录',
  websearch: '检索网络',
  webfetch: '检索网络',
  fetch: '检索网络',
  browse: '打开网页',
  task: '交由子代理',
  agent: '交由子代理',
  subagent: '交由子代理',
})

/**
 * 把线上工具名翻成读者能跟上的动词。
 *
 * @param name 线上工具名，可能为空。
 * @returns 动词；空名给「调用工具」，认不出的原名照旧。
 */
export function plainToolName(name: string): string {
  const key = name.trim().toLowerCase()
  if (key === '') return '调用工具'
  return TOOL_VERBS[key] ?? name.trim()
}

/**
 * 参数里「最像宾语」的键，按优先级排列。
 *
 * 前四个是路径（只留尾名），其余原样显示。顺序即优先级：
 * 一次调用同时带 `command` 与 `description` 时，读者更想知道跑了什么命令。
 */
const SUBJECT_KEYS: readonly string[] = Object.freeze([
  'file_path', 'filePath', 'path', 'notebook_path',
  'command', 'pattern', 'query', 'url', 'description', 'prompt',
])

/** 路径类键：显示尾名，不显示整条路径。 */
const PATH_KEYS: ReadonlySet<string> = new Set(['file_path', 'filePath', 'path', 'notebook_path'])

/** 主体最长多少个字。再长就是载荷转储，不是日志行。 */
const SUBJECT_MAX = 64

/**
 * 从工具参数里取出「她在对什么动手」。
 *
 * 参数在线上是一个 JSON 字符串，所有失败（坏 JSON、不是对象、没有已知键）
 * 都退回「没有可指出的主体」，而不是让整列日志渲染不出来。
 *
 * @param raw 参数载荷，形状未知。
 * @returns 主体一句话；没有则 null。
 */
export function toolSubject(raw: unknown): string | null {
  let args: unknown = raw
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text === '') return null
    try {
      args = JSON.parse(text) as unknown
    } catch {
      return null
    }
  }
  if (typeof args !== 'object' || args === null) return null

  for (const key of SUBJECT_KEYS) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value !== 'string') continue
    const trimmed = value.trim().replace(/\s+/gu, ' ')
    if (trimmed === '') continue
    /* 路径只留尾名：日志列已经说了她在哪个目录里干活。 */
    const shown = PATH_KEYS.has(key) ? (trimmed.split(/[\\/]/u).at(-1) ?? trimmed) : trimmed
    const points = [...shown]
    return points.length > SUBJECT_MAX ? `${points.slice(0, SUBJECT_MAX).join('')}…` : shown
  }
  return null
}

/**
 * 一行工具的完整叙述：动词 + 主体。
 *
 * @param name 工具名。
 * @param subject 已经提取好的主体，或 null。
 * @returns 例如「读取文件 · useAppState.ts」。
 */
export function toolLine(name: string, subject: string | null): string {
  const verb = plainToolName(name)
  return subject === null ? verb : `${verb} · ${subject}`
}

/**
 * 毫秒 → 一个给人看的秒数。
 *
 * 一位小数就够：差 0.1 秒人感知不到，写两位反而显得精密过头。
 * 超过一分钟换成「分 秒」——`83.4s` 需要读者自己算，而 `1 分 23 秒`
 * 不用。
 *
 * @param ms 毫秒，负数与 NaN 都视为「没有读数」。
 * @returns 例如 `1.2s` / `1 分 23 秒`；无读数返回 null。
 */
export function toolDuration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  return `${String(minutes)} 分 ${String(rest)} 秒`
}

/**
 * 轮次与回复的时长要写进句子里，不挂在行尾。
 *
 * @param ms 毫秒。
 * @returns 「想了 10.1 秒」里的那半句；无读数时返回 null。
 */
export function spokenDuration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null
  const seconds = ms / 1000
  return `${seconds.toFixed(1)} 秒`
}
