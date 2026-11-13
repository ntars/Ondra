/**
 * 数值字段的步长。
 *
 * ## 为什么不能一律写 1
 *
 * `<input type="range" step="1">` 在浏览器里不是「建议」而是**硬约束**：
 * 值会被吸附到 `min + n × step`。全仓 57 个字段的取值范围是 0–1 或 0–2
 * 的小数（`temperature` 0.8、`merge-threshold` 0.4、`floor-weight` 0.01），
 * 写 `step="1"` 的后果是**滑杆一碰就把 0.8 改成 1**——用户拖都没拖，
 * 值已经变了，而且界面上没有任何提示。
 *
 * `<input type="number" step="1">` 更糟：值不合法但**不拦输入**，
 * 只是让它进入 `:invalid` 状态。当前样式表没有 `:invalid` 规则，
 * 所以屏幕上一切正常，只有点上下箭头时跳到 0 或 1、把原值覆盖掉。
 * 这两种失败都发生在「用户以为什么都没做」的时刻。
 *
 * ## 为什么按精度推导而不是让插件声明
 *
 * 步长是 `min` / `max` / `default` 的**函数**，不是独立信息：
 * 一个取值范围 0–1、默认 0.8 的字段，步长只能是 0.01 或更细，
 * 写成 1 是自相矛盾。让插件再声明一次 `step` 等于给同一件事
 * 开第二个真源，而两份声明一定会分叉（声明了 min/max 却忘写 step
 * 的字段会成为下一个 bug）。所以这里从已有声明推导。
 *
 * ## 为什么取三者的最大小数位
 *
 * 只取 `default` 会漏掉「默认是整数、但范围是小范围」的字段
 * （如 `min: 0.0001, default: 0.01` 取 default 得 2 位，
 * 而 0.0001 那档就选不到了）。取 `min` / `max` / `default` 的最大值，
 * 保证声明里出现过的每一个数都能被精确选中。
 */

/**
 * 一个数需要几位小数才能精确表示。
 *
 * 用 `String()` 而不是 `toString(2)` 之类：这个函数只服务**声明里的字面量**
 * （0.8、0.35、0.0001），不是计算结果，所以十进制字符串就是精确的。
 *
 * 科学计数法要单独处理：`String(1e-7)` 是 `"1e-7"`，直接数小数点后的
 * 位数会得到 0。这是极端值，但不处理就会把步长推成 1。
 */
function decimalsOf(value: number): number {
  if (!Number.isFinite(value) || Number.isInteger(value)) return 0
  const text = String(Math.abs(value))

  const expAt = text.indexOf('e-')
  if (expAt >= 0) {
    const mantissa = text.slice(0, expAt)
    const exponent = Number(text.slice(expAt + 2))
    const dotAt = mantissa.indexOf('.')
    const mantissaDecimals = dotAt < 0 ? 0 : mantissa.length - dotAt - 1
    return Number.isFinite(exponent) ? mantissaDecimals + exponent : 0
  }

  const dotAt = text.indexOf('.')
  return dotAt < 0 ? 0 : text.length - dotAt - 1
}

/** 步长下限。再细的档位用数字框直接输入，滑杆给不了那个分辨率。 */
const MIN_STEP = 1e-6

/**
 * 按字段的取值声明推导步长。
 *
 * @param min 下界。缺省按 0。
 * @param max 上界。缺省按 100。
 * @param fallback 出厂默认值。缺省视为整数——没有默认值时不该凭空引入小数。
 * @returns 10 的负整数次幂（0.01、0.1…）或 1。
 */
export function stepOf(min: number, max: number, fallback: unknown): number {
  const def = typeof fallback === 'number' && Number.isFinite(fallback) ? fallback : 0
  const decimals = Math.max(decimalsOf(min), decimalsOf(max), decimalsOf(def))
  if (decimals === 0) return 1
  /* 位数过深时退到下限：1e-20 这种步长在滑杆上没有意义，也让 value 对不齐。 */
  return Math.max(MIN_STEP, Number((10 ** -decimals).toFixed(decimals)))
}