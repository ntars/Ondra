/**
 * 四段的声明、进度算术、证据闸门。**全是纯函数**，不读文件、不看时间、不发消息。
 *
 * ## 为什么四段等权 25
 *
 * 手册给了「实时进度百分比」，但**没给每一段占多少**。等权是最少编造的选择：
 * 任何一组「23/31/19/27」都是拍脑袋，而且没人能复核。`fraction`（段内进度 0–1）
 * 负责让数字真的动起来——否则四段只会跳 0 → 25 → 50 → 75 → 100，看起来像卡住。
 *
 * ## 宣传片里的 56% 不是常量
 *
 * §1.11 章 01 写「56%→100%」，那是**宣传片某一帧**。把它写进代码的后果是：
 * 真实安装到 56% 时如果没对上，会有人去改权重来「修好它」。本包只算不写。
 *
 * ## 证据闸门为什么不做开关
 *
 * 「打勾」这件事必须有东西可打。允许无证据推进，等于把验收基线变成一排空白勾选，
 * 而空白勾选比没有引导更糟：它会让人以为走完了。要跳过请用 `skip()`，
 * 它只对**可选段**生效，并把 `detail` 记下来。
 */

import type {
  Phase,
  SegmentDecl,
  SegmentEvidence,
  SegmentId,
  SegmentRecord,
  SegmentState,
  OnboardingReason,
} from './types.js'
import { SEGMENTS_REVERSE_ENGINEERED } from './types.js'

/** 状态行：准备中（§1.11 / §6.4 原文）。 */
export const STATUS_PREPARING = '正在准备运行环境'

/** 状态行：就绪（§1.11 / §6.4 原文）。 */
export const STATUS_READY = '安装完成，已就绪'

/**
 * 状态行：停下。
 *
 * **刻意不用前两句**：停了却说「正在准备」是假话，说「已就绪」更糟。
 * 验收里的「状态行」一条会因为缺这两句之一而如实报不过。
 */
export const STATUS_STOPPED = '准备运行环境时停下了'

/** 四段的声明，顺序即依赖。 */
export const SEGMENTS: readonly SegmentDecl[] = Object.freeze([
  Object.freeze({
    id: 'env' as const,
    title: '检查运行环境',
    weight: 25,
    required: true,
    source: '§6.4 一键部署四件套第 1 条「检查 Node≥20」（原话；四段划分本身是反推）',
    needs: '当前 Node 版本号（例如 v20.11.1）',
  }),
  Object.freeze({
    id: 'reuse' as const,
    title: '复用已装的 ondra',
    weight: 25,
    required: true,
    source: '§6.4 一键部署四件套第 2 条「复用已装 `ondra`，没有就免安装跑」（原话）',
    needs: '复用的可执行文件路径，或 `npm-exec`（免安装）',
  }),
  Object.freeze({
    id: 'port' as const,
    title: '挑一个空闲端口',
    weight: 25,
    required: true,
    source: '§6.4 第 3 条「`--port 0` 挑空闲端口」（原话）；具体挑法归 O-083',
    needs: '挑到的端口号（1–65535）',
  }),
  Object.freeze({
    id: 'open' as const,
    title: '带 token 打开界面',
    weight: 25,
    required: false,
    source: '§6.4 第 4 条「抓带 token 地址自动开浏览器」（原话）；「打开」由壳侧执行',
    needs: '要打开的回环地址（原样给出，本包不重拼）',
  }),
])

/** 段的顺序（供 `currentOf` 用）。 */
const ORDER: readonly SegmentId[] = Object.freeze(SEGMENTS.map(decl => decl.id))

/** 四段的 id 集合（供 `isSegmentId` 用）。 */
const IDS: ReadonlySet<string> = new Set(ORDER)

/**
 * 是不是合法的段 id。
 * @param value 原始值。
 */
export function isSegmentId(value: unknown): value is SegmentId {
  return typeof value === 'string' && IDS.has(value)
}

/**
 * 取一段的声明。
 * @param id 段 id。
 */
export function declOf(id: SegmentId): SegmentDecl {
  const found = SEGMENTS.find(decl => decl.id === id)
  // SEGMENTS 与 SegmentId 是同一份定义，找不到说明类型被改坏了；给最后一段兜底而不是抛。
  return found ?? SEGMENTS[SEGMENTS.length - 1]
}

/**
 * 全新的记录表（全 `pending`）。
 *
 * `at: 0` 表示「从没动过」，与「刚动过」区分开——界面不该对没动过的段显示时间。
 */
