/**
 * 人格演化的**宿主侧调用方**：把「相处了多久」这一个数喂进去。
 *
 * ## 补的是哪条断掉的边
 *
 * `ondra-persona-evolve` 从漂移公式、三层夹紧、可回滚日志到三张表全都写完了，
 * README 连「以前 60 就算开心，后来要 80」的手感表都列好了。它缺的是四样东西，
 * 而四样**全都不报错**：
 *
 * ```
 * ondra-persona-evolve            ← 不在默认启用名单（服务不注册，ctx.get 恒 undefined）
 * noteInteraction()               ← 全仓零调用方（interactions 恒 0，系数恒 ×1.00）
 * thresholdOf() / explainThreshold() ← 全仓零调用方（算得出，没人问）
 * personaState()                  ← 全仓零调用方（特质分不影响提示词）
 * ```
 *
 * 症状是「她永远像第一天认识你」：阈值一个都不涨、特质一个都不动，
 * 而 `×1.00` 是**合法系数**，`0` 是**合法互动数**，所以没有任何一处会报错。
 * 这是本仓第八次踩同一个形态（A 写、B 读、中间少根线）。
 *
 * ## 为什么这里不能再记一份计数（本轮最重要的一条）
 *
 * `ondra-emotion-stage` 的 `touch()` 已经每轮 +1 并落盘，那就是
 * `interactions` 的**唯一真源**。若这里再调 `noteInteraction(1)` 每轮加一次，
 * 两处从不同的起点各自累加，必然漂开——而漂开之后「阈值该按哪个数算」
 * 没有答案，那才是真正的第二真源。
 *
 * 所以本文件只做**单向对齐**：
 *
 * ```
 * emotion-stage.relation().interactions   ← 唯一真源（别人写）
 *              │ 差额
 *              ▼
 * persona-evolve.noteInteraction(diff)    ← 镜像，只加不减
 * ```
 *
 * 差额为负时**不动**（`noteInteraction` 本来就只加不减），只在诊断里
 * 报 `drifted: true`。镜像落后是正常的（刚装上、库被换过），
 * 镜像超前才是需要人看一眼的信号。
 *
 * ## 为什么阈值漂移仍然「不生效」
 *
 * 这是本轮必须写清的一条，否则下一个人会以为装了就生效。
 * 六态的 `STATE_SPECS`（`mood > 0.7` / `energy > 60`）与七阶的 `STAGE_SPECS`
 * （3 / 14 / 30 / 45 / 60 天）**都是各自插件里的常量表**，没有任何一处
 * 接受外面传进来的阈值。所以 `explainThreshold()` 现在算得出「该涨到多少」，
 * 却**没有判定侧读它**。
 *
 * 本轮刻意不去改那两个插件：给判定加可选阈值入参是另一件事，
 * 牵扯两处纯函数签名与各自的常量表归属，值得单独一轮做完并逐条对拍。
 * 在这里假装生效（比如自己算一遍阈值再去判）会立刻造出第三个真源。
 */

import type { Context } from '@ntars/cordis'

/**
 * 人格演化服务的结构对位子集。
 *
 * 只声明用得到的四个成员。抄完整契约等于在这里维护第二份形状，
 * 插件加字段时要改两处——那还是好的；更坏的是形状对得上、语义已经漂了。
 */
export interface EvolveServiceLike {
  readonly available: boolean
  /** 记互动次数（增量，只加不减）。 */
  noteInteraction(n?: number, at?: number): number
  /** 当前互动次数。 */
  interactions(): number
  /** 阈值漂移：只要数。 */
  thresholdOf(key: string, base: number): number
  /** 统计快照。 */
  stats(): Record<string, unknown>
}

/** 关系服务的结构对位子集（只取真源里的那个计数）。 */
export interface RelationSourceLike {
  /** 关系快照。`interactions` 是唯一真源。 */
  relation?(at?: number): { readonly interactions: number } | undefined
}

/** 一次对齐的结果。给路由与检查脚本读。 */
export interface EvolveSyncOutcome {
  /** 人格演化服务是否在位。 */
  readonly present: boolean
  /** 真源（关系服务）是否在位。 */
  readonly sourcePresent: boolean
  /** 这一轮补了多少次互动（0 表示无需补）。 */
  readonly added: number
  /** 对齐之后镜像里的次数。 */
  readonly interactions: number
  /** 真源里的次数（读不到时为 `undefined`）。 */
  readonly source: number | undefined
  /** 镜像是否**超前**于真源（正常不该发生，值得人看一眼）。 */
  readonly drifted: boolean
  /** 一句人话，只进日志与诊断。 */
  readonly note: string
}

