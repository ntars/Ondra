/**
 * 小模型那一路：整索引进 prompt，让它挑 slug（手册 §2.3 / 语料二·C）。
 *
 * 三次调用之间的**前缀**必须逐字相同，否则 prefix cache 一次都不命中：
 *
 * ```
 * system = 固定指令 + 索引块 + 结束标记     ← 稳定段，同一份索引下永不变
 * user   = 用户这一句                        ← 唯一易变段，追加在尾部
 * ```
 *
 * 所以：指令里**不写**「最多 N 个」这种会随调用变化的数（写成常量，截断由代码做）；
 * 索引块里**不放**时间戳与条数（见 `types.ts` 文件头第 2 条）。任何一处漏进去，
 * 6k token 就会变成「每次都全价」——而这件事在账单上才看得出来。
 *
 * 另一个必须挡的东西是**幻觉**：模型完全会照着 slug 的样子编一个 `fod-9z9z`。
 * 不过滤就会把不存在的 id 交给 O-014，它 `getFact()` 拿到 `undefined`，
 * 整轮悄悄少一条，日志里一切正常。`hallucinated` 就是让这件事有痕迹。
 */

import type { EntryIndex } from './match.js'
import type { LlmGatewayLike, RecognitionHit, RecognitionOutcome } from './types.js'

/**
 * 固定指令。**改动它等于让所有缓存失效一次**，所以它写成常量并在此声明：
 * 只有「加了新规则」才动，改措辞不值得。
 */
const PICK_INSTRUCTION: readonly string[] = Object.freeze([
  '你在做记忆识别。下面是一份记忆索引，每行一条，格式是「slug 触发词 触发词 …」。',
  '读完用户这一句，从索引里挑出与这句话有关的记忆，输出它们的 slug。',
  '规则：',
  '1. 只输出 slug，每行一个。不要编号，不要解释，不要加任何其他文字。',
  '2. 只能从索引里选，绝对不许自己造 slug。',
  '3. 一条都不相关时，只输出一行：none',
  '4. 最多 8 个。宁可少选：拿不准的不要选。',
  '5. 按相关程度从高到低排列。',
])

/** 索引块与指令之间的分隔（固定文本，属于稳定段）。 */
const INDEX_HEADER = '--- 记忆索引开始 ---'

/** 索引结束标记（固定文本）。模型需要一个明确的边界，否则会接着往下编。 */
const INDEX_FOOTER = '--- 记忆索引结束 ---'

/** 模型一次最多能被采信的条数（与指令里的「最多 8 个」一致，改一处必须同改另一处）。 */
export const PICK_MAX_PICKS = 8

/**
 * slug 的提取正则。
 *
 * 只认 `<2–16 位字母数字>-<4–14 位字母数字>` 这个形状：它足够宽，能接住模型
 * 加上的 `[[ ]]`、`- `、引号、中英文逗号；也足够窄，不会把「相关的记忆是…」
 * 里的中文当成 slug。
 */
const SLUG_TOKEN_RE = /[a-z][a-z0-9]{1,15}-[a-z0-9]{4,14}/gu

/** 拼一次调用用的 system（稳定段）。 */
export function buildSystem(blockText: string): string {
  return `${PICK_INSTRUCTION.join('\n')}\n\n${INDEX_HEADER}\n${blockText}\n${INDEX_FOOTER}`
}

/** 解析结果。 */
export interface ParsedPick {
  /** 命中的记忆 id（保序、去重）。 */
  readonly ids: readonly string[]
  /** 模型一共点了几个（含幻觉、去重前）。 */
  readonly picked: number
  /** 点了但索引里查不到的条数。 */
  readonly hallucinated: number
}

/**
 * 解析模型输出。
 *
 * `none` 的判定放在最前：模型被要求「一条都不相关时输出 none」，
 * 而 `none` 里没有 `-`，本来也匹配不到 slug 正则——这里显式判一次是为了
 * 让「模型说了 none」与「模型什么都没说」在统计上分得开（后者更像协议失败）。
 * @param raw 模型输出正文。
 * @param index 查找索引。
 */
