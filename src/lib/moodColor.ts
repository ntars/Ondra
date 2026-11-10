/**
 * 心情值换算成水位色。
 *
 * ## 为什么从 `Spine.tsx` 抽出来
 *
 * 右侧脊（> 819px）与手机顶栏（≤ 819px）都要画「颜色 = 心情」这件事，
 * 但**同一时刻只有一个可见**。两处各写一份插值，改一处漏一处就会得到
 * 「宽屏是青、手机上偏砂」这种只在缩窗口时看出来的偏差——而那时没人
 * 会想到是两段代码算的。
 *
 * 颜色只在这一处算，两个组件都调它。
 *
 * ## 端点色为什么不读令牌
 *
 * `tokens.css` 的 `--static-water-*` 是 `rgb()` 字符串，插值需要拆成
 * 三个数。CSS 的 `color-mix()` 在各内核支持度不一致（WKWebView 老版本
 * 不支持），放在 JS 里算一次更稳。所以这里保留三元组，值必须与
 * `tokens.css` 的 `--static-water-cold` / `--static-water-warm` 一致，
 * `check-acceptance` 有一条断言比对两边。
 */

/** 一端色值，用于心情插值。 */
interface Rgb {
  r: number
  g: number
  b: number
}

/** 冷端（低落）。浅色主题。 */
const COLD: Rgb = { r: 0x6b, g: 0x7a, b: 0x70 }
/** 暖端（雀跃）。浅色主题。 */
const WARM: Rgb = { r: 0xa3, g: 0x74, b: 0x2c }
/** 冷端。深色主题下整体提亮，否则在深底上沉成一团。 */
const COLD_DARK: Rgb = { r: 0xa3, g: 0xad, b: 0xa5 }
/** 暖端。深色主题。 */
const WARM_DARK: Rgb = { r: 0xd2, g: 0xab, b: 0x74 }

/** 在两色之间按 t ∈ [0,1] 线性插值，返回 `rgb()` 字符串。 */
function mix(from: Rgb, to: Rgb, t: number): string {
  const clamp = Math.min(1, Math.max(0, t))
  const r = Math.round(from.r + (to.r - from.r) * clamp)
  const g = Math.round(from.g + (to.g - from.g) * clamp)
  const b = Math.round(from.b + (to.b - from.b) * clamp)
  return `rgb(${String(r)} ${String(g)} ${String(b)})`
}

/**
 * 心情值换算成水位色。
 *
 * ## 心情的定义域
 *
 * `MoodState.mood` 是 0–100（`types.ts` 写死），而 §5.7 的插值区间是
 * −1..1。这里先把 0–100 映射到 −1..1，再插值：中点 50 是「平静」，
 * 50 以下往冷青走，50 以上往暖砂走。
 *
 * 若直接把 0–100 当 t 用，整条水位会永远停在暖端——
 * 那是个「看起来有颜色、实际没有变化」的假实现。
 *
 * @param mood 心情，0–100。
 * @param dark 当前解析后的主题是不是深色。
 * @returns `rgb()` 字符串，可直接赋给 `background`。
 */
export function waterColor(mood: number, dark: boolean): string {
  const normalized = (mood - 50) / 50
  const cold = dark ? COLD_DARK : COLD
  const warm = dark ? WARM_DARK : WARM
  return normalized < 0 ? mix(warm, cold, -normalized) : mix(cold, warm, normalized)
}

/** 心情词。四档，与 §5.7 的「平静 / 雀跃 / 低落 / 烦躁」一致。 */
export function moodWord(mood: number): string {
  if (mood >= 70) return '雀跃'
  if (mood >= 45) return '平静'
  if (mood >= 25) return '低落'
  return '烦躁'
}

/**
 * 精力换算成 0–1 的比例。
 *
 * 休息态压到 15%（§5.7），无数据为 0。三处（脊、顶栏水位线、
 * 未来的桌宠）都用它，避免「同一个精力画出三种长度」。
 */
export function energyRatio(energy: number, hasData: boolean, resting: boolean): number {
  if (resting) return 0.15
  if (!hasData) return 0
  return Math.min(1, Math.max(0, energy / 100))
}
