/**
 * 空谷核心的公共类型。
 *
 * 单独成文件是因为 `index.ts` 已经需要为 134 个插件各写一行 import，
 * 再把这些类型定义混在里面会让「清单」和「契约」两件事挤在同一屏。
 */

import type { Context } from '@ntars/cordis'

/**
 * 核心成员。
 *
 * `plugin` 是符合 Cordis 插件契约的对象（含 `name` 与 `apply`），
 * `config` 是传给它的配置。用数组而非逐行 `ctx.plugin()`：
 * 数组可以被遍历、被过滤、被测试断言，而逐行调用只能靠读代码确认。
 */
export interface CoreMember {
  /** 成员标识，用于日志与诊断。 */
  id: string
  /** Cordis 插件对象。 */
  plugin: { name?: string; apply(ctx: Context, config: unknown): unknown }
  /**
   * 必须**先于本成员**装载的成员 id。
   *
   * 只用于「在 `apply` 里同步 `ctx.get()` 取邻居服务」的那类插件。不声明时
   * 按清单原序（字母序）装——字母序不是依赖序，`ondra-memory-prospective`
   * 就因为排在 `ondra-store-sqlite` 前面而静默降级成 `no-store`，
   * 症状是「待办永远为空」，而两侧都不报错。
   *
   * 指向未启用的成员不算阻塞：装着它也没用来供服务，按现状装即可。
   * 排序实现见 `order.ts`。
   */
  after?: readonly string[]
  /** 传给插件的配置。 */
  config?: unknown
  /**
   * 是否默认装载。
   *
   * 允许为 false 的成员存在是有意的：它表示「这个能力属于产品，
   * 但在当前阶段默认关闭」。比从清单里删掉再想起来加回来更可追溯。
   */
  enabled?: boolean
}

/** 装配结果，供宿主记录与界面展示。 */
export interface CoreLoadResult {
  /** 已装载的成员 id。 */
  loaded: string[]
  /** 被跳过的成员 id 及原因。 */
  skipped: Array<{ id: string; reason: string }>
}
