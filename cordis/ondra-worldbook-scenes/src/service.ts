/**
 * 场景卡服务的门面：解析、缓存、判定、渲染。
 *
 * 四条设计取舍：
 *
 * 1. **卡片只解析一次，换人设才重解析。** `plan()` 每轮都会被调，
 *    在里面读包等于每轮解一次 ZIP——而反模式清单里「在每轮都调的地方做 IO」
 *    正是第一条。这里只比一次 `activeId()`（纯内存），变了才重读。
 *
 * 2. **读文件只经 O-020 的 `readText()`。** 不自己解 ZIP：那会变成第二份
 *    「哪个文件算场景卡」的判定，而两份判定迟早不一致（O-020 处理了编码、
 *    大小上限、包内路径归一化，重写一遍只会更差）。
 *
 * 3. **渲染期剔除「内心」与「触发」。** 见 `types.ts` 文件头第 2 条：
 *    「内心」是推演不是台词；「触发」是给本插件自己看的，进提示词只会让模型
 *    开始解释"我为什么进入这个场景"。
 *
 * 4. **token 数问 O-024，问不到就按字符数当上限。** 自己再写一个换算比例
 *    就是第二真源：同一个字符串在 O-024 与这里量出两个数，谁都不服谁。
 */

import { parseScenes } from './parse.js'
import { extractTerms, extractTitleTerms, isUsableTerm, judge, mergeTerms } from './trigger.js'
import { LAYER_IDS } from './types.js'
import type {
  LayerId,
  LogLike,
  PersonaLoaderLike,
  PlanOptions,
  SceneBlock,
  SceneCard,
  SceneField,
  ScenePlan,
  ScenesService,
  ScenesStats,
  ScenesUnavailableReason,
  WorldbookLike,
} from './types.js'
import type { Config } from './settings.js'

/** 服务依赖。 */
export interface SceneDeps {
  /** 配置（已补全）。 */
  readonly config: Config
  /** 日志。 */
  readonly log: LogLike
  /** 人设加载器（软依赖）。 */
  readonly loader: PersonaLoaderLike | undefined
  /** 世界书（软依赖，只借它的计量器）。 */
  readonly worldbook: WorldbookLike | undefined
}

/**
 * 渲染时**永不进提示词**的栏位（按**基础栏名**比对）。
 *
 * 为什么按基础名：栏名可能带括号补充（`内心（推演）`、`触发（升级）`），
 * 用全名精确比对会被一个括号绕过——而"内心被写进提示词"这件事一旦发生，
 * 用户听到的就是她把心里话念出来，且没人会想到是栏目名多了两个字。
 */
const HIDDEN_FIELDS = new Set(['内心', '触发'])

/**
 * 取栏名的基础部分（去掉括号补充）。
 * @param label 栏名。
 */
export function baseLabel(label: string): string {
  return label.split(/[（(]/)[0].trim()
}

/** 卡片缓存。 */
interface Cache {
  readonly personaId: string;
  readonly file: string;
  readonly cards: readonly SceneCard[];
  readonly unknownLines: number;
  readonly notes: readonly string[];
}

/**
 * 抽一张卡的全部触发词。
 *
 * 三级来源，缺一不可（每一级都是被真实数据逼出来的）：
 * 1. **`触发` 栏**：引号词 + 分隔符切分（`出现"胖""肥""圆滚滚"` 就靠这级）；
 * 2. **标题里的引号**：`被问"你是不是 AI"` —— 哦鲸鲸的 `触发` 栏大多是叙述句
 *    （`用户直接问身份`），逐字匹配永远命中不了，而标题里有用户真正会说的话；
 * 3. **标题短名兜底**：前两级都空时，用 `/` 之前那一段去掉「被」这类前缀
 *    （`被叫醒 / 新会话开场` → `叫醒`）。只在前两级全空时才用，避免把
 *    「曲线 A｜日常」这种排版标题也变成触发词（长度上限 10 字挡住它）。
 * @param card 解析出来的卡。
 * @param minTermChars 最短字数（只作用于 `触发` 栏的非引号词与标题兜底词）。
 */
function termsOf(card: { readonly title: string; readonly titleKey: string; readonly trigger: string }, minTermChars: number): readonly string[] {
  const merged = mergeTerms(
    [extractTerms(card.trigger, minTermChars), extractTitleTerms(card.title)],
    24,
  )
  if (merged.length > 0) return merged
  const fallback = card.titleKey.replace(/^(?:被|在|从|对|和|跟|与)/, '').trim()
  return fallback.length <= 10 && isUsableTerm(fallback, minTermChars) ? [fallback] : []
}

/**
 * 把解析结果落成场景卡。
 * @param parsed 解析结果。
 * @param personaId 人设 id。
 * @param defaultLayer 兜底层。
 * @param minTermChars 触发词最短字数。
 */
function toCards(
  parsed: ReturnType<typeof parseScenes>,
  personaId: string,
  defaultLayer: LayerId,
  minTermChars: number,
): readonly SceneCard[] {
  const safePersona = personaId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32) || 'p'
  return parsed.cards.map(card => ({
    id: safePersona + '-' + card.groupIndex + '-' + card.index,
    title: card.title,
    titleKey: card.titleKey,
    group: card.group,
    groupId: 'g' + card.groupIndex,
    layer: defaultLayer,
    slot: '',
    priority: 0,
    triggers: termsOf(card, minTermChars),
    fields: card.fields,
    raw: card.raw,
    source: 'persona',
    personaId,
  }))
}