/**
 * 把互动次数对齐一次。
 *
 * ## 为什么判据用「差额」而不是「每轮 +1」
 *
 * 每轮 +1 的写法在**第一次运行**就错了：`emotion-stage` 可能已经记了 200 轮，
 * 而 `persona-evolve` 刚从 0 起步，于是阈值系数永远落后 200 轮的量。
 * 差额对齐让「装上的那一刻」就把历史补上，之后每轮差额自然变成 0 或 1。
 *
 * ## 为什么只加不减
 *
 * `noteInteraction()` 的契约就是增量累加，没有「设成多少」的入口。
 * 镜像超前（真源变小）通常意味着库被换过或真源重建过——那是数据事件，
 * 不该由这里静默抹平，只报告不处理。
 *
 * ## 为什么吞掉异常
 *
 * 对齐是**附带动作**：这一轮回复已经生成、已经流给界面了。
 * 为了补一个计数把一次成功的对话变成失败，是本末倒置。判据与
 * `recordTurn()` / `diffuseAcrossSessions()` 同一条。
 *
 * @param ctx 宿主上下文。
 * @param at 时刻，省略用系统时间。
 */
export function syncEvolveInteractions(ctx: Context, at?: number): EvolveSyncOutcome {
  const moment = at ?? Date.now()
  const evolve = ctx.get('ondra-persona-evolve') as EvolveServiceLike | undefined
  if (evolve === undefined) {
    return Object.freeze({
      present: false,
      sourcePresent: false,
      added: 0,
      interactions: 0,
      source: undefined,
      drifted: false,
      note: '人格演化没装载：阈值不漂移，她永远像第一天认识你',
    })
  }
  if (evolve.available !== true) {
    return Object.freeze({
      present: false,
      sourcePresent: false,
      added: 0,
      interactions: 0,
      source: undefined,
      drifted: false,
      note: '人格演化不可用（配置关闭）：阈值按出厂值判',
    })
  }

  // 真源读数。关系服务缺席时**不补**——拿本地计数当尺子就是自证。
  const relation = ctx.get('ondra-emotion-stage') as RelationSourceLike | undefined
  let source: number | undefined
  try {
    const snapshot = relation?.relation?.(moment)
    if (snapshot !== undefined && Number.isFinite(snapshot.interactions)) {
      source = Math.max(0, Math.trunc(snapshot.interactions))
    }
  } catch {
    // 真源读失败按「读不到」处理，不猜一个数。
    source = undefined
  }

  let mirror: number
  try {
    mirror = evolve.interactions()
  } catch {
    return Object.freeze({
      present: true,
      sourcePresent: source !== undefined,
      added: 0,
      interactions: 0,
      source,
      drifted: false,
      note: '读人格演化的互动计数失败（本轮跳过对齐）',
    })
  }

  if (source === undefined) {
    return Object.freeze({
      present: true,
      sourcePresent: false,
      added: 0,
      interactions: mirror,
      source: undefined,
      drifted: false,
      note: '关系服务不在位：互动次数没有真源可对齐，本轮不动',
    })
  }

  const diff = source - mirror
  if (diff === 0) {
    return Object.freeze({
      present: true,
      sourcePresent: true,
      added: 0,
      interactions: mirror,
      source,
      drifted: false,
      note: '已对齐',
    })
  }
  if (diff < 0) {
    return Object.freeze({
      present: true,
      sourcePresent: true,
      added: 0,
      interactions: mirror,
      source,
      drifted: true,
      note: `镜像超前 ${String(-diff)} 次（真源 ${String(source)} < 镜像 ${String(mirror)}）：只报告不抹平`,
    })
  }

  try {
    const next = evolve.noteInteraction(diff, moment)
    return Object.freeze({
      present: true,
      sourcePresent: true,
      added: diff,
      interactions: next,
      source,
      drifted: false,
      note: `补齐 ${String(diff)} 次互动`,
    })
  } catch (error) {
    return Object.freeze({
      present: true,
      sourcePresent: true,
      added: 0,
      interactions: mirror,
      source,
      drifted: false,
      note: `记互动失败：${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

/**
 * 人格演化的诊断读数。
 *
 * ## 为什么必须把 `appliedTo` 单独列出来
 *
 * `interactions` 在涨、`factor` 大于 1，看上去「功能正常」——但可能**没有任何
 * 判定侧读这个系数**。这个字段是为了让「算得出」与「用上了」在读数上
 * 分得开，而不是靠 README 里的一句话。
 *
 * @param ctx 宿主上下文。
 */
export interface EvolveProbe {
  /** 服务在不在。 */
  readonly present: boolean
  /** 降级原因。 */
  readonly reason?: string
  /** 是否可用。 */
  readonly available?: boolean
  /** 镜像里的互动次数。 */
  readonly interactions?: number
  /** 镜像与真源是否一致（真源读不到时为 `undefined`）。 */
  readonly aligned?: boolean
  /** 阈值系数（1.00 – 1.60）。 */
  readonly factor?: number
  /** 漂移进度（0 – 1）。 */
  readonly progress?: number
  /**
   * 这个系数**目前真的被谁用上了**。
   *
   * 2026-11-08 第二十八段之前这里是空数组，那是当时的如实回答：
   * 判定侧阈值全是常量表，没有任何一处读它。现在六态与七阶都接上了。
   *
   * 判据是「那个插件自己报 `drift.applied` 非空」，不是我推的。
   * 系数 `×1.00` 时阈值与出厂逐字相同，此时填上名字就是撒谎——
   * 而那正是最容易发生的情形（刚装、0 次互动）。
   */
  readonly appliedTo: readonly string[]
  /**
   * 各判定侧**自己数出来的**漂移结果。
   *
   * 这是本轮加的第三种证据。前两种都不够：
   * - 「消费方说它接了」是自述，删掉调用它照样这么说；
   * - 「我在这里看它接了」是推断，转手一次就失真。
   *
   * 只有 `asked > 0` 才证明那个调用真的发生了。本仓因为「布尔标志
   * 证明不了那一处真的执行了」踩过五次，这一格是第六次的预防。
   */
  readonly consumers: readonly EvolveConsumer[]
  /** 插件自己的统计。 */
  readonly stats?: Record<string, unknown>
}

/** 一个判定侧消费方报回来的漂移情况。 */
export interface EvolveConsumer {
  /** 插件键。 */
  readonly key: string
  /** 它问过几条阈值。 */
  readonly asked: number
  /** 它真的换掉了几条。 */
  readonly applied: readonly string[]
  /** 它挡回了几条（撞量程 / 乱序）。 */
  readonly rejected: readonly { readonly key: string; readonly why: string }[]
}

/** 读一次人格演化诊断。 */
export function evolveProbe(ctx: Context): EvolveProbe {
  const evolve = ctx.get('ondra-persona-evolve') as
    | (EvolveServiceLike & {
        readonly reason?: string
        interactions(): number
        stats(): Record<string, unknown>
      })
    | undefined

  if (evolve === undefined) {
    return Object.freeze({ present: false, reason: 'not-loaded', appliedTo: [], consumers: [] })
  }

  try {
    const stats = evolve.stats()
    const factor = stats['factor']
    const interactions = evolve.interactions()
    const progress = typeof factor === 'number' && factor > 1
      ? Math.min(1, (factor - 1) / 0.6)
      : 0

    const relation = ctx.get('ondra-emotion-stage') as RelationSourceLike | undefined
    let aligned: boolean | undefined
    try {
      const snapshot = relation?.relation?.()
      if (snapshot !== undefined && Number.isFinite(snapshot.interactions)) {
        aligned = Math.trunc(snapshot.interactions) === interactions
      }
    } catch {
      aligned = undefined
    }

    const consumers = collectConsumers(ctx)
    return Object.freeze({
      present: true,
      ...(typeof evolve.reason === 'string' ? { reason: evolve.reason } : {}),
      available: evolve.available,
      interactions,
      ...(aligned === undefined ? {} : { aligned }),
      ...(typeof factor === 'number' ? { factor } : {}),
      progress,
      appliedTo: Object.freeze(consumers.filter(item => item.applied.length > 0).map(item => item.key)),
      consumers,
      stats,
    })
  } catch (error) {
    return Object.freeze({ present: true, reason: String(error), appliedTo: [], consumers: [] })
  }
}

/**
 * 问两个判定侧「你这一轮实际换掉了几条阈值」。
 *
 * 只读它们的 `stats().drift`，不做任何推断。取不到就当作「没消费」——
 * 缺席与没漂对这里的结论相同（阈值仍是出厂值），而**只有 `asked > 0`
 * 才能区分「调用了但系数是 1」与「调用根本没发生」**。
 * @param ctx 宿主上下文。
 */
function collectConsumers(ctx: Context): readonly EvolveConsumer[] {
  const keys = ['ondra-emotion-express', 'ondra-emotion-stage'] as const
  const out: EvolveConsumer[] = []
  for (const key of keys) {
    const service = ctx.get(key) as { stats?(): Record<string, unknown> } | undefined
    if (service === undefined || typeof service.stats !== 'function') continue
    try {
      const drift = service.stats()['drift'] as
        | { asked?: unknown; applied?: unknown; rejected?: unknown }
        | undefined
      if (drift === undefined) continue
      out.push(
        Object.freeze({
          key,
          asked: typeof drift.asked === 'number' ? drift.asked : 0,
          applied: Array.isArray(drift.applied) ? Object.freeze([...drift.applied]) : Object.freeze([]),
          rejected: Array.isArray(drift.rejected) ? Object.freeze([...drift.rejected]) : Object.freeze([]),
        }),
      )
    } catch {
      // 某个消费方的状态查询失败不该让整条诊断消失。
      continue
    }
  }
  return Object.freeze(out)
}
