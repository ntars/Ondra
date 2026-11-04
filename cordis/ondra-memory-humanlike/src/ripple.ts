/**
 * 漫无目的联想（水波纹）的**整理层**。
 *
 * 扩散本身归 O-015（`diffuse()`）：它已经做了三件事，本插件**一件都不重做**：
 *
 * 1. **圈权重** `[1, 0.55, 0.3, 0.16]` —— O-015 的 `ringWeightOf()` 已经乘进 `score`。
 *    本插件若再乘一次，第 2 圈就变成 `0.55 × 0.55 = 0.30`，
 *    现象是「水波纹永远只有第一圈」——而权重表本身没错，错在乘了两次。
 * 2. **`surreal` 边排除** —— O-015 的 `neighbors()` 默认 `includeSurreal: false`。
 *    `surreal` 是「偶尔冒出不相干的话」，一旦被当成相关性证据，她就真的开始胡说。
 * 3. **去重与「同一条取最大分」** —— 已在 `diffuse()` 里做完。
 *
 * 本插件只做两件事：**把 id 补成正文**、**按分数稳定排序**。
 *
 * ## 为什么不裁剪条数
 *
 * 「联想」看起来最该砍条数（毕竟它最不可控），但砍条数在这里是**物理删除**：
 * 第 4 圈的第 3 条永远不会出现，而且不报错。装不下是 O-036 装箱制的事，
 * 它会在段标题写「另有 N 条未展开」。本插件一个 `slice` 都不写。
 */

import type { DiffuseResultLike, RippleItem } from './types.js'

/**
 * 把扩散结果整理成可注入的条目。
 *
 * 排序：`score` 降序 → 圈数升序 → id 升序（三级全序，保证同一份数据两次调用结果一致；
 * 只按 `score` 排会在同分时顺序随机，界面上一刷新就换序）。
 * @param result O-015 的扩散结果。
 * @param textOf 按 id 取正文；查不到返回 `null`。
 */
export function arrangeRipple(
  result: DiffuseResultLike,
  textOf: (id: string) => string | null,
): readonly RippleItem[] {
  const items: RippleItem[] = []
  for (const ring of result.rings) {
    for (const item of ring.items) {
      items.push({
        id: item.id,
        text: textOf(item.id),
        ring: item.ring,
        relation: item.relation,
        weight: item.weight,
        score: item.score,
      })
    }
  }

  items.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    if (left.ring !== right.ring) return left.ring - right.ring
    return left.id < right.id ? -1 : 1
  })

  return Object.freeze(items)
}
