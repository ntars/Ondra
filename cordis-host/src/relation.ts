/**
 * 关系域的**宿主侧调用方**。
 *
 * ## 补的是哪条断掉的边
 *
 * `ondra-emotion-stage` 从七阶表、四闸、闭式衰减到存储都写完了，
 * 唯独三个写入口全是零调用方：
 *
 * ```
 * touch()        ← 本轮补的新入口（互动计数）
 * adjust()       ← 全仓零调用方
 * observe()      ← 全仓零调用方
 * ```
 *
 * 后果分三层，每一层都不报错：
 *
 * | 缺的 | 症状 |
 * | --- | --- |
 * | `touch()` | `interactions` 恒 0 → `familiarity` 恒 0 → 弥散公式里那段白写 |
 * | `observe()` | 七阶永远停在「敌意」，四闸一次都没被判定过 |
 * | `adjust()` | 三维只衰减不成长，好感永远在 0.1 附近晃 |
 *
 * 而 `0` 是「陌生人」这个**合法取值**，所以界面上不会出现任何异常——
 * 这正是本仓反复踩的形态：A 写、B 读、中间少根线（第七次）。
 *
 * ## 为什么落笔在宿主，不在插件
 *
 * 插件不知道「一轮对话结束了」这件事：它没有内核句柄，也不该有（§18.5
 * 不 import 邻居、不碰传输层）。宿主是唯一同时知道「用户刚说完一句」
 * 与「关系服务在位」的位置——这与弥散（`src/diffuse.ts`）同一条理由。
 *
 * ## 为什么只做这两件事，不做第三件
 *
 * `adjust()` 的入参是「某个维度增减多少」，而那个数只能由**具体事件**给出
 * （被夸 → 好感 +0.03；被骂 → 信任 −0.05）。当前没有任何模块产出这套 Δ
 * （`ondra-emotion-project` / `-conflict` 都还没装），硬在这里编一套
 * 「每轮好感 +0.01」就是伪造关系成长。所以本轮**只接通有判据可依的两件**：
 * 计数（每轮 +1，客观可数）与升阶判定（四闸全由存量数据判定）。
 *
 * 什么时候接 `adjust()`：等 `ondra-emotion-project` 落地、它产出 Δ 建议时。
 * 那时本文件多一个 `applyProjection()` 的转发，判据仍留在插件里。
 */

import type { Context } from '@ntars/cordis'

/**
 * 关系服务的结构对位子集。
 *
 * 只声明用得到的四个成员：抄一遍完整契约就等于在这里维护第二份形状，
 * 插件加字段时要改两处，漏一处就编译不过——那还是好的，更坏的是
 * 形状对得上、语义已经漂了。
 */
export interface RelationServiceLike {
  readonly available: boolean
  /** 记一次互动。 */
  touch(at?: number): unknown
  /** 判定一次升阶（四闸）。 */
  observe(input?: { readonly locked?: boolean }, at?: number): unknown
  /** 统计快照（诊断用）。 */
  stats(): Record<string, unknown>
}

/** 一次关系推进的结果。给路由与检查脚本读。 */
export interface RelationOutcome {
  /** 关系服务是否在位且可用。 */
  readonly present: boolean
  /** 这一轮有没有真的记上一次互动。 */
  readonly touched: boolean
  /** 这一轮有没有真的判过一次升阶。 */
  readonly observed: boolean
  /** 判完之后当前阶段的人话名（服务缺席时为 `undefined`）。 */
  readonly stageZh?: string
  /** 一句人话，只进日志。 */
  readonly note: string
}

/**
 * 推进一轮关系：先记互动，再判升阶。
 *
 * ## 顺序不可换
 *
 * `observe()` 的四闸里有一道是**互动次数闸**（二阶起要 `minInteractions ≥ 1`）。
 * 先判后记，第一轮永远因为「互动 0 次」卡在敌意阶——而第二轮又因为
 * 已经记过一次而通过，症状是「升阶总是晚一轮」。这个偏差不会报错，
 * 只会让人以为是「她反应慢」。
 *
 * ## 为什么不在这里判「这一轮算不算互动」
 *
 * 判据交给调用点：只有**用户真说了话**的轮次才调本函数。主动开口那一轮
 * （`input` 为空）是她自己说的一句，不该算「相处了一轮」——这与
 * `publishTurn()` 的口径完全一致，两处不各写一套。
 *
 * ## 为什么吞掉异常
 *
 * 关系推进是**附带动作**：这一轮回复已经生成、已经流给界面了。
 * 为了记一个计数把一次成功的对话变成失败，是本末倒置。
 *
 * @param ctx 宿主上下文。
 * @param at 时刻，省略用系统时间。
 */