export function parsePicked(raw: string, index: EntryIndex): ParsedPick {
  const text = typeof raw === 'string' ? raw.toLowerCase() : ''
  if (text.trim() === '' || text.trim() === 'none') return { ids: [], picked: 0, hallucinated: 0 }

  SLUG_TOKEN_RE.lastIndex = 0
  const tokens: string[] = []
  let match = SLUG_TOKEN_RE.exec(text)
  while (match !== null) {
    tokens.push(match[0])
    if (match[0] === '') SLUG_TOKEN_RE.lastIndex += 1
    match = SLUG_TOKEN_RE.exec(text)
  }

  const ids: string[] = []
  const seen = new Set<string>()
  let hallucinated = 0
  for (const token of tokens) {
    const entry = index.bySlug.get(token)
    if (entry === undefined) {
      hallucinated += 1
      continue
    }
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    ids.push(entry.id)
  }
  return { ids, picked: tokens.length, hallucinated }
}

/** 一次模型识别的入参。 */
export interface PickInput {
  /** 模型网关。 */
  readonly gateway: LlmGatewayLike
  /** 索引正文（稳定段）。 */
  readonly blockText: string
  /** 索引元数据（回填给调用方，不含正文）。 */
  readonly blockMeta: {
    readonly entries: number
    readonly omitted: number
    readonly revision: string
    readonly estTokens: number
  }
  /** 查找索引。 */
  readonly index: EntryIndex
  /** 用户原话（易变段，不做归一化——模型读原文更准）。 */
  readonly query: string
  /** 输出 token 上限。 */
  readonly maxTokens: number
  /** 采样温度。 */
  readonly temperature: number
  /** 首块超时。 */
  readonly timeoutMs: number
  /** 返回上限。 */
  readonly limit: number
  /** 取消信号。 */
  readonly signal?: AbortSignal
}

/**
 * 跑一次模型识别。
 *
 * 失败一律**转成返回值**（C3：器官/分支错误不得传播）。调用方拿到的永远是一个
 * `RecognitionOutcome`，不会是一个抛出来的异常——这条在注入层尤其重要，
 * 它跑在「下一条消息要发出去」的路径上。
 * @param input 入参。
 */
export async function pickWithModel(input: PickInput): Promise<RecognitionOutcome> {
  const startedAt = Date.now()
  const base = {
    query: input.query,
    hits: [] as readonly RecognitionHit[],
    picked: 0,
    hallucinated: 0,
    block: input.blockMeta,
    elapsedMs: 0,
  }

  if (input.blockText === '') {
    return { ...base, ok: false, reason: 'empty-index', note: '索引为空，没有东西可挑（先让记忆库里有内容）', elapsedMs: Date.now() - startedAt }
  }
  if (input.gateway.available !== true) {
    return {
      ...base,
      ok: false,
      reason: 'gateway-unavailable',
      note: '模型网关不可用：recognition 只剩确定性那一路（同步 search），本轮不调模型',
      elapsedMs: Date.now() - startedAt,
    }
  }

  try {
    const completion = await input.gateway.complete({
      system: buildSystem(input.blockText),
      // 只有一条 user 消息：索引在 system 里、问题在 user 里，这是前缀缓存最省钱的形状。
      messages: [{ role: 'user', content: input.query }],
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    })
    const parsed = parsePicked(completion.text, input.index)
    const hits: RecognitionHit[] = parsed.ids.slice(0, Math.max(1, input.limit)).map((id, position) => ({
      id,
      // 模型只给顺序、不给分。按顺序线性递减，最低 0.5：第 1 名 1.00，第 8 名 0.65。
      // 这条口径在 README「已知限制」里标明是 derived——模型没有分数，编一个是必要的恶，
      // 但要让读的人知道这个数不是模型给的。
      score: Math.max(0.5, 1 - 0.05 * position),
    }))
    return {
      ...base,
      ok: true,
      hits,
      picked: parsed.picked,
      hallucinated: parsed.hallucinated,
      elapsedMs: Date.now() - startedAt,
      note:
        parsed.hallucinated > 0
          ? `模型给了 ${parsed.hallucinated} 个索引里不存在的 slug，已丢弃（这是幻觉，不是命中）`
          : undefined,
    }
  } catch (error) {
    return {
      ...base,
      ok: false,
      reason: 'pick-failed',
      note: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
    }
  }
}
