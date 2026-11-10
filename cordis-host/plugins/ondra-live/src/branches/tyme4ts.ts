/**
 * 分支 B：`tyme4ts`（MIT，`6tail/tyme4ts`）——**本仓为占位，刻意不接**。
 *
 * ## 为什么这里没有代码
 *
 * 手册 §1.7 要求「`lunar-javascript` / `tyme4ts` 双分支直接复用对拍」。但本仓禁装依赖，
 * 也没有 vendor 过这个包（`grep -r "tyme4ts"` 全仓零命中），于是有一件事无法确认：
 * **它的取值链到底叫什么**。`tyme4ts` 的 API 与 `lunar-javascript` 完全不同
 * （`SolarDay` / `LunarDay` / `LunarMonth` 一层层往下取），且不同小版本改过名字。
 *
 * 在这种情况下有两种写法，只有一种是诚实的：
 *
 * - 照记忆猜 8 个方法名写上去 → 装包后 100% 报 `TypeError`，或者更糟：
 *   猜对了 3 个、剩下 5 个静默返回空，于是**节气有了、农历日是空的**。
 * - 明确写「未确认」，探测时直接判 `skeleton` 并退出选路 → 装包后仍然只用分支 A，
 *   直到有人按它的 `.d.ts` 把下面 6 个取值补齐。
 *
 * 本文件选后者。**不允许凭猜调用第三方 API** 是硬约束（不编造 API 的同一条）。
 *
 * ## 要接上它，只需要补 6 处
 *
 * | 需要的值 | 落点 |
 * |---|---|
 * | 公历日 → 农历日 | `lunarOf()` 里取 `LunarDay` |
 * | 农历月数（1–12） | `LunarMonth.getMonth()`（闰月要单独判） |
 * | 农历日数（1–30） | `LunarDay.getDay()` |
 * | 月中文名 / 日中文名 | `getName()` 一类方法，读成字符串 |
 * | 干支年 / 生肖 | `LunarYear` 上的两个取值 |
 * | 当天节气名 | `SolarDay.getTerm()`（不同版本叫法不同，需按 `.d.ts` 核） |
 *
 * 补齐后把 `ready` 改成探测结果、删掉 `skeleton` 分支即可——`select.ts` 与
 * `service.ts` 一行都不用改（接口唯一，§14.2）。
 */

import type { CalendarProvider, LogLike, ProviderStatus } from '../types.js'

/** 一次探测的结论。 */
export interface Tyme4tsProbe {
  /** 可用的分支；占位期恒为 `null`。 */
  readonly provider: CalendarProvider | null
  /** 探测结论。 */
  readonly status: ProviderStatus
}

/**
 * 探测 `tyme4ts`。
 *
 * **不加载、不调用**：本仓未确认其取值链，任何调用都只能是猜测。
 * 保留 `log` 参数是为了与分支 A 的签名一致（`select.ts` 不必为它写特例）。
 * @param log 日志。
 */
export function createTyme4tsBranch(log: LogLike): Tyme4tsProbe {
  log.debug?.('tyme4ts 分支为占位（本仓未确认取值链），不参与选路')
  return {
    provider: null,
    status: {
      name: 'tyme4ts',
      ready: false,
      reason: 'skeleton',
      detail: '占位分支：本仓未确认 tyme4ts 的取值链，按纪律不凭猜调用（见文件头 6 处补齐点）',
    },
  }
}
