/**
 * 服务门面：把纯判定（`gate.ts`）包上**墓碑闸、计数、审计日志与异常兜底**。
 *
 * 这一层刻意很薄——所有规则都在纯函数里，门面只做四件事：
 *
 * 1. **墓碑闸**：用户明确要求忘记的事，下一轮再提一次就会被重新写进来。
 *    没有这道闸，「忘记」只是暂时的。走 O-010 的 `tombstoned()`，**缺席就如实报
 *    `tombstoneGate: 'absent'`**，不假装查过。
 * 2. **异常兜底**：`judge()` 站在写入路径上，抛一个异常等于「她刚才那句话没记住」。
 *    内部异常一律转成 `reject` + `internal-error` 并大声记日志。
 * 3. **计数**：只在内存，进程重启归零。要持久审计读 `evidence_gate_log`。
 * 4. **审计日志**：只写不读回，读接口在 `GateLog.recent()`。
 *
 * ## 为什么内核用「延迟取值」而不是构造时取一次
 *
 * `ctx.get('ondra-memory-core')` 在构造时拿到 `undefined`（内核晚装载），
 * 如果就此认定「内核不在」，墓碑闸会**永久关闭**，而日志里只有一句 warn。
 * 改成每次现取，晚装载能自愈——这与 O-035 对 `ctx.llm` 的处理是同一条纪律。
 */

import type { Config } from './settings.js'
import { judgeCandidate, locateQuote } from './gate.js'
import type { GateLog } from './log.js'
import type {
  EvidenceGateService,
  GateAction,
  GateCounters,
  GateMaterial,
  GateRequest,
  GateStats,
  GateUnavailableReason,
  GateVerdict,
  LocateHit,
  LogLike,
  MemoryCoreLike,
} from './types.js'

/** 可变的计数桶（对外只出只读快照）。 */
interface MutableCounters {
  decisions: number
  accept: number
  strip: number
  seed: number
  reject: number
  quotesKept: number
  quotesDropped: number
  digitsStripped: number
  tombstoned: number
}

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 关掉门控时的放行结果。
 *
 * 注意它**不带任何引文**：放行不等于「验证过」，`evidence` 为空正是这个意思。
 * 想区分「放行」与「验证通过」，看 `stats().available`。
 * @param request 请求。
 */
function passThrough(request: GateRequest): GateVerdict {
  const text = typeof request.text === 'string' ? request.text : ''
  const summary = typeof request.summary === 'string' ? request.summary : ''
  return Object.freeze({
    action: 'accept' as GateAction,
    text,
    summary,
    evidence: Object.freeze([]),
    dropped: Object.freeze([]),
    digits: Object.freeze([]),
    reasons: Object.freeze([]),
    truncated: false,
  })
}

/** 证据门控服务实现。 */
export class EvidenceGate implements EvidenceGateService {
  private readonly settings: Config
  private readonly log: LogLike
  private readonly now: () => number
  private readonly coreOf: () => MemoryCoreLike | undefined
  private readonly logStore: GateLog | undefined

  private readonly counters: MutableCounters = {
    decisions: 0,
    accept: 0,
    strip: 0,
    seed: 0,
    reject: 0,
    quotesKept: 0,
    quotesDropped: 0,
    digitsStripped: 0,
    tombstoned: 0,
  }

  private lastError: string | undefined

  /**
   * @param settings 已补全的配置。
   * @param log 日志。
   * @param now 时间源（注入以便对拍）。
   * @param coreOf 记忆内核的**延迟取值**（每次现取，晚装载能自愈）。
   * @param logStore 审计日志（缺席则 `logging=false`）。
   */
  constructor(
    settings: Config,
    log: LogLike,
    now: () => number,
    coreOf: () => MemoryCoreLike | undefined,
    logStore: GateLog | undefined,
  ) {
    this.settings = settings
    this.log = log
    this.now = now
    this.coreOf = coreOf
    this.logStore = logStore
  }

  /** 是否可用（只有被关掉才不可用）。 */
  get available(): boolean {
    return this.settings.enable
  }

  /** 不可用原因。 */
  get reason(): GateUnavailableReason | undefined {
    return this.settings.enable ? undefined : 'disabled'
  }

  /**
   * 判定一条候选。
   * @param request 请求。
   */
  judge(request: GateRequest): GateVerdict {
    if (!this.settings.enable) {
      const pass = passThrough(request)
      this.count(pass)
      return pass
    }
    try {
      const judged = judgeCandidate(request, this.settings)
      const final = this.applyTombstone(judged, request)
      this.count(final)
      this.writeLog(final, request)
      return final
    } catch (error) {
      // C3 同型纪律：器官错误不得传播。这里是写入路径，更不能抛。
      const detail = messageOf(error)
      this.lastError = detail
      this.log.error('证据门控内部异常（本条按拒绝处理，不写库）：%s', detail)
      const verdict: GateVerdict = Object.freeze({
        action: 'reject' as GateAction,
        text: '',
        summary: '',
        evidence: Object.freeze([]),
        dropped: Object.freeze([]),
        digits: Object.freeze([]),
        reasons: Object.freeze([{ code: 'internal-error' as const, detail }]),
        truncated: false,
      })
      this.count(verdict)
      this.writeLog(verdict, request)
      return verdict
    }
  }

