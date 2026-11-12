/**
 * 系统提示词装配 —— 全仓**唯一**的一处。
 *
 * ## 这个文件为什么必须存在
 *
 * 在此之前，`inference.run` 只把 `history` 与一句可选的 `nudge` 交给模型，
 * 全仓没有任何地方拼系统提示词。于是三件本该早就生效的事全部空转：
 *
 * | 已经写好、有测试、有文档的东西 | 空转的症状 |
 * | --- | --- |
 * | `ondra-persona-assemble` 的四段人格（近 4k 字） | 产得出来，**没有人要** |
 * | `ondra-organ-host.prompt()` 的片段（疤痕/执念/感知/规矩） | `fragments` 恒为 0 |
 * | `ondra-memory-prospective.fragment()` 的承诺上下文 | 接了也是假的，没有消费者 |
 * | `ondra-emotion-project.project()` 的六态投影 | 产得出来，**没有消费者**（第二十九段补上） |
 *
 * 这不是「少接一根线」，而是**没有那根线的位置**。所以本轮先把位置定下来。
 *
 * ## 归属判定：为什么在宿主，不在内核，也不在界面
 *
 * 三个候选各有否决理由，这一节写清依据，避免下一轮再翻一遍：
 *
 * 1. **内核（`dsh-sidecar`）不行。** 它是独立进程，**不加载插件系统**，
 *    拿不到 `ctx.get('ondra-persona-assemble')`。让内核拼，就得把人格数据
 *    通过 stdio 每轮传过去——那是把装配搬到上游，只是在更远的地方重做一遍，
 *    还要多一份协议字段。内核的职责边界（见 `kernel/index.ts` 文件头）也已写明
 *    「只做四件事：推理循环、工具调用、会话存储、模型适配」。
 *
 * 2. **界面（`src/`）不行。** 人格与器官片段都在宿主进程里，界面要拼就得
 *    为每一轮多发几次请求，而「这一轮她到底收到了什么」会散成三段跨进程的
 *    数据。更关键的是：主动开口那一轮**没有用户输入**，界面此时甚至不一定是
 *    活着的（§12.10 通知就是从隐藏的 WebView 发的），拼不出来。
 *
 * 3. **器官宿主（`ondra-organ-host.prompt()`）不行——它只拼片段。**
 *    人格四段归 `ondra-persona-assemble`，两者各是一份真源（见两个插件的
 *    契约文件头：都明确写着「不 import 对方源码，只做结构对位」）。
 *    硬把一边塞进另一边，就是在这个仓库最忌讳的「两处真源」上再叠一层。
 *
 * 所以归属是**宿主**：它是唯一同时看得到全部插件服务、又处在推理请求
 * 发起点的位置。它不生产内容，只做**取材与拼接**——内容永远归插件。
 *
 * ## 三条纪律
 *
 * 1. **只拼，不写。** 本文件不生成任何一句人格文案。所有正文都来自插件。
 * 2. **缺席不编造。** 插件可用就直接取；不可用就记一条 `missing` 说明，
 *    绝不补一句「你是一个温柔的助手」——补出来的假人设比没有人设更坏，
 *    因为它会让「人格链断了」这个事实彻底看不见。
 * 3. **每轮重取，不缓存。** 预算、浓度、关系、执念都可能在两轮之间变化。
 *    缓存会让「改了设置没反应」以一种最难查的方式复现。
 */

import type { Context } from '@ntars/cordis'
import { assembleEmotionBlock } from './emotion.js'
import { takeDreamTalk } from './dream.js'
import { SYSTEM_PROMPT_SERVICE_KEY } from './prompt-context.js'
import type { ResolvedContext } from './prompt-context.js'

