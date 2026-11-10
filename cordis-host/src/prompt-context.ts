/**
 * 运行时上下文注册表 —— 宿主向插件开放的「往系统提示词里挂一段」的接口。
 *
 * ## 它补的是哪一处断口
 *
 * `ondra-prompt-inject` 从写完那天起就在做一件对的事：把八块记忆渲染成
 * 一段正文，挂进宿主的系统提示词。它调的是 `ctx.get('systemPrompt')`，
 * 拿不到就 `ctx.inject(['systemPrompt'], …)` 等它出现。
 *
 * 而宿主这边**从来没有 provide 过这个键**——宿主只是在自己的请求处理函数里
 * 直接调 `assembleSystemPrompt(ctx)`。于是：
 *
 * | 事实 | 症状 |
 * | --- | --- |
 * | `systemPrompt` 零注册 | 插件永远走 `inject` 分支，永远等不到 |
 * | 等不到就打一行 warn | 「注入装箱已就绪但无人阅读」 |
 * | 装箱照常启动、`stats()` 照常可读 | 界面上看它一切正常 |
 * | 唯一的体现 | 她**从来不提**记忆里的任何事 |
 *
 * 这是本仓第六次同形态：**A 写、B 读、中间缺一个位置**。前五次的修法都是
 * 「把位置补上」，而不是在任一端加一个防御。
 *
 * ## 为什么是宿主，不是插件
 *
 * 装配发生在宿主：它是唯一同时看得到全部插件服务、又处在推理请求发起点的
 * 位置（详据见 `system-prompt.ts` 文件头）。既然装配在这儿，那「谁能往里
 * 塞一段」也必须由一个宿主持有的登记表回答。让插件自己拼一份再塞给内核，
 * 就等于在更远的地方重做一遍装配，并多出一份会漂的真源。
 *
 * ## 三条纪律
 *
 * 1. **登记与求值分开。** 插件在装载期登记（此时它不知道自己会不会被调用），
 *    正文在**每一轮装配时**求值。这样「这一轮她想起了什么」才能跟着话头变。
 * 2. **求值失败不影响装配。** 一段上下文抛错，只是这段缺席；其余段照常进。
 *    理由与 `assembleSystemPrompt` 相同：装配失败不该让整轮对话发不出去。
 * 3. **顺序由登记方声明，不在这里重排。** `order` 是插件对「我该排多前」的
 *    判断；宿主再按自己的偏好重排一次，就是第二处真源。同 `order` 时按登记
 *    先后稳定排序——不稳定的排序会让同一份输入产出的提示词每轮不同，
 *    前缀缓存全废。
 */

/**
 * 服务键。
 *
 * 与插件侧 `ondra-prompt-inject` 里 `ctx.get('systemPrompt')` 的字面量**必须
 * 逐字相同**——两侧都不 import 对方源码（§18.5），一致性只能靠这个常量名
 * 与检查脚本钉住。改动这里而不改插件，就是本轮修好的那处断口重新断开。
 */
export const SYSTEM_PROMPT_SERVICE_KEY = 'systemPrompt'

/** 一段运行时上下文的登记项。与 `ondra-prompt-inject` 的接口逐字对位。 */export interface PromptContextEntry {
  /** 名字。用于诊断与去重。 */
  readonly name: string
  /** 排序权重，小的在前。 */
  readonly order: number
  /**
   * 正文，或求值函数。
   *
   * 求值函数收本轮装配上下文：`query` 是本轮用户输入的原文本。
   * 没有轮次时（比如主动开口）`query` 缺席——此时不允许自己编一个检索词。
   */
  readonly text: string | ((context: { readonly query?: string }) => string)
  /**
   * 是否把 `{{…}}` 当提示词变量插值。
   *
   * 缺省**不插值**。记忆正文里出现一个花括号就够了：宿主 `renderPrompt` 会抛
   * `unknown prompt variable`，整次装配失败。默认安全比默认功能重要。
   */
  readonly interpolate?: boolean
  /** 缺省 false：这段为空是正常状态，不该进 `missing`。 */
  readonly required?: boolean
}

/** 注册表对外暴露的形状。这就是插件的 `ctx.get('systemPrompt')` 拿到的对象。 */
export interface SystemPromptRegistry {
  /**
   * 登记一段上下文。
   *
   * @returns 撤销函数。插件通常把它交给 `ctx.effect`，卸载时自动撤。
   */
  context(entry: PromptContextEntry): () => void
}