  /**
   * 批量判定。**不做批内判重**（那是 O-012 的活）。
   * @param requests 请求列表。
   */
  judgeAll(requests: readonly GateRequest[]): readonly GateVerdict[] {
    return requests.map(request => this.judge(request))
  }

  /**
   * 只做逐字定位。
   * @param quote 引文。
   * @param materials 素材池。
   */
  locate(quote: string, materials: readonly GateMaterial[]): LocateHit | undefined {
    try {
      return locateQuote(quote, materials)
    } catch (error) {
      this.lastError = messageOf(error)
      return undefined
    }
  }

  /** 统计快照。 */
  stats(): GateStats {
    const core = this.coreOf()
    const coreAvailable = core !== undefined && core.available
    const counters: GateCounters = Object.freeze({
      decisions: this.counters.decisions,
      byAction: Object.freeze({
        accept: this.counters.accept,
        strip: this.counters.strip,
        seed: this.counters.seed,
        reject: this.counters.reject,
      }) as Readonly<Record<GateAction, number>>,
      quotesKept: this.counters.quotesKept,
      quotesDropped: this.counters.quotesDropped,
      digitsStripped: this.counters.digitsStripped,
      tombstoned: this.counters.tombstoned,
    })
    const base = {
      available: this.available,
      coreAvailable,
      tombstoneGate: (coreAvailable ? 'service' : 'absent') as 'service' | 'absent',
      logging: this.logStore !== undefined && this.logStore.available,
      logRows: this.logStore === undefined ? 0 : this.logStore.count(),
      counters,
    }
    return Object.freeze({
      ...base,
      ...(this.reason === undefined ? {} : { reason: this.reason }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    })
  }

  /**
   * 墓碑闸：这段正文是否早已被用户要求忘记。
   *
   * 只在结论不是 `reject` 时判——已经要拒的，没有理由再去问一次库。
   * @param verdict 判定结果。
   * @param request 原请求。
   */
  private applyTombstone(verdict: GateVerdict, request: GateRequest): GateVerdict {
    if (verdict.action === 'reject') return verdict
    const core = this.coreOf()
    if (core === undefined || !core.available) return verdict
    const probe = verdict.text === '' ? (typeof request.text === 'string' ? request.text : '') : verdict.text
    try {
      if (!core.tombstoned(probe)) return verdict
    } catch (error) {
      // 查墓碑失败不该让一条真事实被拒——如实记下，放行。
      this.lastError = messageOf(error)
      this.log.warn('查墓碑失败（本条按放行处理）：%s', messageOf(error))
      return verdict
    }
    return Object.freeze({
      ...verdict,
      action: 'reject' as GateAction,
      text: '',
      summary: '',
      reasons: Object.freeze([
        ...verdict.reasons,
        { code: 'tombstoned' as const, detail: '这段内容早已被用户要求忘记（墓碑命中），不许借写入复活' },
      ]),
    })
  }

  /**
   * 累计计数。
   * @param verdict 判定结果。
   */
  private count(verdict: GateVerdict): void {
    this.counters.decisions += 1
    if (verdict.action === 'accept') this.counters.accept += 1
    else if (verdict.action === 'strip') this.counters.strip += 1
    else if (verdict.action === 'seed') this.counters.seed += 1
    else this.counters.reject += 1
    this.counters.quotesKept += verdict.evidence.length
    this.counters.quotesDropped += verdict.dropped.length
    if (verdict.action === 'strip') {
      this.counters.digitsStripped += verdict.digits.filter(item => item.coveredBy === null).length
    }
    if (verdict.reasons.some(item => item.code === 'tombstoned')) this.counters.tombstoned += 1
  }

  /**
   * 写审计日志。**失败不冒泡**。
   * @param verdict 判定结果。
   * @param request 原请求。
   */
  private writeLog(verdict: GateVerdict, request: GateRequest): void {
    const store = this.logStore
    if (store === undefined) return
    const first = verdict.reasons.at(0)
    store.append({
      at: typeof request.at === 'number' ? request.at : this.now(),
      action: verdict.action,
      code: first === undefined ? '' : first.code,
      subject: typeof request.subject === 'string' ? request.subject : '',
      channel: typeof request.channel === 'string' ? request.channel : '',
      text: verdict.text === '' ? (typeof request.text === 'string' ? request.text : '') : verdict.text,
      kept: verdict.evidence.length,
      dropped: verdict.dropped.length,
      digits: verdict.digits.filter(item => item.coveredBy === null).length,
    })
  }
}
