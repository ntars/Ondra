/**
 * 文本小工具。**按码点计数**，不按 UTF-16 单元。
 *
 * 为什么单独一个文件：`charCount` 同时被「校验（判断是否超长）」与「服务（去重比对）」
 * 用到，而 `String#length` 会把一个 emoji 数成 2、把「𠀀」数成 2——
 * 手册的上限是「字」，用户数的也是「字」，不是码元。
 */

/**
 * 按码点数「字数」。
 * @param text 文本。
 */
export function charCount(text: string): number {
  return [...text].length
}

/**
 * 按码点截断。
 * @param text 文本。
 * @param max 上限（字）。
 */
export function cutByCodepoints(text: string, max: number): string {
  if (max <= 0) return ''
  return charCount(text) <= max ? text : [...text].slice(0, max).join('')
}
