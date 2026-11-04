/**
 * 「已庆祝里程碑」的读写。
 *
 * ## 落点与写法
 *
 * `user/grow.json`，**0600**，临时文件 + `rename` 原子替换。
 *
 * ## 存什么、不存什么
 *
 * 只存「哪几个里程碑庆祝过了」。**不存档位、不存分数、不存四项读数。**
 * 理由：档位与分数是四项上游读数的派生值，上游一变它们就该跟着变；
 * 存下来就多一个「跟上游打架的缓存」，而且一定会打架——
 * 用户删掉一百条记忆之后，存档里那个「开花」会赖着不走。
 *
 * 代价是每次 `view()` 都要重算一遍四项。四项都是 `count` 级操作（不打表、不算分），
 * 重算比维护缓存安全得多，也快得多。
 *
 * ## 为什么这个文件丢了也不致命
 *
 * 「庆祝过没有」只影响**播报一次**，不影响任何读数。
 * 文件丢了最坏的结果是应用外壳再播一次「满三十天了」。
 * 这是刻意把「可丢状态」压缩到最小的一步——养成进度绝不在这个文件里。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { MILESTONES } from './types.js'
import type { GrowState, MilestoneId } from './types.js'

/** 存档版本。字段形状变了就 +1，读旧版按缺省补。 */
export const STATE_VERSION = 1

/** 状态文件名（落在 `user/` 区域下）。 */
export const STATE_FILE = 'grow.json'

/** 临时文件后缀。 */
const TMP_SUFFIX = '.tmp'

/** 最多记多少个已庆祝项。里程碑只有 6 条，留两倍余量防手改存档灌爆。 */
export const CELEBRATED_MAX = 16

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只认已知里程碑 id。手改存档塞进来的未知值一律丢弃——它会让 `ack()` 永远对不上账。 */
function milestoneOf(value: unknown): MilestoneId | undefined {
  return MILESTONES.find(item => item === value)
}

/** 空状态。 */
export function emptyState(): GrowState {
  return Object.freeze({
    version: STATE_VERSION,
    celebrated: Object.freeze([]),
    lastCelebratedAt: 0,
  })
}

/**
 * 归一化一份状态。**任何异常都退化成空状态**，不抛错：
 * 这个文件是可丢状态，为一个坏存档让整个插件不注册，代价远大于收益。
 * @param raw 原始值。
 */
export function normalizeState(raw: unknown): GrowState {
  if (!isRecord(raw)) return emptyState()
  const list = raw['celebrated']
  const out: MilestoneId[] = []
  if (Array.isArray(list)) {
    for (const item of list) {
      const id = milestoneOf(item)
      if (id === undefined || out.includes(id)) continue
      out.push(id)
      if (out.length >= CELEBRATED_MAX) break
    }
  }
  const at = raw['lastCelebratedAt']
  return Object.freeze({
    version: STATE_VERSION,
    celebrated: Object.freeze(out),
    lastCelebratedAt: typeof at === 'number' && Number.isFinite(at) && at > 0 ? Math.trunc(at) : 0,
  })
}

/**
 * 读状态。文件不存在、坏 JSON、权限不足，一律退化成空状态并返回原因。
 * @param filePath 绝对路径。
 */
export function readState(filePath: string): { readonly state: GrowState; readonly issue?: string } {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    // ENOENT 是首次运行的正常态，不算问题；其余（权限、目录被删）值得记一笔。
    const code = isRecord(error) ? error['code'] : undefined
    if (code === 'ENOENT') return { state: emptyState() }
    return { state: emptyState(), issue: '读不到养成状态：' + String(code ?? '未知错误') }
  }
  if (text.trim() === '') return { state: emptyState() }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { state: emptyState(), issue: '养成状态不是合法 JSON，已按空状态处理' }
  }
  return { state: normalizeState(parsed) }
}

/**
 * 写状态：临时文件 + `rename` 原子替换。
 *
 * 先写 `.tmp` 再改名，是为了让「写到一半断电」时留下的是**旧完整版**，
 * 而不是一个被截断的新版本。
 * @param filePath 绝对路径。
 * @param state 状态。
 */
export function writeState(filePath: string, state: GrowState): void {
  const tmp = filePath + TMP_SUFFIX
  const body = JSON.stringify(
    {
      version: STATE_VERSION,
      celebrated: state.celebrated,
      lastCelebratedAt: state.lastCelebratedAt,
    },
    null,
    2,
  )
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, filePath)
}