export function recordTurn(ctx: Context, at?: number): RelationOutcome {
  const moment = at ?? Date.now()
  const service = ctx.get('ondra-emotion-stage') as RelationServiceLike | undefined

  if (service === undefined) {
    return Object.freeze({
      present: false,
      touched: false,
      observed: false,
      note: '关系服务没装载：熟悉度恒 0，七阶不会动',
    })
  }
  if (service.available !== true) {
    return Object.freeze({
      present: false,
      touched: false,
      observed: false,
      note: '关系服务不可用（配置关闭）',
    })
  }

  let touched = false
  let observed = false
  let stageZh: string | undefined
  let note = ''

  try {
    service.touch(moment)
    touched = true
  } catch (error) {
    note = `记互动失败：${error instanceof Error ? error.message : String(error)}`
  }

  try {
    /*
     * 冲突锁的真源在 `ondra-emotion-conflict`（O-030），它当前没装。
     * 传 `undefined` 表示「没在吵架」——插件把 `locked` 当入参而非自有状态，
     * 所以这里不写第二份锁。
     */
    const view = service.observe(undefined, moment) as { readonly spec?: { readonly zh?: string } } | undefined
    observed = true
    stageZh = view?.spec?.zh
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    note = note === '' ? `判升阶失败：${message}` : `${note}；判升阶失败：${message}`
  }

  return Object.freeze({
    present: true,
    touched,
    observed,
    ...(stageZh === undefined ? {} : { stageZh }),
    note: note === '' ? '关系已推进' : note,
  })
}

/** 关系域的诊断读数。三个数并排，才分得开「没装 / 没写 / 没读」。 */
export interface RelationProbe {
  /** 服务在不在。 */
  readonly present: boolean
  /** 降级原因（`undefined` 表示一切正常）。 */
  readonly reason?: string
  /** 累计互动次数。 */
  readonly interactions?: number
  /** 推导出来的熟悉度（0 是「陌生人」这个合法值）。 */
  readonly familiarity?: number
  /** 相处天数。 */
  readonly days?: number
  /** 当前底座阶的人话名。 */
  readonly stageZh?: string
  /** 关系调整 / 互动计数 / 升阶 三个计数器。 */
  readonly counters?: Record<string, unknown>
}

/**
 * 读一次关系诊断。
 *
 * ## 为什么需要它
 *
 * `familiarity` 恒 0 这件事，此前**无处可查**：`available` 是 true、
 * `relation()` 返回得出来、值就是 0，而 0 是合法值。三种成因
 * （服务没装 / 没人调 `touch()` / 宿主没把值传给弥散）症状完全相同。
 *
 * 三个数并排放出来才分得开：
 *
 * | 读到什么 | 结论 |
 * | --- | --- |
 * | `present: false` | 服务没装 → 查默认启用名单 |
 * | `interactions > 0` 而 `familiarity: 0` | 公式或读取断了 |
 * | `familiarity ≠ interactions / 5000` | 两处真源 |
 *
 * @param ctx 宿主上下文。
 */
export function relationProbe(ctx: Context): RelationProbe {
  const service = ctx.get('ondra-emotion-stage') as
    | (RelationServiceLike & {
        relation?: (at?: number) => { readonly familiarity: number; readonly interactions: number; readonly days: number } | undefined
        view?: (at?: number) => { readonly spec?: { readonly zh?: string } } | undefined
        reason?: string
      })
    | undefined

  if (service === undefined) return Object.freeze({ present: false, reason: 'not-loaded' })

  try {
    const stats = service.stats()
    const rel = service.relation?.()
    const view = service.view?.()
    const counters = stats['counters']
    return Object.freeze({
      present: true,
      ...(service.reason === undefined ? {} : { reason: service.reason }),
      ...(typeof rel?.interactions === 'number' ? { interactions: rel.interactions } : {}),
      ...(typeof rel?.familiarity === 'number' ? { familiarity: rel.familiarity } : {}),
      ...(typeof rel?.days === 'number' ? { days: rel.days } : {}),
      ...(typeof view?.spec?.zh === 'string' ? { stageZh: view.spec.zh } : {}),
      ...(counters !== null && typeof counters === 'object' ? { counters: counters as Record<string, unknown> } : {}),
    })
  } catch (error) {
    // 诊断本身失败也要说得出来，不能让它把整条路由拖垮。
    return Object.freeze({ present: true, reason: String(error) })
  }
}
