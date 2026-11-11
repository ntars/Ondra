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
import { energyRatio, moodWord, waterColor } from '../lib/moodColor.ts'

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

  /** 水位比例。休息态 15%、无数据 0，换算逻辑归 `moodColor.ts`。 */
  const ratio = energyRatio(energy, hasData, resting)

  return (
    <button
      type="button"
      className="spine"
      aria-label="查看侧写"
      /* 悬停时浏览器原生的即刻说明：水位是精力，颜色是心情（U2 的图例补齐）。 */
      title="精力水位，颜色表示心情；点击查看侧写"
      aria-expanded={inspectorOpen}
      data-resting={resting ? '' : undefined}
      data-busy={busy ? '' : undefined}
      onClick={onToggle}
    >
      <span className="spine__caption">此刻</span>

      {/*
        水位轨道。填充用 scaleY 而非 height：见文件头第 1 条。
        `transform-origin: bottom` 让缩放从底部向上生长。

        内胆（`.spine__well`）与轨道分离：刻度画在轨道外侧，需要轨道
        不能裁切；而液面缩放必须先被裁成圆角，否则 4px 宽的槽会随比例
        被拉成椭圆。两个需求冲突，只能拆成两层。
      */}
      <span className="spine__track" aria-hidden="true">
        <span className="spine__well">
          <span
            ref={fillRef}
            className="spine__fill"
            data-breathe={breathe ? '' : undefined}
            style={{ transform: `scaleY(${String(ratio)})` }}
          />
        </span>
      </span>

      {/*
        读数区。无数据时整块不出现——「还没有数据」不该被画成「数据是零」。
        休息态也不显示精力数字（§5.7 休息态那条）。
      */}
      {!hasData || resting ? (
        <span className="spine__empty">{resting ? '休息中' : '尚无读数'}</span>
      ) : (
        <span className="spine__readout">
          {/*
            水位图例（U2）。

            原先只有一个裸数字「62」，用户无从判断它是什么的量。这里补一行
            「精力」，把数字与它正在表达的东西对上；心情仍由颜色 + 文字各说一遍。
          */}
          <span className="spine__unit">精力</span>
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