/** 场景卡服务实现。 */
export class SceneRepository implements ScenesService {
  private readonly config: Config
  private readonly log: LogLike
  private readonly loader: PersonaLoaderLike | undefined
  private readonly worldbook: WorldbookLike | undefined
  private cache: Cache | undefined
  private failure: ScenesUnavailableReason | undefined

  /**
   * @param deps 依赖。
   */
  constructor(deps: SceneDeps) {
    this.config = deps.config
    this.log = deps.log
    this.loader = deps.loader
    this.worldbook = deps.worldbook
  }

  /** 是否可用。 */
  get available(): boolean {
    if (!this.config.enable) return false
    this.ensure()
    return this.cache !== undefined && this.cache.cards.length > 0
  }

  /** 不可用原因。 */
  get reason(): ScenesUnavailableReason | undefined {
    if (!this.config.enable) return 'disabled'
    this.ensure()
    if (this.cache !== undefined && this.cache.cards.length > 0) return undefined
    return this.failure ?? 'no-card'
  }

  /** 卡片清单。 */
  cards(): readonly SceneCard[] {
    this.ensure()
    return this.cache === undefined ? [] : this.cache.cards
  }

  /**
   * 取一张。
   * @param id 卡 id。
   */
  cardOf(id: string): SceneCard | undefined {
    return this.cards().find(card => card.id === id)
  }

  /** 章节组名。 */
  groups(): readonly string[] {
    const out: string[] = []
    for (const card of this.cards()) {
      if (!out.includes(card.group)) out.push(card.group)
    }
    return out
  }

  /** 重新解析。 */
  refresh(): number {
    this.cache = undefined
    this.failure = undefined
    this.ensure()
    // 显式断言：上面的清空让控制流把 `this.cache` 收窄成了 undefined，而 ensure() 的赋值对类型系统不可见。
    const cache = this.cache as Cache | undefined
    return cache === undefined ? 0 : cache.cards.length
  }

  /**
   * 判定。
   * @param text 来文。
   * @param options 一次性覆盖。
   */
  plan(text: string, options?: PlanOptions): ScenePlan {
    const cards = this.cards()
    if (cards.length === 0) {
      return { hits: [], excluded: [], depth: 0, terms: [], excerpt: '' }
    }
    const plan = judge({
      cards,
      text,
      exclusion: options?.exclusion ?? this.config.exclusion,
      maxDepth: options?.maxDepth ?? this.config.maxDepth,
      guard: this.config.negationGuard,
    })
    if (this.config.reportExcluded && plan.excluded.length > 0) {
      const head = plan.excluded
        .slice(0, 3)
        .map(item => item.title + '→' + item.lostTo + '(' + item.reason + ')')
        .join('、')
      this.log.debug?.('场景互斥淘汰 %d 张：%s', plan.excluded.length, head)
    }
    return plan
  }

  /**
   * 渲染。
   * @param plan 判定结果。
   */
  block(plan: ScenePlan): SceneBlock {
    const chunks: string[] = []
    const ids: string[] = []
    for (const hit of plan.hits) {
      const lines = renderCard(hit.card)
      if (lines.length === 0) continue
      chunks.push(lines.join('\n'))
      ids.push(hit.card.id)
    }
    const text = chunks.join('\n\n')
    return {
      text,
      chars: countChars(text),
      tokens: this.measure(text),
      ids,
    }
  }

  /** 统计快照。 */
  stats(): ScenesStats {
    const cards = this.cards()
    const groups = new Set(cards.map(card => card.groupId))
    const triggerable = cards.filter(card => card.triggers.length > 0).length
    const totalTerms = cards.reduce((sum, card) => sum + card.triggers.length, 0)
    const reason = this.reason
    return {
      available: reason === undefined && cards.length > 0,
      ...(reason === undefined ? {} : { reason }),
      cards: cards.length,
      groups: groups.size,
      triggerable,
      mute: cards.length - triggerable,
      personaId: this.cache === undefined ? null : this.cache.personaId,
      file: this.config.scenesFile,
      exclusion: this.config.exclusion,
      maxDepth: this.config.maxDepth,
      unknownLines: this.cache === undefined ? 0 : this.cache.unknownLines,
      avgTriggers: cards.length === 0 ? 0 : Math.round((totalTerms / cards.length) * 10) / 10,
    }
  }

