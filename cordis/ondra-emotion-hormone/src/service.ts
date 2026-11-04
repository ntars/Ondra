/**
 * 门面：读数 → 判断 → 叠加。
 *
 * 这一层只做三件事：
 * 1. 把「可能失败 / 可能缺席」的宿主调用包住（C3：器官错误不得传播）；
 * 2. 记账（读数次数、错误次数、补造过哪些维度），让自检与面板读得到；
 * 3. 总开关关掉时给出**稳定的出厂答案**，而不是抛错或返回空对象。
 *
 * ## 为什么读数不做缓存
 *
 * 缓存一次就等于「第一次读到什么就永远是什么」，而激素是连续衰减的量。
 * 更实际的问题是装载顺序：缓存住 `ctx.get('ondra-emotion-core')` 的结果，
 * 会让「她后来才装载」变成「本插件永远读不到」。
 * 故每次现取（O-027 / O-031 同一条纪律）。
 *
 * ## 为什么关掉时仍然返回完整结构
 *
 * 返回 `undefined` 会让每个调用方写一遍判空，且写法各不相同；
 * 返回「基线 + 平稳」则让下游无条件可用，代价只是一次对象构造。
 * 这也符合「降级要有可感知的表现，而不是静默 return」（手册 §8.2）。
 */

import { bandOf as bandBySpec, baselineOf, readOf } from './read.js'
import { overlayOf } from './overlay.js'
import { BAND_ZH, HORMONE_SPECS, PRIMARY_HORMONES, TILT_ZH } from './types.js'
import type {
  EmotionLike,
  EnsureResult,
  HormoneBand,
  HormoneCounters,
  HormoneDimSpec,
  HormoneOverlay,
  HormoneRead,
  HormoneService,
  HormoneStats,
  HormoneUnavailableReason,
  LogLike,
} from './types.js'
import type { Config } from './settings.js'

/** 把只读计数器放开写权限（纪律 60：接口上的 `readonly` 不能在实现类里 `+=`）。 */
type MutableCounters = { -readonly [K in keyof HormoneCounters]: number }

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 组一个 `EnsureResult`（三处早退与正常返回共用一个形状，免得写四遍）。 */
function resultOf(
  at: number,
  requested: readonly string[],
  created: readonly string[],
  existing: readonly string[],
  refused: readonly string[],
): EnsureResult {
  return Object.freeze({
    at,
    requested: Object.freeze([...requested]),
    created: Object.freeze([...created]),
    existing: Object.freeze([...existing]),
    refused: Object.freeze([...refused]),
  })
}

export class HormoneRepository implements HormoneService {
  /** 是否可用（**只看总开关**）。 */
  readonly available: boolean
  /** 不可用原因（只可能是 `disabled`）。 */
  readonly reason?: HormoneUnavailableReason

  private readonly settings: Config
  private readonly log: LogLike
  private readonly clock: () => number
  /** 情绪服务的**延迟取值**：装载顺序不确定，构造时拿不到不代表以后拿不到。 */
  private readonly emotion: () => EmotionLike | undefined

  private counters: MutableCounters = { reads: 0, overlays: 0, ensures: 0, emotionErrors: 0 }
  private seeded: string[] = []
  private lastError: string | undefined
  private lastSource: 'emotion' | 'baseline' = 'baseline'

  /**
   * @param settings 已补全的配置。
   * @param log 日志。
   * @param clock 时钟（注入以便对拍）。
   * @param emotion 情绪服务的延迟取值。
   */
  constructor(settings: Config, log: LogLike, clock: () => number, emotion: () => EmotionLike | undefined) {
    this.settings = settings
    this.log = log
    this.clock = clock
    this.emotion = emotion
    this.available = settings.enable
    this.reason = settings.enable ? undefined : 'disabled'
  }

  /** @inheritdoc */
  specs(): readonly HormoneDimSpec[] {
    const out: HormoneDimSpec[] = []
    for (const name of PRIMARY_HORMONES) out.push(HORMONE_SPECS[name])
    if (this.settings.includeSerotonin) out.push(HORMONE_SPECS.serotonin)
    return Object.freeze(out)
  }

  /** @inheritdoc */
  read(at?: number): HormoneRead {
    const now = at ?? this.clock()
    this.bump('reads')

    const snapshot = this.snapshotOf(now)
    const read = readOf(snapshot, now, this.settings.includeSerotonin)
    this.lastSource = read.source

    if (this.settings.verbose) {
      this.log.debug?.('激素读数：%s（来源 %s）', this.describeOf(read), read.source)
    }
    return read
  }

  /** @inheritdoc */
  overlay(at?: number): HormoneOverlay {
    const now = at ?? this.clock()
    this.bump('overlays')
    return overlayOf(this.read(now))
  }

  /** @inheritdoc */
  bandOf(name: string, value?: number): HormoneBand {
    const spec = this.specOf(name)
    if (spec === undefined) return 'normal'
    if (value !== undefined) {
      const snapshot = this.snapshotOf(this.clock())
      return bandBySpec(spec, value, baselineOf(spec, snapshot?.temperament))
    }
    const reading = this.read().readings[name]
    return reading === undefined ? 'normal' : reading.band
  }

  /** @inheritdoc */
  explain(at?: number): readonly string[] {
    // 关闭态要说「关了」，不能说「还没建起来」——后者会让用户去调 ensure()，
    // 而 ensure() 在关闭态只会把请求原样退回 refused。
    if (!this.available) return Object.freeze(['激素维度已关闭（默认关闭），读数一律为出厂基线'])

    const read = this.read(at)
    const overlay = overlayOf(read)
    const lines: string[] = [`当前倾向：${TILT_ZH[overlay.tilt]}`]

    for (const reading of Object.values(read.readings)) {
      if (reading.band === 'normal') continue
      lines.push(`${reading.zh} ${BAND_ZH[reading.band]}（基线 ${reading.baseline}）`)
    }
    if (read.missing.length > 0) {
      lines.push(`按基线代入：${read.missing.join('、')}（还没建起来，调 ensure() 可补）`)
    }
    lines.push(`三个主维度的权重：${this.weightTextOf(overlay)}`)
    return Object.freeze(lines)
  }

