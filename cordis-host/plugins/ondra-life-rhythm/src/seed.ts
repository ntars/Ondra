/**
 * 确定性抽样。**不用 `Math.random()`**。
 *
 * ## 为什么
 *
 * 「10% 概率探索新兴趣」如果用随机数，同一个时间槽每被算一次就换一个结果：
 * 面板刷新一下兴趣就变、日志里写不出「为什么这次是看书」。更糟的是重试——
 * 一轮算 5 次，10% 会被刷成 41%（`1 − 0.9⁵`），而每一行日志都写「抽到探索」。
 *
 * 种子取 `(自然日, 槽号, 盐)`：同一槽内恒定（刷新不改结果），换槽重抽
 * （过 45 分钟该换就换）。这与 O-044 的抽签口径一致（纪律 97）。
 *
 * ## 为什么自己实现哈希
 *
 * FNV-1a 十一行，无依赖、无版本漂移。引一个哈希库只为了十一位运算，
 * 反而多一个要维护的包。
 */

/** 32 位 FNV-1a 偏移基数。 */
const FNV_OFFSET = 0x811c9dc5

/** 32 位 FNV-1a 质数。 */
const FNV_PRIME = 0x01000193

/**
 * 字符串 → 32 位无符号整数。
 * @param text 输入。
 */
export function hash32(text: string): number {
  let hash = FNV_OFFSET
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    // `Math.imul` 保证 32 位乘法不丢精度（普通 `*` 会变成浮点）。
    hash = Math.imul(hash, FNV_PRIME)
  }
  return hash >>> 0
}

/**
 * 把若干段拼成一个种子，取 `[0, 1)` 的确定性小数。
 *
 * 用两个不同的盐各自哈希再拼，是为了避免「换个盐只改最后一位」这种弱种子：
 * 相邻槽号的哈希在 FNV 下分布尚可，但两段拼起来的抖动更均匀。
 * @param parts 种子片段。
 */
export function unitOf(...parts: readonly (string | number)[]): number {
  const key = parts.join('|')
  const high = hash32(key)
  const low = hash32('#' + key)
  // 取两段各 16 位拼成 32 位，再除以 2^32，落在 [0,1)。
  const mixed = ((high & 0xffff) * 0x10000 + (low & 0xffff)) >>> 0
  return mixed / 4294967296
}

/**
 * 时间槽标识：`自然日#槽号`。
 *
 * 槽号按「一天的第几分钟 / 间隔」取整，所以同一槽内的所有调用拿到同一个种子。
 * @param dayKey 自然日键（`YYYY-MM-DD`）。
 * @param minuteOfDay 一天中的第几分钟（0–1439）。
 * @param everyMinutes 槽长（分钟）。
 */
export function slotOf(dayKey: string, minuteOfDay: number, everyMinutes: number): string {
  const span = everyMinutes > 0 ? everyMinutes : 1
  const index = Math.floor(Math.max(0, minuteOfDay) / span)
  return dayKey + '#' + String(index)
}
