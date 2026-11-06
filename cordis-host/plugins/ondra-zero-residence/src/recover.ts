/**
 * 恢复与展开 —— **纯函数**，只依赖调用方递进来的解析器。
 *
 * ## 「逐字恢复」到底校验什么
 *
 * 两件事，缺一不可：
 *
 * 1. **长度**：恢复出来的码位数必须等于记录里的 `chars`。长度不对，说明取到的
 *    不是原来那一段（或它被截过）。
 * 2. **指纹**：FNV-1a 64 对得上。长度相同而内容不同，只会发生在「同一位置被换成了
 *    等长的另一段」，这是最阴的一种——长度校验会放它过去。
 *
 * 两条都过才叫 `verified: true`。**但取到的东西照样返回**：调用方可能只是要一句
 * 「大概是什么」，而把已经拿到手的正文扔掉、只回一个 `mismatch`，等于让它重新去问。
 * 判断权交出去，事实留下来。
 *
 * ## 展不开的时候为什么不猜
 *
 * 展不开就把指针**原样留下**，并计数。猜一个「大概是这段」进去，等于用一段编造
 * 顶替一条证据；而且它长得和正常内容一样，事后查不出来。
 */

import { charsOf, fnv1a64 } from './pointer.js'
import { pointerRe } from './types.js'
import type { ZrExpandOutcome, ZrRecord } from './types.js'

/** 校验结果。 */
export type ZrVerify = 'ok' | 'length' | 'hash'

/**
 * 校验一段正文是否与记录对得上。
 * @param record 记录（只用到 `chars` 与 `fnv`）。
 * @param text 取回来的正文。
 */
export function verifyRecord(record: Pick<ZrRecord, 'chars' | 'fnv'>, text: string): ZrVerify {
  if (charsOf(text) !== record.chars) return 'length'
  if (fnv1a64(text) !== record.fnv) return 'hash'
  return 'ok'
}

/** 展开时用的解析器：取到就回正文与是否可信，取不到回 undefined。 */
export type ZrResolver = (id: string, chars: number) => { readonly text: string; readonly verified: boolean } | undefined

/**
 * 把一段正文里的所有指针展开。
 * @param text 可能带指针的正文。
 * @param resolve 解析器。
 */
export function expandText(text: string, resolve: ZrResolver): ZrExpandOutcome {
  let pointers = 0
  let resolved = 0
  let unresolved = 0
  let mismatched = 0

  const out = text.replace(pointerRe(), (whole: string, id: string, charsText: string) => {
    pointers += 1
    const found = resolve(id, Number(charsText))
    if (found === undefined) {
      unresolved += 1
      return whole
    }
    resolved += 1
    if (!found.verified) mismatched += 1
    return found.text
  })

  return { text: out, pointers, resolved, unresolved, mismatched }
}