  /**
   * 量文本：优先问 O-024，问不到就按字符数当**上限**。
   *
   * 按字符数当上限而不是乘一个 0.6 的系数：字符数是 token 的**上界**（任何
   * 分词器都不会把一段中文切成比字数更多的基本单位，除非用单字切分，
   * 那种情况下本来也不该给预算）。宁可高估，也不要造第二套换算比例。
   * @param text 文本。
   */
  private measure(text: string): number {
    if (this.worldbook !== undefined && this.worldbook.available) return this.worldbook.measure(text)
    return countChars(text)
  }

  /** 懒加载：只在人设或文件变了时才重读。 */
  private ensure(): void {
    if (!this.config.enable) return
    if (this.loader === undefined) {
      // 上游消失时**连缓存一起清**：留着旧缓存会让 `available` 继续说"可用"，
      // 而那时任何一次判定都拿不到新数据——这就是「看着正常、其实早断了」。
      this.failure = 'no-loader'
      this.cache = undefined
      return
    }
    if (!this.loader.available) {
      this.failure = 'no-loader'
      this.cache = undefined
      return
    }
    const personaId = this.config.personaId.length > 0 ? this.config.personaId : this.loader.activeId()
    if (personaId === undefined || personaId.length === 0) {
      this.failure = 'no-persona'
      this.cache = undefined
      return
    }
    if (this.cache !== undefined && this.cache.personaId === personaId && this.cache.file === this.config.scenesFile) {
      return
    }
    const text = this.readScenes(personaId)
    if (text === undefined) {
      this.failure = 'no-file'
      this.cache = undefined
      return
    }
    const parsed = parseScenes(text)
    for (const note of parsed.notes) this.log.debug?.('场景解析提示：%s', note)
    if (parsed.unknownLines.length > 0) {
      this.log.warn('场景文件有 %d 行认不出（已跳过，不硬塞进某一栏）：%s', parsed.unknownLines.length, parsed.unknownLines[0])
    }
    const cards = toCards(parsed, personaId, this.layerOf(), this.config.minTermChars)
    if (cards.length === 0) {
      this.failure = 'no-card'
      this.cache = undefined
      return
    }
    this.failure = undefined
    this.cache = {
      personaId,
      file: this.config.scenesFile,
      cards,
      unknownLines: parsed.unknownLines.length,
      notes: parsed.notes,
    }
    const mute = cards.filter(card => card.triggers.length === 0).length
    if (mute > 0) {
      // 这类卡**永远命中不了**，而作者会以为"我写了就该生效"。必须说出来。
      this.log.warn('有 %d 张场景卡一个触发词都没抽出来（永不命中）：给 `触发` 栏加上引号关键词即可', mute)
    }
  }

  /** 兜底层。 */
  private layerOf(): LayerId {
    const value = this.config.defaultLayer
    return (LAYER_IDS as readonly string[]).includes(value) ? (value as LayerId) : 'l4'
  }

  /**
   * 读场景文件。配置路径读不到时，退一步扫包内清单找 `scenes.md`。
   * @param personaId 人设 id。
   */
  private readScenes(personaId: string): string | undefined {
    if (this.loader === undefined) return undefined
    const direct = this.loader.readText(personaId, this.config.scenesFile)
    if (direct !== undefined) return direct
    let fallback: string | undefined
    for (const file of this.loader.files(personaId)) {
      if (!file.path.toLowerCase().endsWith('scenes.md')) continue
      const text = this.loader.readText(personaId, file.path)
      if (text !== undefined) {
        fallback = text
        break
      }
    }
    if (fallback !== undefined) {
      this.log.info('配置路径 %s 读不到，已改用包内找到的场景文件', this.config.scenesFile)
    }
    return fallback
  }
}

/**
 * 渲染一张卡：剔除「内心」与「触发」，其余栏位逐字保留。
 * @param card 卡。
 */
export function renderCard(card: SceneCard): readonly string[] {
  const lines: string[] = ['【场景：' + card.title + '】']
  for (const field of card.fields) {
    if (HIDDEN_FIELDS.has(baseLabel(field.label))) continue
    const value = field.value.trim()
    if (value.length === 0) continue
    lines.push('- ' + field.label + '：' + value)
  }
  return lines.length > 1 ? lines : []
}

/**
 * 渲染时用的「可见栏位」（供界面预览与自检对齐）。
 * @param fields 栏位。
 */
export function visibleFields(fields: readonly SceneField[]): readonly SceneField[] {
  return fields.filter(
    field => !HIDDEN_FIELDS.has(baseLabel(field.label)) && field.value.trim().length > 0,
  )
}

/**
 * 字符数（按码点）。
 * @param text 文本。
 */
function countChars(text: string): number {
  let n = 0
  for (const _ of text) n += 1
  return n
}
