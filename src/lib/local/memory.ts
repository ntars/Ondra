/**
 * 手机端的记忆。
 *
 * ## 保留什么、砍掉什么
 *
 * 桌面版记忆有 12 个插件（提炼、判重、图谱、向量、做梦、自愈、审计……）。
 * 手机端保留**用户能感知的那三件事**：
 *
 * 1. **记得住**——一条事实写进来，按类别与显著度算寿命；
 * 2. **会淡忘**——强度按指数衰减，掉到地板以下仍可查（只忘不删）；
 * 3. **能召回**——按相关度取前若干条拼进提示词。
 *
 * 砍掉的是**用户感知不到的内部机制**：图谱、向量检索、做梦、自愈、
 * 判重的多级相似度。它们让桌面版在几千条记忆时更准，但手机端单会话、
 * 记忆量小，简单过滤 + 打分就够。
 *
 * ## 为什么寿命公式必须与桌面版一致
 *
 * 同一条「明天要交房租」，在手机上和电脑上应该活得一样久。两端公式
 * 不同时，用户会遇到「电脑上还记得、手机上忘了」——而那看起来像 bug，
 * 不像设计。
 */

import { dbList, dbPut, dbRemove, dbClear, localId } from './store.ts'
import type { MemoryCategory, MemoryChannel, MemoryState } from './memoryTypes.ts'
import { MEMORY_CATEGORIES, MEMORY_CHANNELS } from './memoryTypes.ts'
import { stabilityOf, clampSalience, FLOOR_WEIGHT } from './memoryStability.ts'

/** 一条记忆事实。 */
export interface LocalFact {
  id: string
  /** 一句话说清这件事。 */
  text: string
  /** 寿命类别。 */
  category: MemoryCategory
  /** 记忆通道。 */
  channel: MemoryChannel
  /** 显著度 0–100。越高活得越久。 */
  salience: number
  /** 唤醒度 0–1。越高活得越久。 */
  arousal: number
  /** 被提起次数。 */
  timesSaid: number
  /** 检索命中次数。 */
  hits: number
  /** 写入时刻（毫秒）。 */
  createdAt: number
  /** 存续状态。 */
  state: MemoryState
}

/** 新建一条事实时的入参。 */
export interface NewFact {
  text: string
  category?: MemoryCategory
  channel?: MemoryChannel
  salience?: number
  arousal?: number
}

/**
 * 从一句用户的话里认出「值得记的事」。
 *
 * ## 为什么是规则而不是调模型
 *
 * 桌面版用模型提炼（`ondra-memory-extract`）。手机端不调模型有两个理由：
 * 一是每次对话多一次往返，二是**提炼失败时用户没有任何办法知道**——
 * 她只是"没记住"，而这与"记性不好"无法区分。
 *
 * 规则提炼的取舍很明确：宁可漏记，也不乱记。所以只认两类明确的信号：
 *
 * | 信号 | 例 | 归类 |
 * | --- | --- | --- |
 * | 自称 / 称呼 | 「我叫小玖」「你可以叫我阿玖」 | `self` / `person` |
 * | 地点 | 「我住在杭州」「我在北京上班」 | `place` |
 * | 时间承诺 | 「明天提醒我交房租」 | `promise` |
 * | 好恶 | 「我喜欢下雨天」「我不吃香菜」 | `food` / `misc` |
 *
 * 都没命中就返回空数组——**不猜**。
 */
export function extractFacts(input: string): NewFact[] {
  const text = input.trim()
  if (text.length < 3) return []
  const out: NewFact[] = []

  /** 句子切分：只按句末标点，不按逗号——逗号连着的是同一件事。 */
  const sentences = text.split(/[。！？；\n]+/).map((s) => s.trim()).filter((s) => s.length >= 3)

  for (const sentence of sentences) {
    /*
     * ## 一个句子可以命中多个信号
     *
     * 原先每个分支都 `continue`，于是「我叫小玖，住在杭州」只记下名字，
     * 住址那一句被跳过——因为它在同一个句子里（逗号不切句）。
     *
     * 现在改成「依次检查、命中就记、不跳走」：一句话里既说名字又说住址，
     * 两条都该记住。重复靠最后的文本去重挡。
     */
    const nameMatch = /(?:我叫|我的名字是|叫我)\s*([^\s，。！？、]{1,12})/.exec(sentence)
    if (nameMatch !== null) {
      out.push({
        text: `用户的名字是${nameMatch[1]}`,
        category: 'self',
        channel: 'fact',
        salience: 95,
        arousal: 0.6,
      })
    }

    /*
     * 住址 / 常驻地。
     *
     * ## 为什么前缀要列全
     *
     * 原先只有「我住在 / 我住 / 我在」，而「我叫小玖，**住在**杭州」这句话里
     * 根本没有「我住在」——它是逗号后的「住在」。于是住址永远提不出来，
     * 而名字照常记下，症状是「她记得我叫什么，不记得我住哪」。
     *
     * 现在把「住在 / 家在」也列上，并且不要求前缀带「我」。
     *
     * ## 为什么要剥后缀
     *
     * 「我在北京上班」会把「北京上班」整个吃进分组。后缀是动作不是地名，
     * 不剥的话记下来的是「用户在北京上班」——读起来别扭，而且「上班」
     * 会被当成地名的一部分。
     */
    const placeMatch = /(?:我住在|我住|我在|住在|家在)([^\s，。！？、]{2,12})/.exec(sentence)
    if (placeMatch !== null && /(住|上班|工作|读书|生活)/.test(sentence)) {
      const place = (placeMatch[1] ?? '').replace(/(上班|工作|读书|生活)$/, '')
      if (place.length >= 2) {
        out.push({
          text: `用户在${place}`,
          category: 'place',
          channel: 'fact',
          salience: 80,
          arousal: 0.5,
        })
      }
    }

    /* 时间承诺 */
    if (/(记得|提醒我|别忘了|待会|明天|后天|下周)/.test(sentence) && sentence.length <= 60) {
      out.push({
        text: sentence,
        category: 'promise',
        channel: 'gist',
        salience: 85,
        arousal: 0.6,
      })
    }

    /* 好恶 */
    if (/(我喜欢|我不喜欢|我爱|我讨厌|我不吃|我爱吃)/.test(sentence) && sentence.length <= 50) {
      const isFood = /(吃|喝|菜|饭|咖啡|茶)/.test(sentence)
      out.push({
        text: sentence,
        category: isFood ? 'food' : 'misc',
        channel: 'gist',
        salience: 65,
        arousal: 0.55,
      })
    }
  }

  /*
   * 去重。
   *
   * 上面几个分支不再 `continue`，同一个句子可能被两条规则各记一次
   * （例如「我喜欢明天去杭州」同时命中承诺与好恶）。按文本去重，
   * 保留先命中的那条——它的类别更明确。
   */
  const seen = new Set<string>()
  return out.filter((fact) => {
    if (seen.has(fact.text)) return false
    seen.add(fact.text)
    return true
  })
}

