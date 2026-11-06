/**
 * 日记的**文件格式层**：纯函数，不碰文件系统、不碰 ctx。
 *
 * 一件事只在这里定义一次：标题长什么样、元信息注释长什么样、怎么读回来、
 * 正文怎么清洗。格式是**长期资产**——用户会把这些 md 带走、丢进别的编辑器、
 * 十年后再打开，所以它必须能自我解释，且解析失败时**退化到「只有正文」**而不是报错。
 *
 * 文件形状（唯一真源）：
 *
 * ```
 * # 11 月 2 日 · 星期日
 *
 * 正文第一段……
 *
 * 正文第二段……
 *
 * ---
 * <!-- ondra-diary v1 day=2026-11-02 source=model chars=312 at=1762042800000 -->
 * ```
 *
 * 元信息用 HTML 注释：Markdown 渲染器会把它藏起来，人读的时候看不到噪声，
 * 机器读的时候一行正则就能取回。刻意**不用 YAML front-matter**——
 * front-matter 在部分编辑器里会被渲染成一张表格，而这段元信息对人不重要。
 */

import { DAY_KEY_RE, META_TAG, META_VERSION } from './types.js'
import type { DiarySource } from './types.js'

/** 星期名。索引即 `Date.getDay()` 的返回值。 */
const WEEKDAY_NAMES: readonly string[] = Object.freeze([
  '星期日',
  '星期一',
  '星期二',
  '星期三',
  '星期四',
  '星期五',
  '星期六',
])

/** 解析出来的正文部分（不含路径等外部信息）。 */
export interface ParsedDoc {
  /** 标题（不带 `#`）。 */
  readonly title: string
  /** 正文。 */
  readonly body: string
  /** 正文来源；老文件没有元信息时为 `model`（不能断言它是模板）。 */
  readonly source: DiarySource
  /** 正文字符数。 */
  readonly chars: number
  /** 生成时刻；没有元信息时为 0，由调用方用文件 mtime 顶替。 */
  readonly generatedAt: number
}

/** 清洗结果。 */
export interface Sanitized {
  /** 清洗后的正文。 */
  readonly text: string
  /** 被剔除的「报数片段」个数（手册 §4.3 内铁律）。 */
  readonly stripped: number
}

/**
 * 自然日键 → 该日本地零点的毫秒时间戳。
 *
 * **只在没有时钟服务时用**（有 `ondra-clock` 时走 `startOfDay()`）。
 * 它按本机时区算，跨时区部署会与产品时区差几小时；这是刻意的降级，
 * 因为「没有时钟就不能写日记」比「日记差几小时」糟得多。
 * @param dayKey `YYYY-MM-DD`。
 */
export function epochOfDayKey(dayKey: string): number {
  const year = Number(dayKey.slice(0, 4))
  const month = Number(dayKey.slice(5, 7))
  const day = Number(dayKey.slice(8, 10))
  return new Date(year, month - 1, day, 0, 0, 0, 0).getTime()
}

/**
 * 毫秒时间戳 → 本机时区的自然日键。**只在没有时钟服务时用**。
 * @param epoch 毫秒时间戳。
 */
export function localDayKey(epoch: number): string {
  const date = new Date(epoch)
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 某天的星期名（按本机时区读该日）。
 * @param dayKey `YYYY-MM-DD`。
 */
export function weekdayNameOf(dayKey: string): string {
  const index = new Date(epochOfDayKey(dayKey)).getDay()
  return WEEKDAY_NAMES[index] ?? ''
}

/**
 * 自然日键前后挪几天。
 *
 * 走**日历分量**（`new Date(y, m - 1, d + delta)`）而不是「减 `delta * 86400000`」：
 * 后者在夏令时切换日会挪出 23 小时或 25 小时，于是「昨天」偶尔变成「前天」。
 * @param dayKey `YYYY-MM-DD`。
 * @param delta 天数，负数往前。
 */
export function shiftDayKey(dayKey: string, delta: number): string {
  const year = Number(dayKey.slice(0, 4))
  const month = Number(dayKey.slice(5, 7))
  const day = Number(dayKey.slice(8, 10))
  const shifted = new Date(year, month - 1, day + delta, 12, 0, 0, 0)
  const outYear = String(shifted.getFullYear()).padStart(4, '0')
  const outMonth = String(shifted.getMonth() + 1).padStart(2, '0')
  const outDay = String(shifted.getDate()).padStart(2, '0')
  return `${outYear}-${outMonth}-${outDay}`
}

/**
 * 标题行。
 *
 * 用「11 月 2 日」而不是 ISO：日记是给人读的，`2026-11-02` 在元信息与文件名里已经有了。
 * @param dayKey `YYYY-MM-DD`。
 */
export function titleOf(dayKey: string): string {
  const month = Number(dayKey.slice(5, 7))
  const day = Number(dayKey.slice(8, 10))
  const weekday = weekdayNameOf(dayKey)
  return `${month} 月 ${day} 日${weekday === '' ? '' : ` · ${weekday}`}`
}

/**
 * 拼一篇完整的日记文件。
 * @param input 内容。
 */
export function buildDoc(input: {
  readonly dayKey: string
  readonly body: string
  readonly source: DiarySource
  readonly generatedAt: number
}): string {
  const body = input.body.trim()
  const meta =
    `<!-- ${META_TAG} v${META_VERSION} day=${input.dayKey} ` +
    `source=${input.source} chars=${body.length} at=${input.generatedAt} -->`
  return `# ${titleOf(input.dayKey)}\n\n${body}\n\n---\n${meta}\n`
}

/**
 * 解析一篇日记文件。**永不抛错**：解析不出来就当「只有正文」。
 * @param text 文件内容。
 * @param fallbackAt 没有元信息时用的生成时刻（一般是文件 mtime）。
 */
export function parseDoc(text: string, fallbackAt: number): ParsedDoc {
  const normalized = text.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')

  // 1. 元信息：文件末尾那行注释。找不到就用兜底值。
  //    元信息里的 `chars` 刻意**不以它为准**：用户在编辑器里改过正文后，那个数字就撒谎了。
  let source: DiarySource = 'model'
  let generatedAt = fallbackAt
  const metaRe = new RegExp(`^<!--\\s*${META_TAG}\\s+v(\\d+)\\s+([^>]*?)-->$`)
  let metaIndex = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? '').trim()
    if (!metaRe.test(line)) continue
    metaIndex = index
    const body = line.replace(metaRe, '$2')
    for (const pair of body.split(/\s+/)) {
      const [key, value] = pair.split('=')
      if (key === 'source' && (value === 'model' || value === 'template')) source = value
      if (key === 'at' && value !== undefined) {
        const parsed = Number(value)
        if (Number.isFinite(parsed) && parsed > 0) generatedAt = parsed
      }
    }
    break
  }

  // 2. 标题：第一个 `# ` 行。没有就空标题，不猜。
  let title = ''
  let bodyStart = 0
  const first = (lines[0] ?? '').trim()
  if (first.startsWith('# ')) {
    title = first.slice(2).trim()
    bodyStart = 1
  }

  // 3. 正文：标题之后到元信息之前，去掉末尾那条 `---` 分隔线。
  const end = metaIndex >= 0 ? metaIndex : lines.length
  const bodyLines = lines.slice(bodyStart, end)
  while (bodyLines.length > 0 && (bodyLines[bodyLines.length - 1] ?? '').trim() === '') bodyLines.pop()
  if (bodyLines.length > 0 && (bodyLines[bodyLines.length - 1] ?? '').trim() === '---') bodyLines.pop()
  const body = bodyLines.join('\n').trim()

  return {
    title,
    body,
    source,
    // 以实际读到的字数计：元信息里的那个数字只在写完那一刻为真。
    chars: body.length,
    generatedAt,
  }
}