export function emptyRecords(): Record<SegmentId, SegmentRecord> {
  const out = {} as Record<SegmentId, SegmentRecord>
  for (const id of ORDER) {
    out[id] = { state: 'pending', fraction: 0, at: 0 }
  }
  return out
}

/**
 * 把落盘的 `Record<string, SegmentRecord>` 收成四段齐全的形状。
 * @param raw 落盘值。
 */
export function normalizeRecords(
  raw: Readonly<Record<string, SegmentRecord>> | undefined,
): Record<SegmentId, SegmentRecord> {
  const out = emptyRecords()
  if (raw === undefined) return out
  for (const id of ORDER) {
    const rec = raw[id]
    if (rec === undefined) continue
    out[id] = {
      state: stateOf(rec.state),
      fraction: clamp01(rec.fraction),
      at: typeof rec.at === 'number' && Number.isFinite(rec.at) ? rec.at : 0,
      ...(rec.evidence === undefined ? {} : { evidence: rec.evidence }),
      ...(rec.detail === undefined ? {} : { detail: rec.detail }),
    }
  }
  return out
}

/**
 * 状态字符串收窄：认不出的按 `pending`（重来一遍比假装完成安全）。
 * @param value 原始值。
 */
function stateOf(value: unknown): SegmentState {
  if (value === 'active' || value === 'done' || value === 'skipped' || value === 'failed') return value
  return 'pending'
}

/**
 * 夹到 0–1。
 * @param value 原始值。
 */
