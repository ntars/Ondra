/**
 * 文本层的**纯函数**：只碰字符串，不碰 ctx、不碰时钟、不碰随机源。
 *
 * 之所以全部抽出来：口语化塑形是「每一轮都要跑」的路径，一旦这里掺了状态，
 * 同一个输入两次跑出不同结果，就再也说不清「她这句话为什么少了主语」。
 * 随机由调用方传 `rng` 进来，本文件只负责「给定随机数，怎么改」。
 *
 * ## 三条自我约束
 *
 * 1. **只减语气词，不造语气词。** 人设包里有「语气词只有这些」的白名单，
 *    自造一个词会当场破坏人设约束。`rich` 档本插件一个字都不加。
 *
 * 2. **省略结尾只省收尾语气词。** 砍最后一个短句会丢内容，那是「删」，
 *    归 O-037；本插件只做「话说一半」的形态。
 *
 * 3. **标点替换永远不新增句子。** 只换句末那一个符号。
 */

/** 句末标点集合。`…` 单字也算（`……` 是两个字符）。 */
const SENTENCE_TAIL = new Set(['。', '！', '？', '…', '～', '!', '?', '~', '.'])

/**
 * 中文句末语气词。
 *
 * 这是**语言事实**（《现代汉语》里的语气助词表），不是人设语料——
 * 只用它做减法，所以不需要人设包授权。加词仍然归模型。
 */
export const PARTICLES: readonly string[] = Object.freeze([
  '呢',
  '吧',
  '呀',
  '啊',
  '哦',
  '嘛',
  '啦',
  '咯',
  '喔',
  '诶',
  '欸',
  '哟',
])

/**
 * 不能省掉主语的固定搭配首字。
 *
 * 「你好」「我是」「他早」——人称在这里不是主语，是词的一部分。
 * 去掉会得到「好」「是学生」这种半句话，而它看起来像「不完整句」，
 * 于是没人会怀疑是这里出的错。
 */
const GREETING_HEADS = new Set(['好', '早', '晚', '再', '是', '们'])

/** 可省的主语。**长的在前**，否则「我们」会被「我」先吃掉一个字。 */
const SUBJECTS: readonly string[] = Object.freeze([
  '我们',
  '你们',
  '他们',
  '她们',
  '它们',
  '咱们',
  '我',
  '你',
  '他',
  '她',
  '它',
])

/** 字数（去空白，按码点算，emoji 不会算成两个字）。 */
export function countChars(text: string): number {
  return Array.from(text.replace(/\s+/g, '')).length
}

/**
 * 把句末标点切出来。
 *
 * `"好累。"` → `{ body: '好累', tail: '。' }`。
 * 之所以要切开：插口头禅要插在**标点之前**（「好累，对吧。」），
 * 而不是标点之后（「好累。对吧」）。
 * @param text 原文。
 */
export function splitTail(text: string): { body: string; tail: string } {
  let end = text.length
  while (end > 0 && SENTENCE_TAIL.has(text[end - 1])) end -= 1
  return { body: text.slice(0, end), tail: text.slice(end) }
}

/**
 * 语气词瘦身。
 * @param text 原文。
 * @param keep 句末最多保留几个语气词（0 = 全去）。
 */
export function trimParticles(text: string, keep: number): { text: string; removed: number } {
  const { body, tail } = splitTail(text)
  // 先数出句末连续语气词有几个（语气词是连着的，中间夹内容词就断）。
  let run = 0
  while (run < body.length && PARTICLES.includes(body[body.length - 1 - run])) run += 1
  if (run <= keep) return { text, removed: 0 }
  const cut = run - keep
  const start = body.length - run
  // 从这一串的**前面**删：留最靠近标点的那几个（「好呀呀呀」留 1 个 → 「好呀」）。
  const nextBody = body.slice(0, start) + body.slice(start + cut)
  return { text: nextBody + tail, removed: cut }
}

/**
 * 去掉句末句号（手册 §4.2「不用句号结尾」）。
 * 只去 `。`：`！` 与 `？` 带语气，去掉了意思就变了。
 * @param text 原文。
 */
export function dropFinalPeriod(text: string): string {
  const { body, tail } = splitTail(text)
  if (!tail.includes('。')) return text
  return body + tail.replace(/。+/g, '')
}

/**
 * 连续问号表疑惑（手册 §4.2）。
 * 已经是 `？？` 的不再叠加——三个问号读起来像质问。
 * @param text 原文。
 */
export function doubleQuestion(text: string): string {
  if (text.endsWith('？')) return text.endsWith('？？') ? text : text + '？'
  if (text.endsWith('?')) return text.endsWith('??') ? text : text + '?'
  return text
}

/**
 * 省略号表犹豫（手册 §4.2）。
 * 只在句末是 `。` 或没有标点时动手；`？`/`！` 不动（疑问与感叹不是犹豫）。
 * @param text 原文。
 */
export function hesitate(text: string): string {
  const { body, tail } = splitTail(text)
  if (tail === '') return text + '……'
  if (tail.includes('。') && !tail.includes('？') && !tail.includes('！')) {
    return body + tail.replace(/。+/g, '……')
  }
  return text
}

/**
 * 省略主语。
 * @param text 原文。
 * @returns 改后的文本；不适用时 `undefined`（**不硬做**）。
 */
export function dropSubject(text: string): string | undefined {
  const hit = SUBJECTS.find(item => text.startsWith(item))
  if (hit === undefined) return undefined
  const rest = text.slice(hit.length)
  if (countChars(rest) < 2) return undefined
  const head = rest.charAt(0)
  if (GREETING_HEADS.has(head)) return undefined
  return rest
}

/**
 * 省略结尾（只省收尾语气词）。
 * @param text 原文。
 * @returns 改后的文本；没有收尾语气词时 `undefined`。
 */
export function trimEnding(text: string): string | undefined {
  const { body, tail } = splitTail(text)
  let end = body.length
  while (end > 0 && PARTICLES.includes(body[end - 1])) end -= 1
  if (end === body.length) return undefined
  const rest = body.slice(0, end)
  if (countChars(rest) < 2) return undefined
  // `？`/`！` 带语气，留下；句号丢掉——「话说一半」本来就不该有句号。
  const keepTail = tail.includes('？') || tail.includes('！') ? tail : ''
  return rest + keepTail
}

/**
 * 把一句口头禅插进正文。
 * @param text 原文。
 * @param habit 口头禅正文。
 * @param placement 插句首还是句尾。
 */
export function insertHabit(text: string, habit: string, placement: 'prefix' | 'suffix'): string {
  const phrase = habit.trim()
  if (phrase === '') return text
  const phraseNeedsComma = !/[，,、。！？…～!?~]$/.test(phrase)
  if (placement === 'prefix') {
    return phrase + (phraseNeedsComma ? '，' : '') + text
  }
  const { body, tail } = splitTail(text)
  const bodyNeedsComma = body !== '' && !/[，,、；;：:]$/.test(body)
  return body + (bodyNeedsComma ? '，' : '') + phrase + tail
}

/**
 * 中位字数。
 * @param texts 若干条消息。
 */
export function medianLength(texts: readonly string[]): number {
  const nums = texts.map(countChars).filter(n => n > 0).sort((a, b) => a - b)
  if (nums.length === 0) return 0
  const mid = Math.floor(nums.length / 2)
  if (nums.length % 2 === 1) return nums[mid]
  return Math.round((nums[mid - 1] + nums[mid]) / 2)
}