/** 求值出来的一段。 */
export interface ResolvedContext {
  readonly name: string
  readonly order: number
  readonly text: string
  /** 求值是否抛错。抛错时 `text` 为空串，`error` 带原因。 */
  readonly error?: string
}

/**
 * 注册表本体。
 *
 * 不做成 class 是因为它没有状态机：一个有序数组加一个删除，用对象字面量
 * 就够。多一层 class 只会多一个可以被随手 `new` 的地方。
 */
export class ContextRegistry implements SystemPromptRegistry {
  /** 登记项按 `order` 升序、同 `order` 按登记先后。 */
  private readonly entries: { entry: PromptContextEntry; seq: number }[] = []
  private seq = 0

  context(entry: PromptContextEntry): () => void {
    /*
     * 名字必须是稳定标识。重名不报错——同一插件重复登记（比如热重载）
     * 是正常现象，后登记的生效；这里只在 `resolve()` 里按最后一次出现去重。
     * 报错会让热重载变成「先卸载才能装」，那是不必要的约束。
     */
    const item = { entry, seq: this.seq++ }
    this.entries.push(item)
    let removed = false
    return () => {
      // 撤销函数可能被调用多次（`ctx.effect` 与手动撤各来一次）。
      if (removed) return
      removed = true
      const index = this.entries.indexOf(item)
      if (index >= 0) this.entries.splice(index, 1)
    }
  }

  /** 当前登记了几段。诊断用。 */
  get size(): number {
    return this.entries.length
  }

  /**
   * 登记项的名字快照（按生效顺序）。
   *
   * **与 `resolve()` 的名字不是一回事**：这里说的是「谁登记了」，
   * `resolve()` 产出的是「谁这一轮真有正文」。两者必须分开——
   * 记忆为空时插件照常登记、这一轮却产不出正文，若把两者混成一个数，
   * 「插件挂上了但库是空的」就会看起来和「插件根本没挂上」完全一样。
   *
   * 这条不是洁癖：第一版本这里调的是 `resolve({}).map(…)`，于是空库时
   * 名字列表为空，检查脚本报「登记名不一致」红——**红的是判据，不是代码**。
   */
  names(): string[] {
    const latest = new Map<string, { entry: PromptContextEntry; seq: number }>()
    for (const item of this.entries) latest.set(item.entry.name, item)
    return [...latest.values()]
      .sort((a, b) => a.entry.order !== b.entry.order
        ? a.entry.order - b.entry.order
        : a.seq - b.seq)
      .map(item => item.entry.name)
  }

  /**
   * 求值全部登记项。
   *
   * @param context 本轮装配上下文（含话头）。
   * @returns 按 `order` 升序排列的结果。同名的只保留最后登记的一条。
   */
  resolve(context: { readonly query?: string }): ResolvedContext[] {
    /*
     * 同名去重：从后往前扫，先见到的（后登记的）胜出。
     * 用 Map 的插入顺序再排一次序，保证结果与 `entries` 的物理顺序无关。
     */
    const latest = new Map<string, { entry: PromptContextEntry; seq: number }>()
    for (const item of this.entries) latest.set(item.entry.name, item)

    const sorted = [...latest.values()].sort((a, b) => {
      if (a.entry.order !== b.entry.order) return a.entry.order - b.entry.order
      return a.seq - b.seq
    })

    const out: ResolvedContext[] = []
    for (const { entry } of sorted) {
      let text = ''
      let error: string | undefined
      try {
        text = typeof entry.text === 'string' ? entry.text : entry.text(context)
      } catch (caught) {
        // 一段抛错只是这段缺席。把原因带出去，让装配能说清「为什么少了一段」。
        error = caught instanceof Error ? caught.message : String(caught)
        text = ''
      }
      const trimmed = text.trim()
      /*
       * 空段不产出。注意判 `trim()` 之后——只判 `=== ''` 会让一段纯空白
       * 通过，进提示词后成为段间多出来的空行。
       */
      if (trimmed === '' && error === undefined) continue
      out.push({ name: entry.name, order: entry.order, text: trimmed, ...error === undefined ? {} : { error } })
    }
    return out
  }

  /** 清空。测试与热重载用。 */
  clear(): void {
    this.entries.length = 0
    this.seq = 0
  }
}
