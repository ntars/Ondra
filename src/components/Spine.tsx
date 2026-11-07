/**
 * 右侧脊（Spine）。
 *
 * ## 它表达什么
 *
 * 一条 6 × 150 的水位 + 三个读数。水位高度是精力，颜色是心情，
 * 文字标签把颜色再说一遍（§5.7：颜色永不单独承载信息）。
 *
 * ## 三条容易做错的地方
 *
 * 1. **用 `transform: scaleY()` 而不是 `height`**。改 `height` 会触发重排，
 *    60fps 下每帧一次重排，滚动时会掉帧；`scaleY` 只在合成层做变换。
 * 2. **无数据时不画成 0**。没有心跳时水位为 0 且**不出现任何数字**——
 *    「数据是零」和「没有数据」是两件完全不同的事，画成一样就是撒谎。
 * 3. **颜色由 JS 插值后写入 `--specific-water`**，组件不自己算色。
 *    插值需要两端令牌的色值，CSS 里 `color-mix()` 目前在各内核的支持度
 *    不一致，放在 JS 里算一次更稳。
 */

import { useEffect, useRef } from 'react'
import { useResolvedTheme } from '../lib/useResolvedTheme.ts'

/** 一端色值，用于心情插值。取值与 `tokens.css` 的 `--static-water-*` 一致。 */
const WATER_COLD = { r: 0x5b, g: 0x7a, b: 0x73 }
const WATER_WARM = { r: 0xb0, g: 0x8a, b: 0x5a }
const WATER_COLD_DARK = { r: 0x8f, g: 0xb0, b: 0xa6 }
const WATER_WARM_DARK = { r: 0xd4, g: 0xb2, b: 0x85 }

/** 一条 RGB 三元组。 */
interface Rgb {
  r: number
  g: number
  b: number
}

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
 */
function waterColor(mood: number, dark: boolean): string {
  const normalized = (mood - 50) / 50
  const cold = dark ? WATER_COLD_DARK : WATER_COLD
  const warm = dark ? WATER_WARM_DARK : WATER_WARM
  return normalized < 0 ? mix(warm, cold, -normalized) : mix(cold, warm, normalized)
}

/** 心情词。四档，与 §5.7 的「平静 / 雀跃 / 低落 / 烦躁」一致。 */
function moodWord(mood: number): string {
  if (mood >= 70) return '雀跃'
  if (mood >= 45) return '平静'
  if (mood >= 25) return '低落'
  return '烦躁'
}

export interface SpineProps {
  /** 心情，0–100。 */
  mood: number
  /** 精力，0–100。 */
  energy: number
  /** 记忆条数。0 表示没有记忆，此时不显示计数。 */
  memoryCount: number
  /** 是否有真实读数。false 时水位不呼吸、不显示数字。 */
  hasData: boolean
  /** 是否正在生成。生成中暂停呼吸（她在想，呼吸该停，§5.7）。 */
  busy: boolean
  /** 检查器是否展开。展开时暂停呼吸（正在看数字，不该晃）。 */
  inspectorOpen: boolean
  /** 是否休息态（`absence` 判定）。 */
  resting: boolean
  /**
   * 是否处于一键静音期（§12.12、§5.7「静音态」）。
   *
   * 静音**不影响呼吸**：静音关掉的是声音，不是她的在场感。水位照常呼吸，
   * 只在下方多一行「静音」——把静音画成「她睡了」是两件不同的事，
   * 而睡眠已有 `resting` 那一档专门表达。
   */
  muted: boolean
  /**
   * 今天是否已经进入「安静」（§7.4：连续拒绝 3 次 → 当日停止主动消息）。
   *
   * ## 为什么不复用 `muted`
   *
   * 两者在脊上都显示一行字，但**原因完全不同**：静音是用户按下的开关，
   * 有明确截止时刻，一小时后自己恢复；安静是她今天被拒绝了三次而退场，
   * 到零点才重置。把它们画成同一个词，用户就永远分不清「为什么她今天
   * 不说话了」——是我不小心按了静音，还是我被判定为不想理她。
   *
   * ## 与静音同时成立时显示哪一个
   *
   * 显示静音。它是更强的约束（用户明确要求「别出声」），
   * 而且有截止时刻可查；两行一起挂会让脊看起来像出错了。
   */
  quietToday: boolean
  /** 点击整条脊。 */
  onToggle(): void
}

