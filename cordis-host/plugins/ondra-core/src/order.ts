/**
 * 按依赖顺序排装载清单。
 *
 * ## 为什么需要这一层
 *
 * `loadCore` 原来只按成员清单的**字母序**装。字母序不是依赖序，它对
 * `ondra-memory-prospective`（排第 25 位）与 `ondra-store-sqlite`（排第 68 位）
 * 这种名字恰好逆序的一对，会把「要存储端口的」排在「提供存储端口的」前面。
 *
 * 后果不是报错，是**静默降级**：prospective 在 `apply` 里 `ctx.get('ondra-store-sqlite')`
 * 拿到 `undefined`，于是以 `available=false, reason=no-store` 注册服务；
 * 而 `loadCore` 返回后宿主再读，store 明明在——两侧都能跑，谁都看不出少了什么。
 * 症状是「待办和承诺永远为空」，查起来像产品没做这个功能。
 *
 * ## 为什么写进数据而不是在装载器里写死批次
 *
 * 写死一份「基础层先装」的 id 列表，等于把依赖关系藏进装载器；
 * 下一个插件加进来时没人知道该不该往那份列表里补。写成成员自己的 `after`
 * 字段，依赖就摆在清单上，加插件的人一眼能看见。
 *
 * ## 排序口径
 *
 * 稳定拓扑：反复扫描原清单，把「前置全部已就位」的成员按原序取出。
 * 前置指向**本批未启用**的成员时不算阻塞——要求「必须先装某个没启用的东西」
 * 会让这条链永远排不出来。未就位的就位不了，那就按现状装，插件自己降级。
 *
 * 环不抛错：剩下排不出来的按原序追加，并在末尾交回未排出的 id。
 * 抛错会让整个应用起不来，而环的代价只是「顺序没帮上忙」，那比崩溃轻得多。
 */

import type { CoreMember } from './types.js'

/** 排序结果。 */
export interface OrderResult {
  /** 排好的成员（长度与入参相同）。 */
  readonly ordered: readonly CoreMember[]
  /**
   * 因环而没能排出先后、只能按原序追加的 id。
   *
   * 非空说明清单里的 `after` 有环。不是致命错误，但值得记一条日志：
   * 环上的成员互相等待，顺序对它们没有任何作用。
   */
  readonly unresolved: readonly string[]
}

/**
 * 按 `after` 做稳定拓扑排序。
 * @param list 待排的成员（通常只是本批启用的那些）。
 */
export function orderMembers(list: readonly CoreMember[]): OrderResult {
  const present = new Set(list.map((member) => member.id))
  const done = new Set<string>()
  const ordered: CoreMember[] = []

  // 反复扫描直到没有进展。每轮至少取走一个，最多 n 轮。
  while (ordered.length < list.length) {
    let progressed = false
    for (const member of list) {
      if (done.has(member.id)) continue
      const waiting = (member.after ?? []).some(
        // 前置必须「在本批里」且「还没装」才算阻塞。
        (id) => present.has(id) && !done.has(id),
      )
      if (waiting) continue
      ordered.push(member)
      done.add(member.id)
      progressed = true
    }
    if (!progressed) break
  }

  // 剩下的都在环上（或依赖了环上的成员）：按原序追加，如实报出来。
  const rest = list.filter((member) => !done.has(member.id))
  return {
    ordered: [...ordered, ...rest],
    unresolved: Object.freeze(rest.map((member) => member.id)),
  }
}
