/**
 * 手机端情绪引擎的类型底座。
 *
 * ## 为什么是复制而不是 import 桌面版
 *
 * 桌面版的 `types.ts` 有 510 行，里面除了算法需要的 `Axis` / `AXIS_SPEC` /
 * `Temperament`，还有存档结构、事件 schema、诊断格式——那些依赖 Cordis
 * 框架的类型，手机端一个都用不到。整包 import 会把宿主框架拖进 WebView。
 *
 * 所以只搬**算法闭包内**的三个声明，逐字复制、不做改写。两端算出同一个数
 * 的前提是常量与公式完全相同，任何「顺手优化」都会让两边漂开。
 *
 * ## 谁来保证两份不漂
 *
 * `tools/check-local-parity.mjs`：它读桌面版的 `pad.ts` 与手机端的
 * `emotionPad.ts`，逐行比对（忽略 import 行与文件头注释）。改一边忘了
 * 改另一边，那条检查就红。
 */

/** 六个维度。顺序即结算顺序，也是存档里的字段顺序。 */
export const AXES = ['pleasure', 'arousal', 'dominance', 'mood', 'energy', 'tension'] as const

/** 一个维度。 */
export type Axis = (typeof AXES)[number]

/**
 * 各维度的取值范围与基线。
 *
 * `energy` 是 0–100 而其余是 0–1，看着别扭，但这是手册的口径：
 * §3.10 的血清素 recover 规则写的是 `energy > 80`，若内部改成 0–1，
 * 这条规则就变成 `> 0.8`，日后对拍手册时每次都要心算一次除法。
 */
export const AXIS_SPEC: Readonly<Record<Axis, { readonly min: number; readonly max: number; readonly baseline: number }>> =
  Object.freeze({
    /** 愉悦度。0 极不悦 / 0.5 中性 / 1 极愉悦。 */
    pleasure: Object.freeze({ min: 0, max: 1, baseline: 0.5 }),
    /** 唤醒度。0 昏昏欲睡 / 1 紧绷。 */
    arousal: Object.freeze({ min: 0, max: 1, baseline: 0.45 }),
    /** 支配感。0 全然无力 / 1 游刃有余。 */
    dominance: Object.freeze({ min: 0, max: 1, baseline: 0.5 }),
    /** 心情：比 PAD 慢得多的底色，半衰期 6 小时（§3.2）。 */
    mood: Object.freeze({ min: 0, max: 1, baseline: 0.5 }),
    /** 情绪能量：不是体力，是「还提不提得起劲」（§3.10 末句）。0–100。 */
    energy: Object.freeze({ min: 0, max: 100, baseline: 60 }),
    /** 张力：冲突锁的燃料（§3.2 冲突锁定）。0–1。 */
    tension: Object.freeze({ min: 0, max: 1, baseline: 0 }),
  })

/* ------------------------------------------------------------------ *
 * 10 个固定标签
 * ------------------------------------------------------------------ */

/** 十个情绪标签。顺序即存档字段顺序。 */
export const LABELS = ['joy', 'anger', 'sadness', 'fear', 'hurt', 'shy', 'proud', 'moved', 'anxiety', 'bored'] as const

/** 一个标签的名字。 */
export type Label = (typeof LABELS)[number]

/** 标签中文名。只给日志与面板用，**不进提示词**。 */
export const LABEL_ZH: Readonly<Record<Label, string>> = Object.freeze({
  joy: '开心',
  anger: '生气',
  sadness: '难过',
  fear: '害怕',
  hurt: '委屈',
  shy: '害羞',
  proud: '得意',
  moved: '感动',
  anxiety: '焦虑',
  bored: '无聊',
})

/** 标签值上限（§3.2）。超过这个值，情绪就不再是「一点」，而是「整个人被占满」。 */
export const LABEL_MAX = 0.6

/** 标签半衰期（分钟，§3.2）。 */
export const LABEL_HALF_LIFE_MINUTES = 45

/** 气质四旋钮。 */
export interface Temperament {
  /** 敏感度 0.5–2.0：受刺激时皮质醇的飙升乘数。越大越容易上头。 */
  readonly sensitivity: number
  /** 恢复力 0.5–2.0：半衰期乘数，**越大恢复越快**（内部按 `halfLife / resilience` 算）。 */
  readonly resilience: number
  /** 热情 20–80：多巴胺的出厂基线。越大越容易开心。 */
  readonly enthusiasm: number
  /** 代谢 0.5–2.0：慢变量（血清素抽水/回充）的速率乘数。越大情绪转得越快。 */
  readonly metabolism: number
}

/** 出厂气质。与桌面版 `settings.ts` 的默认值一致。 */
export const DEFAULT_TEMPERAMENT: Temperament = Object.freeze({
  sensitivity: 1,
  resilience: 1,
  enthusiasm: 50,
  metabolism: 1,
})