/** 存档键前缀。一条记忆一个键。 */
const TABLE = 'memory'

/** 列全部记忆。 */
export async function listFacts(): Promise<LocalFact[]> {
  const rows = await dbList<LocalFact>(TABLE)
  return rows.map((row) => row.value)
}

/** 写一条。 */
export async function addFact(input: NewFact, now: number): Promise<LocalFact> {
  const fact: LocalFact = {
    id: localId('fact'),
    text: input.text,
    category: input.category ?? 'misc',
    channel: input.channel ?? 'gist',
    salience: clampSalience(input.salience ?? 50),
    arousal: typeof input.arousal === 'number' ? Math.min(1, Math.max(0, input.arousal)) : 0.5,
    timesSaid: 1,
    hits: 0,
    createdAt: now,
    state: 'active',
  }
  await dbPut(TABLE, fact.id, fact)
  return fact
}

/** 删一条。 */
export async function removeFact(id: string): Promise<void> {
  await dbRemove(TABLE, id)
}

/** 清空全部记忆。 */
export async function clearFacts(): Promise<void> {
  await dbClear(TABLE)
}

/**
 * 一条记忆在 `now` 时刻的强度（0–1）。
 *
 * 公式：`strength = 0.5 ^ (elapsedHours / stabilityHours)`，地板 0.01。
 *
 * 与桌面版同一个指数回归——两端的"还记得多少"必须能对上账。
 */
export function strengthOf(fact: LocalFact, now: number): number {
  const stability = stabilityOf({
    category: fact.category,
    channel: fact.channel,
    salience: fact.salience,
    arousal: fact.arousal,
    timesSaid: fact.timesSaid,
    hits: fact.hits,
  })
  const elapsedHours = Math.max(0, (now - fact.createdAt) / 3_600_000)
  if (stability.hours <= 0) return FLOOR_WEIGHT
  const raw = Math.pow(0.5, elapsedHours / stability.hours)
  return Math.max(FLOOR_WEIGHT, Math.min(1, raw))
}

/**
 * 取若干条「此刻还亮着」的记忆，按强度降序。
 *
 * ## 为什么按强度排而不是按时间
 *
 * 时间只回答"什么时候记的"，强度回答"她现在还记不记得"。一条一年前
 * 写下但显著度 95 的自述（`self` 基线 20000 小时），比昨天随手记的一条
 * `watch`（基线 2 小时）更该被想起来。
 *
 * @param now 当前时刻。
 * @param limit 最多取几条。
 * @param minStrength 低于这个强度不取。默认 0.05——再低就只剩地板了。
 */
export function recall(facts: LocalFact[], now: number, limit = 8, minStrength = 0.05): Array<{ fact: LocalFact; strength: number }> {
  return facts
    .filter((fact) => fact.state === 'active')
    .map((fact) => ({ fact, strength: strengthOf(fact, now) }))
    .filter((row) => row.strength >= minStrength)
    .sort((left, right) => right.strength - left.strength)
    .slice(0, limit)
}

/**
 * 把召回到的记忆拼成提示词里的一段。
 *
 * ## 为什么要带强度
 *
 * 只列事实时，模型会把它们当成同样确定的背景。而「她记得很牢」与
 * 「她只记得个大概」在表达上应该不同——前者可以直接引用，后者该用
 * 「好像」「我记得」。强度换算成三档词，模型据此调整措辞。
 */
export function memoryPrompt(facts: LocalFact[], now: number): string {
  const picked = recall(facts, now)
  if (picked.length === 0) return ''
  const lines = picked.map(({ fact, strength }) => {
    const tone = strength >= 0.6 ? '' : strength >= 0.25 ? '（记得比较模糊）' : '（只记得个大概）'
    return `- ${fact.text}${tone}`
  })
  return `## 你记得的事\n${lines.join('\n')}`
}

/** 校验一个类别名是否合法。导入外部数据时用。 */
export function isCategory(value: unknown): value is MemoryCategory {
  return typeof value === 'string' && (MEMORY_CATEGORIES as readonly string[]).includes(value)
}

/** 校验一个通道名是否合法。 */
export function isChannel(value: unknown): value is MemoryChannel {
  return typeof value === 'string' && (MEMORY_CHANNELS as readonly string[]).includes(value)
}