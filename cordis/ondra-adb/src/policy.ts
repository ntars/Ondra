/**
 * 只读白名单。**本包唯一决定「这条命令能不能跑」的地方。**
 *
 * ## 为什么是白名单，不是黑名单
 *
 * 黑名单要穷举 `insert / update / delete / am / input / screencap / rm / pm /
 * settings put / svc / reboot`……每漏一个就是一次写操作。
 * 而本包要做的事只有一件：读 `content://sms/inbox`。
 * 所以判据写成「**结构必须完全长成那一条**」，其余一律拒绝——
 * 拒绝的代价是「多改一行代码」，放过的代价是「在她手里多了一个能删短信的入口」。
 *
 * ## 为什么必须逐 token 检查 `;` `|` `>` 这类字符
 *
 * `adb shell` 的语义是：**把 argv 用空格拼起来，丢给设备的 sh 再解析一遍**。
 * 于是 `['shell', 'content', 'query', '; rm -rf /sdcard']` 这串在本机看是
 * 三个独立参数（`execFile` 也不会经过本机 shell），但到了设备上就是两条命令。
 * 本机做参数转义**没用**——转义符会在设备侧被再解释一次。
 * 所以凡出现 shell 元字符，直接判 `denied`，**连试都不试**。
 *
 * 这一条同时解释了为什么端口收 `argv` 数组而不是命令串：
 * 收字符串时，白名单只能靠正则猜边界；收数组才能逐 token 判。
 */

import { SMS_URI } from './types.js'

/**
 * 设备侧 sh 会解释的元字符。
 *
 * 刻意包含 `\\`（转义符本身）与 `$`（变量展开）：
 * 它们单独出现也许无害，但一旦与反引号或引号组合就能改掉整条命令的语义，
 * 而白名单的价值恰恰在于「不判断语义，只判断形状」。
 */
const SHELL_META = /[;&|><`$\\\n\r]/

/** 白名单判定的结论。 */
export type PolicyVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false
      /** 违反的是哪一条（日志与面板直接给人看）。 */
      readonly rule: string
      /** 一句中文说明。 */
      readonly detail: string
    }

/**
 * 判定一条命令是否属于「只读短信查询」。
 * @param argv 参数数组（不含 adb 本体）。
 */
export function guardReadOnly(argv: readonly string[]): PolicyVerdict {
  if (argv.length === 0) {
    return { ok: false, rule: 'empty', detail: '命令为空' }
  }
  for (const token of argv) {
    if (typeof token !== 'string') {
      return { ok: false, rule: 'not-string', detail: '参数里混进了非字符串' }
    }
    if (SHELL_META.test(token)) {
      return {
        ok: false,
        rule: 'shell-meta',
        detail: '参数里有 shell 元字符（; & | > < ` $ \\ 或换行）——adb shell 会在设备侧重解析，本机转义无效，一律拒绝',
      }
    }
  }

  if (argv[0] !== 'shell') {
    return { ok: false, rule: 'not-shell', detail: '只允许 `adb shell ...`，其余子命令（push/pull/install/forward…）一律不许' }
  }
  if (argv[1] !== 'content') {
    return { ok: false, rule: 'not-content', detail: '只允许 `content` 工具，其余（am/input/screencap/pm/svc…）一律不许' }
  }
  if (argv[2] !== 'query') {
    return {
      ok: false,
      rule: 'not-query',
      detail: '`content` 只允许 `query`（insert/update/delete/call 都是写或打电话）',
    }
  }

  const uriAt = argv.indexOf('--uri')
  if (uriAt < 0 || argv[uriAt + 1] !== SMS_URI) {
    return {
      ok: false,
      rule: 'not-sms-uri',
      detail: '`--uri` 必须是 content://sms/inbox：别的 provider（联系人、通话记录）本包不读',
    }
  }

  const projectionAt = argv.indexOf('--projection')
  if (projectionAt >= 0) {
    const projection = argv[projectionAt + 1] ?? ''
    // 只允许四列：多要一列就是多读一份隐私（比如 `service_center`、`person`）。
    const allowed = new Set(['_id', 'address', 'body', 'date'])
    for (const column of projection.split(':')) {
      if (!allowed.has(column)) {
        return {
          ok: false,
          rule: 'projection',
          detail: 'projection 只允许 _id / address / body / date 四列',
        }
      }
    }
  }

  return { ok: true }
}

/**
 * 把命令折成一行给人看的文本（日志用）。
 *
 * 这里**不做脱敏**：命令里只有 URI 与列名，不含号码、正文与任何凭据。
 * 真正的隐私在**输出**里，输出从不整段落进日志（见 `sms.ts` 与 `service.ts`）。
 * @param argv 参数数组。
 */
export function describeArgv(argv: readonly string[]): string {
  return ['adb', ...argv].join(' ')
}