export function clamp01(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * 已完（含跳过）几段。
 * @param records 记录表。
 */
export function doneCount(records: Readonly<Record<string, SegmentRecord>>): number {
  let count = 0
  for (const id of ORDER) {
    const state = records[id]?.state
    if (state === 'done' || state === 'skipped') count += 1
  }
  return count
}

/**
 * 百分比（0–100 整数，向下取整）。
 *
 * 向下取整是刻意的：99.6 显示成 100 之后，界面会在「100%」上停一会儿才真的完成，
 * 那几秒里的每一句「怎么还没好」都是这个四舍五入造成的。
 * @param records 记录表。
 */
export function percentOf(records: Readonly<Record<string, SegmentRecord>>): number {
  let total = 0
  for (const decl of SEGMENTS) {
    const rec = records[decl.id]
    if (rec === undefined) continue
    if (rec.state === 'done' || rec.state === 'skipped') total += decl.weight
    else if (rec.state === 'active') total += decl.weight * clamp01(rec.fraction)
  }
  return Math.min(100, Math.floor(total))
}

/**
 * 当前该处理的那一段：第一个**还没完成**的段。
 *
 * 这里刻意把 `failed` 也算作「当前」：失败段必须留在原地等人处理。如果把它跳过去、
 * 让 `current` 指向后面那段，`advance()` 就会允许继续往下走——一次失败被悄悄绕过，
 * 而 `phase` 还是 `failed`，界面与数据互相矛盾。要往下走只有两条路：
 * 带证据重试这一段，或者（仅可选段）显式 `skip()`。
 * @param records 记录表。
 */
export function currentOf(records: Readonly<Record<string, SegmentRecord>>): SegmentId | undefined {
  for (const id of ORDER) {
    const state = records[id]?.state
    if (state !== 'done' && state !== 'skipped') return id
  }
  return undefined
}

/**
 * 整体阶段。
 * @param records 记录表。
 */
export function phaseOf(records: Readonly<Record<string, SegmentRecord>>): Phase {
  let started = false
  for (const id of ORDER) {
    const state = records[id]?.state
    if (state === 'failed') return 'failed'
    if (state === 'done' || state === 'skipped' || state === 'active') started = true
  }
  if (!started) return 'idle'
  return doneCount(records) === ORDER.length ? 'ready' : 'preparing'
}

/**
 * 状态行。
 *
 * 前两句是 §1.11 / §6.4 的**原文**，后面直接拼当前段标题，不另起叙述——
 * 验收要能一眼看出「这句是规范里的那句」。
 * @param phase 阶段。
 * @param current 当前段。
 */
export function statusLineOf(phase: Phase, current?: SegmentId): string {
  if (phase === 'ready') return STATUS_READY
  if (phase === 'failed') return STATUS_STOPPED
  if (current === undefined) return STATUS_PREPARING
  return `${STATUS_PREPARING} · ${declOf(current).title}`
}

/**
 * 原因码 → 一句能照做的话。
 * @param reason 原因码。
 */
export function describeReason(reason: OnboardingReason): string {
  switch (reason) {
    case 'disabled':
      return '首启引导关着：把 `enable` 打开，界面才有东西可显示'
    case 'not-started':
      return '还没开首启：先 `begin()`，再逐段推进'
    case 'bad-segment':
      return '段 id 不认识：只有 `env` / `reuse` / `port` / `open` 四段'
    case 'out-of-order':
      return '只能推进当前这一段：顺序即依赖，跳着走会让后面的证据对不上'
    case 'no-evidence':
      return '这一段必须带证据才能算完（`nodeVersion` / `ondraPath` / `port` / `url`）'
    case 'bad-evidence':
      return '证据形状不对：按 `needs` 里写的那样给（例如 `v20.11.1`、回环地址）'
    case 'not-skippable':
      return '这一段不能跳过：只有「带 token 打开界面」允许跳过（无图形界面时）'
    case 'already-done':
      return '这一轮首启已经走完了：要重来请显式 `begin({ restart: true })`'
    case 'disposed':
      return '插件已卸载：重新装载后再开首启'
    default:
      return '未知原因'
  }
}

/**
 * 是不是回环主机名。
 *
 * 与 O-083 的 `isLoopbackHost` **同一判据**，但按 §18.5「同轮两个插件不许 import
 * 对方源码」在这里单独写一份。改判据时两处都要改——这是刻意的重复，
 * 换成一个共享包就等于把两个插件绑成一个。
 * @param host 主机名。
 */
export function isLoopbackHost(host: string): boolean {
  const text = host.trim().toLowerCase()
  if (text === '') return false
  const bare = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text
  if (bare === 'localhost') return true
  if (bare === '::1') return true
  const parts = bare.split('.')
  if (parts.length !== 4) return false
  if (parts[0] !== '127') return false
  return parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** 证据校验结论。 */
export interface EvidenceVerdict {
  readonly ok: boolean
  readonly detail?: string
}

/**
 * 证据闸门：这一段算不算「有东西可打勾」。
 * @param id 段 id。
 * @param evidence 证据。
 */
export function validateEvidence(id: SegmentId, evidence?: SegmentEvidence): EvidenceVerdict {
  const given = evidence ?? {}

  if (id === 'env') {
    const version = given.nodeVersion
    if (typeof version !== 'string' || !/^v?\d+(?:\.\d+)*$/.test(version.trim())) {
      return { ok: false, detail: `需要 \`nodeVersion\`（例如 v20.11.1），收到的是「${String(version)}」` }
    }
    return { ok: true }
  }

  if (id === 'reuse') {
    const path = given.ondraPath
    if (typeof path !== 'string' || path.trim() === '') {
      return { ok: false, detail: '需要 `ondraPath`（复用路径，或 `npm-exec` 表示免安装跑）' }
    }
    return { ok: true }
  }

  if (id === 'port') {
    const port = given.port
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, detail: `需要 1–65535 的整数 \`port\`，收到的是「${String(port)}」` }
    }
    return { ok: true }
  }

  const url = given.url
  if (typeof url !== 'string' || url.trim() === '') {
    return { ok: false, detail: '需要 `url`（要打开的回环地址，原样给出）' }
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, detail: `地址解析不了：「${url}」` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, detail: `协议只接受 http/https，收到「${parsed.protocol}」` }
  }
  if (!isLoopbackHost(parsed.hostname)) {
    // 首启引导打开一个非回环地址，等于把带 token 的界面暴露到网络上（§9.2 的 CSWSH 教训）。
    return { ok: false, detail: `地址不是回环：「${parsed.hostname}」（带 token 的地址不许指到别的机器）` }
  }
  return { ok: true }
}

/**
 * 这条证据里有没有查询串（只作提示，**不作闸门**）。
 *
 * 参数名手册没写（只写「带 token 地址」），所以本包不认名字、不校验 token，
 * 只如实把「有 / 没有」报出来。认一个猜的名字，会让合法的地址被拒。
 * @param evidence 证据。
 */
export function carriesQuery(evidence?: SegmentEvidence): boolean {
  const url = evidence?.url
  if (typeof url !== 'string') return false
  try {
    return new URL(url).search.length > 1
  } catch {
    return false
  }
}

/** 四段的出处说明（写进 README 与日志，避免把反推当引用）。 */
export const SOURCE_NOTE = SEGMENTS_REVERSE_ENGINEERED;
