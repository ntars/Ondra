/**
 * 字符串工具：字符计数与「拼接口径对拍」。
 *
 * 这个文件很小，但 `sameKernel()` 是整插件最要紧的一次判断，单独放出来是因为
 * 它需要一个**与 O-021 完全一致的归一化口径**，而这个口径必须能被逐字读到、
 * 被单独对拍——埋在 `sections.ts` 的三层循环里就没人敢动它了。
 *
 * `sameKernel()` 要回答的问题：**我按六个槽位拼出来的内核，和 O-021 `compose()`
 * 给出的内核段，是不是同一份东西？** 只有一致，按槽位裁剪才安全；
 * 不一致就整段带上（`kernel-mismatch`），宁可超预算也不猜。
 */

/**
 * 字符数（按码点算，中文一个字算一个）。
 *
 * 不用 `String.length`：它数的是 UTF-16 码元，emoji 与增补平面汉字都算 2。
 * 预算按「用户感知的字数」算，差一个 emoji 就差 1 个字，在 2600 的预算上不起眼，
 * 但「边界层单独就超了」这种判定会对不上——而那种判定是给人看的。
 * @param text 文本。
 */
export function charCount(text: string): number {
  return Array.from(text).length
}

/**
 * 归一化：**只抹掉段落之间的空行差异**，其余一个字不动。
 *
 * 为什么允许这一处差异：O-021 的 `kernelTextOf()` 用的是 `parts.join('\n\n')`，
 * 而本插件按槽位分开携带，最后也用 `\n\n` 拼——理论上逐字相同。
 * 但若上游哪天改成 `join('\n')` 或去掉某段前后的空行，直接字符串比对会报
 * 不一致，于是**退化成整段带上**（一个静默的、永久的性能退化）。
 * 抹掉空行差异能让这条判定只对「内容本身变了」敏感。
 * 反之，标点、空格、标题、顺序**一律不归一**——那些变了就是真的变了。
 * @param text 文本。
 */
export function normalizeBlank(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/, ''))
    .filter(line => line.trim() !== '')
    .join('\n')
}

/**
 * 两段内核是不是同一份。
 * @param left 本插件按槽位拼出来的。
 * @param right 上游 `compose()` 给出的。
 */
export function sameKernel(left: string, right: string): boolean {
  return normalizeBlank(left) === normalizeBlank(right)
}

/**
 * 去掉段标题后的正文（用于「段标题不算内容」的场合）。
 * @param text 正文。
 */
export function trimBlank(text: string): string {
  return text.replace(/^[ \t]+/gm, '').replace(/\s+$/, '')
}