/**
 * 渲染右侧脊。
 *
 * 整条脊是一个按钮而不是 div + 内部按钮：§5.7 明确「整条脊可点，
 * 点击任意位置展开检查器」。做成一个按钮后，键盘只需一次 Enter，
 * 读屏也只念一次。
 */
export function Spine({
  mood,
  energy,
  memoryCount,
  hasData,
  busy,
  inspectorOpen,
  resting,
  muted,
  quietToday,
  onToggle,
}: SpineProps): React.JSX.Element {
  const fillRef = useRef<HTMLDivElement | null>(null)

  /**
   * 当前**解析后**的主题，不是用户的选择。
   *
   * 用 `useResolvedTheme` 而不是直接读 `props`：用户选「跟随系统」时，
   * 界面是深是浅取决于系统偏好，只有 `<html data-theme>` 知道答案。
   * 主题一变，水位的两个端点色也要跟着换。
   */
  const dark = useResolvedTheme() === 'dark'

  const color = waterColor(mood, dark)

  /**
   * 写 CSS 变量而不是内联 `background`。
   *
   * 直接写 `style.background` 会让「悬停提亮到不透明度 1」这条规则
   * 无法用 CSS 表达（内联样式优先级高于样式表）。写变量后，
   * 颜色与不透明度分属两个来源，各自可覆盖。
   */
  useEffect(() => {
    fillRef.current?.style.setProperty('--specific-water', color)
  }, [color])

  /** 呼吸是否该停。四个条件逐条对应 §5.7 的暂停清单。 */
  const reduced =
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
  const breathe = hasData && !busy && !inspectorOpen && !reduced && !resting

  /** 水位比例。休息态压到 15%，无数据为 0。 */
  const ratio = resting ? 0.15 : hasData ? Math.min(1, Math.max(0, energy / 100)) : 0

  return (
    <button
      type="button"
      className="spine"
      aria-label="查看侧写"
      aria-expanded={inspectorOpen}
      data-resting={resting ? '' : undefined}
      onClick={onToggle}
    >
      <span className="spine__caption">此刻</span>

      {/*
        水位轨道。填充用 scaleY 而非 height：见文件头第 1 条。
        `transform-origin: bottom` 让缩放从底部向上生长。
      */}
      <span className="spine__track" aria-hidden="true">
        <span
          ref={fillRef}
          className="spine__fill"
          data-breathe={breathe ? '' : undefined}
          style={{ transform: `scaleY(${String(ratio)})` }}
        />
      </span>

      {/*
        读数区。无数据时整块不出现——「还没有数据」不该被画成「数据是零」。
        休息态也不显示精力数字（§5.7 休息态那条）。
      */}
      {!hasData || resting ? (
        <span className="spine__empty">{resting ? '休息中' : ''}</span>
      ) : (
        <span className="spine__readout">
          <span className="spine__energy">{Math.round(energy)}</span>
          <span className="spine__mood">{moodWord(mood)}</span>
          {memoryCount > 0 ? <span className="spine__memory">记忆 {memoryCount}</span> : null}
        </span>
      )}

      {/*
        静音行（§5.7 静音态）。
        独立于读数区渲染：静音与「有没有数据」是两件事，没有心跳读数时
        静音照样成立。放在读数区外面，才不会因为无数据而整块消失。

        「今天安静」与静音共用同一个位置（见 `quietToday` 的注释）：
        静音优先，两者不同时显示。
      */}
      {muted ? <span className="spine__muted">静音</span> : null}
      {!muted && quietToday ? <span className="spine__muted">今天安静</span> : null}

      {/* 悬停时浮现的一行提示（§5.7）。纯装饰，读屏不念。 */}
      <span className="spine__hint" aria-hidden="true">查看侧写</span>
    </button>
  )
}