/**
 * 剔除正文里的「报数片段」。
 *
 * 手册 §4.3：内感受是隐式的，「你不会给自己打印一串指标」。日记是最容易漏的地方——
 * 它不经过对话链的九步过滤（O-037），所以这道闸必须长在这里。
 *
 * 只处理**维度名紧跟数字**的形态（`情绪值 0.62` / `压力 62%` / `mood: 0.4`），
 * 不动「三点睡」「吃了两碗饭」这类正常叙述——那是生活，不是指标。
 * @param text 原文。
 */
export function stripMetrics(text: string): Sanitized {
  const pattern =
    /(?:情绪|心情|能量|压力|好感|信任|亲密|张力|皮质醇|mood|energy|stress|affection|trust|intimacy|cortisol)(?:值|度|水平)?\s*(?:是|在|为|:|：|=)?\s*\d+(?:\.\d+)?\s*%?/gi
  let stripped = 0
  const cleaned = text
    .replace(pattern, () => {
      stripped += 1
      return ''
    })
    // 挖掉片段后会留下前导标点（「压力 62%，有点喘」→「，有点喘」）。
    // 只收拾**行首**与**句界之后的**那一个逗号，段落中间的标点一律不动。
    .replace(/(^|[。！？…\n])[ \t]*[，、；][ \t]*/g, '$1')
    .replace(/[，、；]{2,}/g, '，')
  return { text: cleaned, stripped }
}

/**
 * 清洗正文：统一换行、收拾空白、按句界截断。
 *
 * 三条刻意保留的行为：
 * 1. **不删空行**：段落是日记的呼吸。
 * 2. **不补标点**：她本来就可以不写句号（§4.2 标点习惯）。
 * 3. 截断**优先落在句界**；一个句界都没有时才硬切，并补一个省略号，
 *    让读者知道「这里被截了」，而不是以为话说完了。
 * @param text 原文。
 * @param maxChars 字数上限。
 */
export function sanitizeBody(text: string, maxChars: number): Sanitized {
  const metrics = stripMetrics(text)
  const normalized = metrics.text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (normalized.length <= maxChars) {
    return { text: normalized, stripped: metrics.stripped }
  }

  const window = normalized.slice(0, maxChars)
  const cut = Math.max(
    window.lastIndexOf('。'),
    window.lastIndexOf('！'),
    window.lastIndexOf('？'),
    window.lastIndexOf('…'),
    window.lastIndexOf('\n'),
  )
  // 与入参 text 同名会冲突，故取别名。
  const cutText = cut >= Math.floor(maxChars * 0.5)
    ? window.slice(0, cut + 1).trim()
    : `${window.trim()}……`
  return { text: cutText, stripped: metrics.stripped }
}

/**
 * 正文是否「够一篇」。
 *
 * 不是判字数够不够漂亮，而是判**它是不是空的**：模型偶尔会返回一句
 * 「好的，我已经写好了。」——那不是日记，走了兜底比留下它好。
 * @param text 正文。
 */
export function looksEmpty(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 12) return true
  return /^(好的|好呀|收到|明白|没问题)[，,。.！!]?$/.test(trimmed)
}

/** 日期键是否可用于落盘（防 `../` 之类的越界名字）。 */
export function isSafeDayKey(value: string): boolean {
  return DAY_KEY_RE.test(value)
}
