/**
 * 分支 A：`lunar-javascript`（MIT，`6tail/lunar-javascript`）。
 *
 * ## 关于「未验证」这件事，必须写在最前面
 *
 * 本仓**禁装依赖**（§16.3），所以这个适配层写完了也**没有在运行期跑过**。
 * 于是这里做了两件事，都是为了「猜错也不能出错」：
 *
 * 1. **每个方法调用前都做存在性检查**（`typeof x === 'function'`）。方法名对不上、
 *    版本漂移、包被裁掉了——都不会抛，只会被判定为 `api-mismatch` 并退出选路。
 * 2. **探测时真取一次今天的农历**。只查方法存在不算数：`Solar.fromYmd()` 存在，
 *    但它可能返回另一种形状（这正是版本漂移的典型形态）。取不到就整枝弃用。
 *
 * 因此本分支的失败形态只有两种：**要么给出农历，要么不参与**——不会给出半对的农历。
 *
 * ## 为什么用 `createRequire` 而不是 `import`
 *
 * 插件是 ESM，`import 'lunar-javascript'` 会让「包没装」从**运行期降级**变成
 * **编译期报错**——整个插件包都编译不过，连公历都用不了。`createRequire` 把
 * 加载推迟到运行期，且 loader 用变量名（TS 不会去做静态解析）。同一手法在
 * `ondra-store-sqlite` 的 `loadSqliteModule()` 里已经用过，口径一致。
 */

import { createRequire } from 'node:module'
import { partsOf } from '../solar.js'
import type { CalendarProvider, LunarSnapshot, LogLike, ProviderStatus } from '../types.js'

/** 任意方法的最小形状。**不写具体签名**：那是别人包里的事，写死了就是编造。 */
type AnyFn = (...args: readonly unknown[]) => unknown

/**
 * `lunar-javascript` 里农历对象的最小形状。
 *
 * 方法全部 optional：任何一个缺席都只是「这一项拿不到」，不是崩溃。
 * 方法名取自其公开文档（`getMonth` / `getDay` / `getJieQi` 等），
 * **本仓未安装故未运行验证**，靠 `typeof` 检查兜底。
 */
interface LunarLike {
  getYearInGanZhi?: AnyFn
  getYearShengXiao?: AnyFn
  getMonth?: AnyFn
  getDay?: AnyFn
  getMonthInChinese?: AnyFn
  getDayInChinese?: AnyFn
  getJieQi?: AnyFn
}

/** 公历对象的最小形状。 */
interface SolarLike {
  getLunar?: () => LunarLike
}

/** 包的主出口。 */
interface LunarModuleLike {
  Solar?: { fromYmd?: (year: number, month: number, day: number) => SolarLike }
}

/** 一次探测的结论。 */
export interface LunarJsProbe {
  /** 可用的分支；不可用时为 `null`。 */
  readonly provider: CalendarProvider | null
  /** 探测结论。 */
  readonly status: ProviderStatus
}

/** 安全调用一个可选方法并读成字符串。 */
function readString(fn: AnyFn | undefined): string {
  if (typeof fn !== 'function') return ''
  try {
    const value = fn()
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

/** 安全调用一个可选方法并读成数字。 */
function readNumber(fn: AnyFn | undefined): number | null {
  if (typeof fn !== 'function') return null
  try {
    const value = fn()
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

/**
 * 尝试接上 `lunar-javascript`。**永不抛错**。
 * @param log 日志。
 */
export function createLunarJsBranch(log: LogLike): LunarJsProbe {
  const failed = (reason: ProviderStatus['reason'], detail: string): LunarJsProbe => ({
    provider: null,
    status: { name: 'lunar-js', ready: false, reason, detail },
  })

  let mod: LunarModuleLike
  try {
    const require = createRequire(import.meta.url)
    // 变量名：让 TS 不做静态模块解析，从而「包没装」不会变成编译错误。
    const specifier = 'lunar-javascript'
    mod = require(specifier) as LunarModuleLike
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return failed('not-installed', `未安装 lunar-javascript（${message}）`)
  }

  const ctor = mod.Solar
  if (typeof ctor?.fromYmd !== 'function') {
    return failed('api-mismatch', 'lunar-javascript 的 Solar.fromYmd 不在位：版本或出口形状不符')
  }
  /**
   * 取某天的农历对象（内部用，失败返回 null）。
   *
   * 用 `ctor.fromYmd(...)` 而不是把方法摘出来存变量：静态方法一旦脱离 `this`，
   * 内部若用到 `this` 就会抛——而那会表现成「农历时有时无」。
   */
  const lunarOfDay = (dayKey: string): LunarLike | null => {
    const { year, month, day } = partsOf(dayKey)
    try {
      const solar = ctor.fromYmd?.(year, month, day)
      const lunar = solar?.getLunar?.()
      return lunar ?? null
    } catch {
      return null
    }
  }

  // 探测必须真取一次：只看方法存在会把「形状漂移」判成可用。
  const today = lunarOfDay(new Date().toISOString().slice(0, 10))
  if (today === null) {
    return failed('api-mismatch', 'Solar.fromYmd().getLunar() 取不到农历对象')
  }
  if (typeof today.getMonth !== 'function' || typeof today.getDay !== 'function') {
    return failed('api-mismatch', '农历对象缺少 getMonth / getDay')
  }
  if (typeof today.getJieQi !== 'function') {
    // 节气是本插件的职责之一（手册 §O-046 明确的「日期事实」含节气）。
    // 少它不致命，但会把「今天立冬」整块静默掉，所以宁可整枝不用。
    return failed('api-mismatch', '农历对象缺少 getJieQi：节气会整块静默，故不启用本分支')
  }

  log.info('农历分支已接上：lunar-javascript（本仓未安装验证，靠运行期探测）')

  return {
    provider: {
      name: 'lunar-js',
      lunarOf(dayKey: string): LunarSnapshot | null {
        const lunar = lunarOfDay(dayKey)
        if (lunar === null) return null
        const rawMonth = readNumber(lunar.getMonth)
        const day = readNumber(lunar.getDay)
        if (rawMonth === null || day === null) return null
        // lunar-javascript 用负数表示闰月（`-5` = 闰五月），转成「月数 + leap 位」。
        const leap = rawMonth < 0
        return {
          yearGanZhi: readString(lunar.getYearInGanZhi),
          shengXiao: readString(lunar.getYearShengXiao),
          month: Math.abs(rawMonth),
          day,
          monthName: readString(lunar.getMonthInChinese),
          dayName: readString(lunar.getDayInChinese),
          leap,
        }
      },
      jieQiOf(dayKey: string): string {
        const lunar = lunarOfDay(dayKey)
        if (lunar === null) return ''
        return readString(lunar.getJieQi)
      },
    },
    status: { name: 'lunar-js', ready: true, detail: '已接上（运行时探测通过）' },
  }
}
