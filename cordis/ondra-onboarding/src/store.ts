/**
 * 首启状态的落盘：一个 JSON，**原子写、0600**。
 *
 * ## 为什么要落盘
 *
 * 「走完首启就不再打扰」这件事必须跨进程存活。只放内存的话，重启一次又从头引导，
 * 而用户已经配好了——那种重复引导比没有引导更烦人。
 *
 * ## 为什么读不懂就重来
 *
 * 解析失败 / 版本号不认识 → 当「没有记录」。代价是最多多引导一次；反过来
 * 「拒绝启动」或「抛异常」，代价是整个应用起不来。首启状态不值得让人付这个代价。
 *
 * ## 为什么不放在 `user/onboarding/` 之外的任何地方
 *
 * 与 O-080 同一条纪律：路径只经 O-002 拼，不写死 `~/.ondra/...`。换了数据根
 * （`$ONDRA_HOME`）之后，写死的那条路径会指向一个没人管的旧目录。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { LogLike, OnboardingState, PathLayoutLike, SegmentRecord } from './types.js'

/** 结构版本。改字段形状时 +1，旧文件会被当成「没有记录」。 */
export const STATE_VERSION = 1

/** 状态文件名。 */
const FILE_NAME = 'state.json'

/** 文件权限：只给当前用户。 */
const FILE_MODE = 0o600

/** 目录权限：0700。 */
const DIR_MODE = 0o700

/** 本地文件状态库。所有方法**永不抛**。 */
export class FileOnboardingStore {
  readonly #dir: string | null
  readonly #log: LogLike
  #warned = false

  /**
   * @param layout O-002 路径服务；缺席且没配 `stateDir` 时退化为纯内存。
   * @param stateDir 配置的状态目录（空 = 走 `user/onboarding`）。
   * @param log 日志。
   */
  constructor(layout: PathLayoutLike | null, stateDir: string, log: LogLike) {
    this.#log = log
    if (stateDir !== '') {
      this.#dir = stateDir
      return
    }
    if (layout === null) {
      this.#dir = null
      return
    }
    try {
      this.#dir = layout.ensure('user', 'onboarding')
    } catch {
      this.#dir = null
    }
  }

  /** 是否真的会落盘。 */
  get persistent(): boolean {
    return this.#dir !== null
  }

  /** 状态文件绝对路径；只在内存时为空串。 */
  pathOf(): string {
    return this.#dir === null ? '' : join(this.#dir, FILE_NAME)
  }

  /** 读一份状态；没有或读不懂返回 `null`。 */
  read(): OnboardingState | null {
    const path = this.pathOf()
    if (path === '' || !existsSync(path)) return null
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      return asState(parsed)
    } catch (error) {
      this.#warnOnce(`首启状态读不懂，按「没有记录」处理：${textOf(error)}`)
      return null
    }
  }

  /**
   * 写一份状态（原子）。
   * @param state 状态。
   */
  write(state: OnboardingState): void {
    const path = this.pathOf()
    if (path === '') return
    try {
      mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
      const temp = `${path}.tmp`
      writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: FILE_MODE })
      renameSync(temp, path)
    } catch (error) {
      this.#warnOnce(`首启状态写不进去（不影响本次运行）：${textOf(error)}`)
    }
  }

  /** 删掉状态文件（`reset()` 用）。 */
  clear(): void {
    const path = this.pathOf()
    if (path === '') return
    try {
      rmSync(path, { force: true })
    } catch (error) {
      this.#warnOnce(`首启状态删不掉：${textOf(error)}`)
    }
  }

  /**
   * 同一类警告只打一次（写不进去时每次都打会刷屏）。
   * @param message 文本。
   */
  #warnOnce(message: string): void {
    if (this.#warned) return
    this.#warned = true
    this.#log.warn(message)
  }
}

/**
 * 把未知值收成状态；信封不对就当没有。
 * @param value 解析结果。
 */
function asState(value: unknown): OnboardingState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>

  if (raw['version'] !== STATE_VERSION) return null
  const runId = raw['runId']
  const startedAt = raw['startedAt']
  if (typeof runId !== 'string' || runId === '') return null
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null

  const segmentsRaw = raw['segments']
  const segments: Record<string, SegmentRecord> = {}
  if (typeof segmentsRaw === 'object' && segmentsRaw !== null && !Array.isArray(segmentsRaw)) {
    for (const [key, item] of Object.entries(segmentsRaw as Record<string, unknown>)) {
      if (typeof item !== 'object' || item === null) continue
      const rec = item as Record<string, unknown>
      const state = typeof rec['state'] === 'string' ? (rec['state'] as SegmentRecord['state']) : 'pending'
      const fraction = typeof rec['fraction'] === 'number' ? rec['fraction'] : 0
      const at = typeof rec['at'] === 'number' ? rec['at'] : 0
      const detail = typeof rec['detail'] === 'string' ? rec['detail'] : undefined
      const evidence =
        typeof rec['evidence'] === 'object' && rec['evidence'] !== null
          ? (rec['evidence'] as SegmentRecord['evidence'])
          : undefined
      segments[key] = {
        state,
        fraction,
        at,
        ...(detail === undefined ? {} : { detail }),
        ...(evidence === undefined ? {} : { evidence }),
      }
    }
  }

  const samples = Array.isArray(raw['samples'])
    ? raw['samples'].filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
    : []
  const statusLines = Array.isArray(raw['statusLines'])
    ? raw['statusLines'].filter((item): item is string => typeof item === 'string')
    : []

  const firstRaw = raw['firstMessage']
  const firstMessage =
    typeof firstRaw === 'object' && firstRaw !== null && !Array.isArray(firstRaw)
      ? asObservation(firstRaw as Record<string, unknown>)
      : undefined

  const completedAt = typeof raw['completedAt'] === 'number' ? raw['completedAt'] : undefined

  return {
    version: STATE_VERSION,
    runId,
    startedAt,
    segments,
    samples,
    statusLines,
    ...(firstMessage === undefined ? {} : { firstMessage }),
    ...(completedAt === undefined ? {} : { completedAt }),
  }
}

/**
 * 收一条首条消息观察记录。
 * @param raw 原始对象。
 */
function asObservation(raw: Record<string, unknown>): OnboardingState['firstMessage'] {
  const text = raw['text']
  const at = raw['at']
  if (typeof text !== 'string' || typeof at !== 'number') return undefined
  const initiative = raw['initiative']
  return {
    text,
    at,
    initiative: initiative === 'persona' || initiative === 'user' ? initiative : 'unknown',
  }
}

/**
 * 异常折成一句。
 * @param error 异常。
 */
function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
