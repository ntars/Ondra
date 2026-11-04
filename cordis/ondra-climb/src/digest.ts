/**
 * 爬楼的纯函数层：洗净、截断、指纹、拼行、按组轮转取件。
 *
 * 全部是纯函数（没有 fs、没有时钟、没有 ctx），因此可以在自检里逐条对拍。
 * 唯一的副作用入口是 `service.ts` 的 `plan()`——它只读内存。
 */

import type { BacklogItem, ChatKind, ClockPartsLike, DigestLine } from './types.js'
import { keyOf } from './state.js'

/** 码位数（emoji 算一个）。 */
export function charsOf(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/** 零宽字符。粘在正文里会让「同一句话」算成两个指纹。 */
const ZERO_WIDTH = /[\u200b-\u200f\u2028\u2029\ufeff]/g

/** 控制字符（保留 `\n` 与 `\t`，它们先被换成空格）。 */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/** 连续空格（含全角空格与不换行空格）。 */
const SPACES = /[ \t\u00a0\u3000]+/g

/** 三个以上换行压成两个。 */
const BLANK_LINES = /\n{3,}/g

/** 链接。群里最常见的噪声，而且很长。 */
const URL = /\bhttps?:\/\/[^\s]+/gi

/**
 * 洗净一段正文。
 *
 * 顺序是有讲究的：先去零宽（否则 `h\u200bttp` 逃过链接识别），
 * 再去控制字符，然后换链接、压空白。反过来做会把刚压好的空格又切碎。
 * @param text 原文。
 */
export function squeeze(text: string): string {
  return String(text)
    .replace(ZERO_WIDTH, '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .replace(URL, '[链接]')
    .replace(SPACES, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(BLANK_LINES, '\n\n')
    .trim()
}

/**
 * 按**码位**截断，且不切断代理对。
 *
 * 句界回退：截断点之后如果还剩不到四成预算，就退到最后一个句号——
 * 「今天的会推迟了，因为」比「今天的会推迟了，因为明…」更像人说的话。
 * @param text 原文。
 * @param max 最多保留多少码位。
 */
export function clipText(text: string, max: number): { readonly text: string; readonly truncated: boolean } {
  const safe = Math.max(1, Math.trunc(max))
  if (charsOf(text) <= safe) return { text, truncated: false }

  let out = ''
  let count = 0
  for (const ch of text) {
    if (count >= safe) break
    out += ch
    count += 1
  }

  const tail = Math.floor(safe * 0.6)
  const cut = Math.max(
    out.lastIndexOf('。'),
    out.lastIndexOf('！'),
    out.lastIndexOf('？'),
    out.lastIndexOf('\n'),
  )
  if (cut >= tail) out = out.slice(0, cut + 1)

  const ended = /[。！？…!?\n]$/.test(out)
  return { text: ended ? out.trimEnd() : `${out.trimEnd()}…`, truncated: true }
}

/**
 * 算一个 64 位十六进制指纹（FNV-1a）。
 *
 * 与 `ondra-asr` / `ondra-multimodal-memory` 的实现逐字相同（同样按 UTF-16 码元、
 * 同样 64 位掩码、同样 16 位补零）。这里再用一次，是因为「同一条消息被通道重推」
 * 必须被判成同一条；换一套哈希，重推就会变成两条，用户看到同一句话出现两次。
 * @param text 待哈希文本。
 */
export function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}

/**
 * 一条消息的判重指纹。
 *
 * `messageId` 优先：平台 id 是唯一标识，改一次错别字也还是同一条。
 * 没有 id 才退回「群号 + 时刻 + 正文」——这条口径的代价是「编辑过的消息算新消息」，
 * 但那比「两条不同消息算同一条」安全：前者多一行，后者少一句话。
 * @param item 消息的判重字段。
 */
export function fingerprintOf(
  item: Pick<BacklogItem, 'groupId' | 'messageId' | 'at' | 'text'>,
): string {
  const tail = item.messageId !== undefined && item.messageId !== ''
    ? item.messageId
    : `${item.at}\u0000${item.text}`
  return fnv1a64(`${item.groupId}\u0000${tail}`)
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 允许的未来偏差：通道与本机时钟差几分钟是常态，差一天是坏数据。 */
const FUTURE_SKEW_MS = 10 * 60 * 1000

/** 读一个会话种类。**认不出就按群处理**（爬楼只关心群）。 */
function chatKindOf(value: unknown): ChatKind {
  return value === 'private' ? 'private' : 'group'
}

/** 读一个真时刻；读不出返回 0。 */
function stampOf(value: unknown, now: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const at = Math.trunc(value)
  if (at <= 0) return 0
  if (at > now + FUTURE_SKEW_MS) return 0
  return at
}

/** 读一个短字符串（洗净、截断）。 */
function shortOf(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return squeeze(value).slice(0, max)
}

/**
 * 把一条原始数据归一化成 `BacklogItem`。**永不抛错**。
 *
 * 拒收口径（返回 `undefined`）：不是对象、群号为空、时刻不像真时刻、正文洗净后为空。
 * 其余一律补默认：缺说话人写空串（拼行时写「某人」），缺群名用群号。
 * @param raw 原始值。
 * @param options 上限与当前时刻。
 */
export function normalizeItem(
  raw: unknown,
  options: { readonly maxChars: number; readonly now: number },
): BacklogItem | undefined {
  if (!isRecord(raw)) return undefined

  const groupId = shortOf(raw['groupId'], 64)
  if (groupId === '') return undefined

  const at = stampOf(raw['at'], options.now)
  if (at === 0) return undefined

  const text = squeeze(typeof raw['text'] === 'string' ? raw['text'] : '')
  if (text === '') return undefined

  const clipped = clipText(text, options.maxChars)
  const messageId = shortOf(raw['messageId'], 128)
  const groupName = shortOf(raw['groupName'], 32)

  return Object.freeze({
    groupId,
    groupName: groupName === '' ? groupId : groupName,
    chatKind: chatKindOf(raw['chatKind']),
    messageId: messageId === '' ? undefined : messageId,
    senderId: shortOf(raw['senderId'], 64) || undefined,
    senderName: shortOf(raw['senderName'], 32) || undefined,
    at,
    text: clipped.text,
    truncated: clipped.truncated,
  })
}

/** 两位补零。 */
function pad(value: number): string {
  return String(Math.max(0, Math.trunc(value))).padStart(2, '0')
}

/**
 * 时刻的 `HH:mm` 写法。
 *
 * 优先走 O-003：它按生效时区算，跨时区部署时「14:05」才是主人眼里的 14:05。
 * 没有时间服务时退回本机时区，并（由 `index.ts`）报一次降级。
 * @param at 毫秒时刻。
 * @param parts 取日历切片的函数（可缺）。
 */
export function clockLabel(
  at: number,
  parts?: (epoch: number) => ClockPartsLike | undefined,
): string {
  const sliced = parts ? parts(at) : undefined
  if (sliced !== undefined) return `${pad(sliced.hour)}:${pad(sliced.minute)}`
  const date = new Date(at)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 群标题。
 *
 * 群号是「对得上账」的关键（主人说「那个群」时，只有群号能定位），
 * 但它很长，所以放群名后面而不是前面。
 * @param item 消息。
 * @param showGroupId 是否带群号。
 */
export function groupLabel(item: Pick<BacklogItem, 'groupId' | 'groupName'>, showGroupId: boolean): string {
  const name = item.groupName !== undefined && item.groupName !== '' ? item.groupName : item.groupId
  if (!showGroupId) return name
  return name === item.groupId ? item.groupId : `${name} ${item.groupId}`
}

/** 拼一行的入参。 */
export interface LineOptions {
  /** 是否带群号。 */
  readonly showGroupId: boolean
  /** 取日历切片的函数。 */
  readonly parts?: (epoch: number) => ClockPartsLike | undefined
}

/**
 * 拼一行清单。
 * @param item 消息。
 * @param options 拼行选项。
 */
export function lineOf(item: BacklogItem, options: LineOptions): DigestLine {
  const who = item.senderName !== undefined && item.senderName !== '' ? item.senderName : '某人'
  const line = `[${groupLabel(item, options.showGroupId)}] ${clockLabel(item.at, options.parts)} ${who}：${item.text}`
  return Object.freeze({
    key: keyOf(item.chatKind, item.groupId),
    fingerprint: fingerprintOf(item),
    groupId: item.groupId,
    groupName: item.groupName !== undefined && item.groupName !== '' ? item.groupName : item.groupId,
    at: item.at,
    clock: clockLabel(item.at, options.parts),
    sender: who,
    text: item.text,
    line,
    truncated: item.truncated,
    messageId: item.messageId,
  })
}

/** 取件的上限。 */
export interface BuildLimits extends LineOptions {
  /** 最多几行。 */
  readonly maxItems: number
  /** 正文总长上限（码位）。 */
  readonly maxChars: number
}

/**
 * 从候选里取出一轮清单。
 *
 * **取件按组轮转，输出按时间升序**。两个理由：
 *
 * - 只按时间取，一个刷屏群会把其他群全饿死——主人问「那几个群呢」时她答不上来；
 * - 只按轮转输出，读起来是乱的——「14:05 / 9:12 / 14:03」不像话。
 *
 * 装不下的条**不丢**，留在 `folded` 里等下一轮。
 * @param items 候选（顺序无关）。
 * @param limits 上限。
 */
export function buildLines(
  items: readonly BacklogItem[],
  limits: BuildLimits,
): { readonly lines: readonly DigestLine[]; readonly folded: number; readonly chars: number } {
  const maxItems = Math.max(1, Math.trunc(limits.maxItems))
  const maxChars = Math.max(1, Math.trunc(limits.maxChars))

  const ordered = [...items].sort((left, right) => left.at - right.at)
  const buckets = new Map<string, BacklogItem[]>()
  for (const item of ordered) {
    const key = `${item.chatKind}\u0000${item.groupId}`
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, [item])
    else bucket.push(item)
  }

  const queues = [...buckets.values()]
  if (queues.length === 0) return { lines: Object.freeze([]), folded: 0, chars: 0 }

  const picked: DigestLine[] = []
  let chars = 0
  let index = 0
  let stuck = 0

  while (picked.length < maxItems && stuck < queues.length) {
    const queue = queues[index % queues.length]
    index += 1
    if (queue.length === 0) {
      stuck += 1
      continue
    }

    // 上面已排除空队列，这里取队首是安全的。
    const head = queue[0]
    const built = lineOf(head, limits)
    const separator = picked.length === 0 ? 0 : 1
    if (chars + separator + charsOf(built.line) > maxChars) {
      // 这一条装不下。本轮先放着，**不丢**：下一轮它还在队首。
      stuck += 1
      continue
    }

    queue.shift()
    picked.push(built)
    chars += separator + charsOf(built.line)
    stuck = 0
  }

  picked.sort((left, right) => left.at - right.at)
  return { lines: Object.freeze(picked), folded: items.length - picked.length, chars }
}

/**
 * 把清单拼成可直接注入的块。
 *
 * 第一行是固定 marker `[爬楼]`。它不是装饰：O-142 的注入去重按「记忆」记账，
 * 一个稳定的块前缀能让「同一份清单被重复注入」在日志里一眼看出来。
 * @param lines 清单行。
 */
export function composeText(lines: readonly DigestLine[]): string {
  if (lines.length === 0) return ''
  return ['[爬楼]', ...lines.map(line => line.line)].join('\n')
}