  /**
   * @inheritdoc
   *
   * 这是本插件**唯一的写动作**，而它写的不是情绪值：
   * `inflict(name, 0)` 只让 O-026 在它的池子里登记一个「停在基线」的维度。
   * 现有任何一维的读数都不变——增量为 0。
   */
  ensure(names?: readonly string[], at?: number): EnsureResult {
    const now = at ?? this.clock()
    this.bump('ensures')

    const requested: string[] = []
    for (const item of names ?? ['oxytocin']) {
      if (!requested.includes(item)) requested.push(item)
    }

    const created: string[] = []
    const existing: string[] = []
    const refused: string[] = []

    if (!this.available) {
      return resultOf(now, requested, created, existing, requested)
    }

    const emotion = this.emotion()
    if (emotion === undefined) {
      return resultOf(now, requested, created, existing, requested)
    }

    for (const name of requested) {
      const spec = this.specOf(name)
      // 只补「O-026 出厂没有」的维度；核心维度本来就存在，不需要造。
      if (spec === undefined) {
        refused.push(name)
        continue
      }
      if (spec.source !== 'dynamic') {
        existing.push(name)
        continue
      }
      try {
        if (emotion.inflict(name, 0, now)) {
          created.push(name)
          if (!this.seeded.includes(name)) this.seeded.push(name)
        } else {
          refused.push(name)
        }
      } catch (error) {
        refused.push(name)
        this.recordError('ensure', error)
      }
    }

    if (created.length > 0) {
      this.log.info('已用动态激素通道补造维度：%s（值为基线，不改任何现有读数）', created.join('、'))
    }
    if (refused.length > 0) {
      this.log.warn('有 %d 个维度没能补造（名字非法，或动态激素已到 12 种上限）', refused.length)
    }

    return Object.freeze({
      at: now,
      requested: Object.freeze([...requested]),
      created: Object.freeze([...created]),
      existing: Object.freeze([...existing]),
      refused: Object.freeze([...refused]),
    })
  }

  /** @inheritdoc */
  stats(): HormoneStats {
    // 先落到局部常量再判空：直接判 `this.reason` 时，收窄在对象展开里不一定保持，
    // 而 `{ reason: this.reason }` 一旦拿到 `undefined` 就会撞可选属性。
    const reason = this.reason
    const lastError = this.lastError
    const out = {
      available: this.available,
      source: this.lastSource,
      counters: Object.freeze({ ...this.counters }),
      seeded: Object.freeze([...this.seeded]),
    }
    if (reason === undefined && lastError === undefined) return Object.freeze(out)
    return Object.freeze({
      ...out,
      ...(reason === undefined ? {} : { reason }),
      ...(lastError === undefined ? {} : { lastError }),
    })
  }

  /* ---------------------------------------------------------------- *
   * 内部
   * ---------------------------------------------------------------- */

  /** 计数器 +1（就地累加，`MutableCounters` 放开了 readonly）。 */
  private bump(key: keyof HormoneCounters): void {
    this.counters[key] += 1
  }

  /** 记一次错误（**不抛**，C3）。 */
  private recordError(stage: string, error: unknown): void {
    this.counters.emotionErrors += 1
    this.lastError = `${stage}: ${messageOf(error)}`
    this.log.warn('激素维度在 %s 阶段读情绪失败（已降级为出厂基线）：%s', stage, messageOf(error))
  }

  /** 找一个维度的说明。名字放宽到 `string`，避免索引后判 `undefined` 触发 TS2367。 */
  private specOf(name: string): HormoneDimSpec | undefined {
    return Object.values(HORMONE_SPECS).find(spec => spec.name === name)
  }

  /**
   * 取一次情绪快照。
   *
   * 返回 `undefined` 的四种情况全部按「缺席」处理，一律回落到出厂基线：
   * 总开关关掉、情绪服务没装载、情绪服务自己关掉、读数抛错。
   * 第四种要记账——它能区分「没装」与「装了但坏了」。
   */
  private snapshotOf(at: number): { readonly hormones: Readonly<Record<string, number>>; readonly temperament: { readonly enthusiasm: number } } | undefined {
    if (!this.available) return undefined
    const emotion = this.emotion()
    if (emotion === undefined) return undefined
    if (emotion.available === false) return undefined
    try {
      const snapshot = emotion.state(at)
      return { hormones: snapshot.hormones, temperament: snapshot.temperament }
    } catch (error) {
      this.recordError('read', error)
      return undefined
    }
  }

  /** 一行读数摘要（日志用）。 */
  private describeOf(read: HormoneRead): string {
    const parts: string[] = []
    for (const reading of Object.values(read.readings)) {
      parts.push(`${reading.zh}${reading.value}${reading.missing ? '(基线)' : ''}`)
    }
    return parts.join(' ')
  }

  /** 权重文本（解释用），只给占比最高的两维，免得一句话太长。 */
  private weightTextOf(overlay: HormoneOverlay): string {
    const entries = Object.entries(overlay.weights).sort((left, right) => right[1] - left[1])
    const top = entries.slice(0, 2).map(([name, weight]) => {
      const zh = this.specOf(name)?.zh ?? name
      return `${zh} ${Math.round(weight * 100)}%`
    })
    return top.length === 0 ? '无（三维都没读到）' : top.join('、')
  }
}