/** 拼好的系统提示词。 */
export interface SystemPrompt {
  /*
   * 使用方式：把它作为**第一条 `system` 消息**放进 `inference.run` 的
   * `system` 参数，内核会插在整段历史之前。
   *
   * ## 为什么走 `system` 参数而不是拼进 `messages`
   *
   * `messages` 是**会话历史**，会原样落盘、下次读回来再喂一遍。系统提示词若
   * 塞进去，就等于每轮往历史里追加一份人格——三轮之后模型会收到三份人格，
   * 而且会话文件会膨胀到无法阅读。`system` 参数的生命周期严格等于本次运行，
   * 与 `nudge` 的处置口径一致（见内核 `InferenceRun` 的注释）。
   */
  /** 最终正文；空串表示没有任何来源可用（此时不该发 system 消息）。 */
  readonly text: string
  /** 字符数（按码位）。 */
  readonly chars: number
  /**
   * 各段来源的取用情况。**这是「她这轮收到了什么」的可核对版本**，
   * 用于诊断与「提示词预览」，不发给模型。
   */
  readonly parts: readonly SystemPromptPart[]
  /** 缺席的来源与原因。`parts` 里缺席的项在这里各有一条。 */
  readonly missing: readonly string[]
  /**
   * 人格是否因预算被裁掉了整段。
   *
   * ## 为什么这个状态必须单独暴露
   *
   * 它原本记录的是一个**真实的产品残缺**：默认预算 2600 下「说话」段
   * （2169 字）被整段砍掉，模型知道「她是谁」，却读不到「她怎么说话」——
   * 而插件、装配、装配报告三处都不报错，只有 `overBudget: true`。
   *
   * 那道残缺已在 2026-11-08 第二十段修掉（默认预算 2600 → 12000，实测
   * 一份人设包完整装载需 7,725–10,057 字）。**但这个字段保留**，因为
   * 用户仍然可以自己把预算调低，或换一个远超 12000 字的人设包。
   *
   * 保留它的理由与当初引入时一样：不做这个字段的代价是——用户装上人设包，
   * 然后她说话不像，而**没有任何一处告诉他为什么**。
   */
  readonly truncated: boolean
}

/** 一段的来源记录。 */
export interface SystemPromptPart {
  /**
   * 段 id。
   *
   * 三段的顺序即数组顺序，**不可换**：
   * 1. `persona` —— 她是谁（跨会话不变，稳定前缀）；
   * 2. `fragments` —— 疤痕 / 执念 / 感知 / 规矩（变，但慢）；
   * 3. `context` —— 插件登记的运行时上下文（记忆注入等，随话头变）；
   * 4. `emotion` —— 这一轮该怎么开口（每轮都变，必须在尾部，§8.5）。
   *
   * `context` 排在 `emotion` **之前**：情绪是「这一轮的语气指令」，
   * 放在最尾才压得住前面所有内容（§8.5 的易变段追加尾部）。
   * 记忆正文若排在情绪之后，就会出现「先告诉她此刻烦躁、再给她一堆
   * 关于你的旧事」——顺序一反，语气指令就不再是最后一句了。
   */
  readonly id: 'persona' | 'fragments' | 'context' | 'emotion'
  /** 中文名（界面可直接显示）。 */
  readonly label: string
  /** 字符数。 */
  readonly chars: number
  /** 正文。 */
  readonly text: string
}

/** 人格装配服务的结构对位子集（只取 `assemble().text` 与状态）。 */
interface AssembleLike {
  readonly available: boolean
  readonly reason?: string
  assemble(input?: { readonly budgetChars?: number }): {
    readonly text: string
    readonly chars: number
    /** 装配报告。插件契约里它是必填；写成可选是为了容忍契约升级时的字段缺失。 */
    readonly report?: {
      readonly overBudget?: boolean
      readonly droppedCount?: number
    }
  }
}

/** 器官宿主的结构对位子集（只取 `prompt()` 与状态）。 */
interface OrganHostLike {
  readonly available: boolean
  prompt(options?: { readonly maxFragments?: number }): {
    readonly text: string
    readonly chars: number
    readonly fragments: readonly unknown[]
  }
}

/**
 * 片段数上限。
 *
 * 与器官宿主的默认值是两个概念：那里防的是「一个器官申报两千片」，
 * 这里防的是「片段把人格挤到上下文很后面」。人格是第一段，片段在它之后，
 * 所以这个上限只需保证片段不会长到让人格显得像开场白。
 */
const MAX_FRAGMENTS = 24

/**
 * 装配这一轮的系统提示词。
 *
 * @param ctx Cordis 根上下文；用来取两个插件服务。
 * @param query 本轮用户输入的原文本。插件登记的记忆检索上下文靠它做话头；
 *   主动开口那一轮没有用户输入，缺席即缺席，**不编一个检索词**。
 * @returns 拼装结果。永不抛错——装配失败不该让整轮对话发不出去。
 */
