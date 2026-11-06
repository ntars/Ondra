/**
 * 跨组件共用的数据类型。
 *
 * ## 为什么单独一个文件
 *
 * 这些类型原本定义在 `components/Composer.tsx`、`Sidebar.tsx`、
 * `Companion.tsx` 里，被 `lib/useAppState.ts` 反向引用——数据层
 * 反过来依赖视图层，一旦重写某个组件，数据层就编译不过。
 *
 * 它们是**数据的形状**，不是视图的属性。因此迁到这里：
 * 数据层与视图层都从这一处取，任何一层重写都不影响另一层。
 *
 * ## 命名约定
 *
 * 视图自己的 Props 留在各自的组件文件里（它们确实属于那个组件）；
 * 这里只放「会被多处引用」的模型。
 */

/**
 * 权限档位。
 *
 * 与 `api.ts` 的 `PermissionLevel` 是同一个概念，此处不重复定义，
 * 由 `api.ts` 作为真源。这里只做展示文案的映射。
 */
export type { PermissionLevel } from './api.ts'

/** 一个待发送的附件。 */
export interface Attachment {
  id: string
  name: string
}

/** 本轮用量，显示在输入区底部行。 */
export interface ComposerUsage {
  /** 本轮消耗的 token 数。 */
  tokens: number
  /** 缓存命中率，0–100。 */
  cacheHit: number
  /** 上下文占用，0–100。 */
  context: number
}

/**
 * 日志类别。
 *
 * 决定徽章文字与配色。五个值对应「她这一轮做了什么」的五种来源：
 * 节奏、通道、模型、工具、错误。
 */
export type LogChannel = 'rhythm' | 'channel' | 'model' | 'tool' | 'error'

/**
 * 日志时间轴的一行。
 *
 * 同一轮的多条日志共享 `round`，渲染时按它分组——这样用户能看出
 * 「这一轮调了三个工具」而不是看到三条彼此无关联的记录。
 */
export interface LogEntry {
  id: string
  /** 第几轮。 */
  round: number
  /** 发生时间。 */
  at: number
  /** 类别。 */
  channel: LogChannel
  /** 角色：系统 / 你 / 她。 */
  actor: 'system' | 'user' | 'assistant'
  /** 摘要文案。 */
  summary: string
  /** 可展开的完整内容。没有则不显示展开区。 */
  detail?: string
  /** 内容字数。单独存数字便于对齐成一列，拼进文字里就对齐不了了。 */
  chars?: number
  /** 耗时毫秒。思考与回复才有，用于显示「想了 1.2 秒」。 */
  ms?: number
}

/**
 * 心情与精力读数。
 *
 * **0–100 的整数**，不是 0–1 的小数。界面上的水位、数字读数、文字标签
 * 都从这一组值派生，因此三处不可能互相矛盾。
 *
 * `label` 与 `summary` 为空字符串表示「还没有数据」——这时水位显示为 0
 * 但不出现任何数字，避免把「没有数据」画成「数据是零」。
 */
export interface MoodState {
  /** 心情，0–100。 */
  mood: number
  /** 精力，0–100。 */
  energy: number
  /** 情绪的六个字标签。空字符串表示还没有数据。 */
  label?: string
  /** 一句概括。 */
  summary?: string
}

/**
 * 「她对你」的读数。
 *
 * 只有关系阶段与若干维度，**没有称谓、没有相处天数**——
 * 那两项属于人设与叙事，不在这里重复表达。
 */
export interface BondStats {
  /** 关系阶段。空字符串表示还没有数据。 */
  stage?: string
  /** 关系维度。空数组表示还没有读数。 */
  dimensions?: Array<{ key: string; label: string; value: number }>
}

/** 一条记忆。 */
export interface MemoryItem {
  id: string
  /** 记忆正文。 */
  summary: string
  /** 相对时间，如「3 小时前」。 */
  relative: string
}