export function assembleSystemPrompt(ctx: Context, query?: string): SystemPrompt {
  const parts: SystemPromptPart[] = []
  const missing: string[] = []
  let truncated = false

  // ① 人格四段（内核 → 关系微调 → 浓度 → 边界）。
  //
  // 放在最前是硬规则：`ondra-persona-assemble` 的契约文件头写着「四段顺序恒为
  // 内核 → 关系微调 → 浓度 → 边界」，且它已经把边界层整层豁免裁剪。
  // 这里只把它给出的整段正文接过来，不再二次切分——切一次就多一处会漂的真源。
  const persona = ctx.get('ondra-persona-assemble') as AssembleLike | undefined
  if (persona === undefined) {
    missing.push('人格：没有装载 ondra-persona-assemble')
  } else if (!persona.available) {
    // 常见原因是 `no-core`（人设包没装到位）。如实报，不假装有人在。
    missing.push(`人格：装配不可用（${persona.reason ?? '未知原因'}）`)
  } else {
    try {
      const assembled = persona.assemble()
      const text = assembled.text.trim()
      if (text === '') {
        // 可用但空产：这是「人设包在、槽位全空」的状态，与缺席不同，
        // 但同样不能凭空补。分开报，免得排查时以为是没装载。
        missing.push('人格：装配可用但产出为空（人设包可能缺槽位）')
      } else {
        parts.push({ id: 'persona', label: '人格', chars: assembled.chars, text })
        /*
         * 记下「被裁过」这件事。判据是插件自己报的两个字段，不在这里重算：
         * `overBudget` 与 `droppedCount` 是它装箱的结果，宿主观测一遍预算
         * 就等于在别人家里立第二套边界（§8.2 反模式）。
         */
        const report = assembled.report
        if (report?.overBudget === true || (report?.droppedCount ?? 0) > 0) {
          truncated = true
        }
      }
    } catch (error) {
      missing.push(`人格：装配抛错（${error instanceof Error ? error.message : String(error)}）`)
    }
  }

  // ② 器官片段（疤痕 / 执念 / 感知 / 规矩）。
  //
  // 排在人格之后：疤痕虽是 `SCAR_ORDER = -1e4` 在最前，但那说的是**片段之间**
  // 的排序。人格是「她是谁」，必须在片段之前——否则模型先读到一条禁令，
  // 再读人格，语气会被禁令压成合规报告。这正是 §10 第 8 条修掉的旧缺陷。
  const organ = ctx.get('ondra-organ-host') as OrganHostLike | undefined
  if (organ === undefined) {
    /*
     * **不写进 `missing`。** 这条原先是 `missing.push('片段：没有装载 ondra-organ-host')`，
     * 于是每一轮的装配结果里都恒定躺着一条「缺项」——而它缺得理直气壮：
     * 本仓目前**没有任何器官注册**，`ondra-organ-host` 出厂关闭是刻意的
     * （理由写在 `cordis-host/index.ts` 的 `DEFAULT_CORE_ENABLE` 注释里）。
     *
     * 判据在「这是缺陷还是设计」：`missing` 的语义是「本该有、这次没拿到」，
     * 不是「这个可选能力当前没开」。混进去的后果不是报错，而是**告警通胀**——
     * 常驻一条假红之后，真缺项出现时也没人看（同文件里「上下文缺席不进
     * `missing`」「情绪块拒绝产出不进 `missing`」两条用的是同一个理由）。
     */
  } else if (!organ.available) {
    missing.push('片段：器官宿主不可用')
  } else {
    try {
      const assembled = organ.prompt({ maxFragments: MAX_FRAGMENTS })
      const text = assembled.text.trim()
      if (text === '') {
        // 空产是**正常状态**（此刻没有器官申报片段），不写进 `missing`：
        // 把它当异常会让每一轮都带一条假的告警，久了就没人看了。
        // 真正该看的是 `ondra-organ-host.stats()`，那里能分清「没申报」与「全被丢弃」。
        void assembled.fragments
      } else {
        parts.push({ id: 'fragments', label: '片段', chars: assembled.chars, text })
      }
    } catch (error) {
      missing.push(`片段：拼装抛错（${error instanceof Error ? error.message : String(error)}）`)
    }
  }

  // ③ 运行时上下文（插件登记的段落：记忆注入等）。
  //
  // 这一段是「她这轮想起了什么」。`ondra-prompt-inject` 把这八块记忆渲染成
  // 一段正文，通过宿主提供的 `systemPrompt` 服务登记进来（见 `prompt-context.ts`
  // 文件头：在那之前宿主从未 provide 过这个键，于是它等了整整一版）。
  //
  // 排在情绪之前（理由见 `SystemPromptPart.id` 的说明）。
  //
  // 缺席**不进 `missing`**：没有登记任何上下文是正常状态（比如精简 profile
  // 没装记忆插件）。把它当缺项会让每一轮都带一条假告警。
  const registry = ctx.get(SYSTEM_PROMPT_SERVICE_KEY) as { resolve(c: { query?: string }): ResolvedContext[] } | undefined
  if (registry !== undefined) {
    let resolved: ResolvedContext[] = []
    try {
      resolved = registry.resolve(query === undefined ? {} : { query })
    } catch (error) {
      // 注册表自己抛错是宿主代码的问题，不是插件的问题。说出来，别静默。
      missing.push(`上下文：注册表求值抛错（${error instanceof Error ? error.message : String(error)}）`)
    }
    const texts: string[] = []
    for (const item of resolved) {
      if (item.error !== undefined) {
        // 单段抛错：这一段缺席，其余照常。带名字，才能查是哪一个插件。
        missing.push(`上下文：${item.name} 求值失败（${item.error}）`)
        continue
      }
      texts.push(item.text)
    }
    if (texts.length > 0) {
      const text = texts.join('\n\n')
      parts.push({ id: 'context', label: '上下文', chars: [...text].length, text })
    }
  }

  /*
   * ③-b 梦话（并进 `context` 段的**尾部**，紧随记忆注入之后）。
   *
   * ## 为什么并进 context 而不是新起一段
   *
   * `SystemPromptPart.id` 的四个值是装配契约的一部分（`persona` / `fragments` /
   * `context` / `emotion`），前端分段显示与 `ondra-dialogue` 的 `prefix.ts`
   * 都按这四个值判。新加第五个值要么改契约、要么让某处静默漏一段；
   * 而梦话在产品含义上本来就是「她想起的一件事」，归 `context` 最准。
   *
   * ## 为什么必须排在情绪**之前**
   *
   * 情绪是**行为指令**（今天怎么开口），梦话是**内容材质**（提一句就好）。
   * 指令必须压住内容——若梦话排在情绪之后，一句「梦里想起一片海」
   * 会盖掉「今天话少一点」。这与 §8.5「易变段追加尾部」不矛盾：
   * 情绪是这些易变段里**最需要被最后读到**的那一段。
   *
   * ## 取出即标记，所以这里**只能调一次**
   *
   * `takeDreamTalk()` 有副作用（标记已注入）。本函数每轮只调一次，
   * 但如果将来有人把装配结果缓存起来复用，梦话就会在第一轮被取走、
   * 之后再也不出现——而「不出现」与「本来就没有梦话」症状完全相同。
   */
  const talk = takeDreamTalk(ctx)
  if (talk !== undefined) {
    /*
     * 用 `find` 而不是 `findIndex`：本仓开了 `noUncheckedIndexedAccess`，
     * `parts[index]` 的类型是 `SystemPromptPart | undefined`，取出来还要再判一次。
     * 直接拿对象引用，就地替换那一格，少一处「理论上不会是 undefined」。
     */
    const existing = parts.find(part => part.id === 'context')
    if (existing !== undefined) {
      const merged = `${existing.text}\n\n${talk.text}`
      const at = parts.indexOf(existing)
      parts[at] = { ...existing, chars: [...merged].length, text: merged }
    } else {
      parts.push({ id: 'context', label: '上下文', chars: talk.chars, text: talk.text })
    }
  }

  // ④ 情绪块（**必须在最后**）。
  //
  // 手册 §8.5：稳定段在会话开头，易变段追加尾部。人格跨会话不变、器官片段变得慢，
  // 而投影**每轮都变**——排在前面等于每轮把几千字的稳定前缀搅掉一遍。
  //
  // 它同时是「情绪的唯一文本出口」：六态在 `ondra-emotion-express`（出参数），
  // 一段话只在本插件出。两段行为指令同时进提示词会互相打架，所以这里只取一处。
  //
  // 缺席不写 `missing`：情绪块拒绝产出是**正常产品行为**（这几分钟她状态空档、
  // 用户问了数值、模板被改坏），每分钟记一条假告警会让真正该看的行淹掉。
  // 该看的是 `projectionProbe()` 的 `counters`。
  const emotion = assembleEmotionBlock(ctx)
  if (emotion.part !== undefined) {
    parts.push(emotion.part)
  }

  // 段之间用空行连接：与 `ondra-dialogue` 的 `joinStable()` 同一口径（`\n\n`）。
  // 换分隔符会让同一份人格在不同机器上产生不同指纹，前缀缓存互不认。
  //
  // 情绪块例外：它自己的正文与约束句之间只隔一个 `\n`（见 `assembleEmotionBlock`），
  // 因为那两行是**同一个块**的两部分，不是两段独立内容。
  const text = parts.map(part => part.text).join('\n\n')
  /*
   * 字符数按**码位**算（`[...text].length`），不按 `text.length`：
   * 后者是 UTF-16 码元数，遇到 emoji 会把一个字算成两个。插件侧用的是同一口径，
   * 两处数字才能对得上——这里不另写一个 `charCount()` 函数，是因为本仓已有
   * 一份实现（`ondra-persona-assemble/text.ts`），再写一份就是第二处真源。
   */
  return { text, chars: [...text].length, parts, missing, truncated }
}
