/**
 * 服务实现：把「配置 + 临时覆盖 + 上游关系名」合出一张变量表，
 * 再对外提供替换与浓度段。
 *
 * 三个设计取舍：
 *
 * 1. **上游每轮现取（`coreOf()`），不存实例。**
 *    插件装载顺序不确定，`ondra-persona-core` 完全可能在本插件之后才上。
 *    存一个 `undefined` 实例，就等于「谁先装载决定了她怎么称呼你」，
 *    而这种失败在日志里只会表现为「关系名换成空」，查不到根因。
 *
 * 2. **变量值每次都现算，不缓存。**
 *    `{{user}}` 的值取决于用户在设置面板里的那一格，而设置面板随时会改。
 *    缓存它就得处理「配置变了缓存没失效」，而换来的只是省一次字符串拼接。
 *    这里刻意把「便宜且会变」的东西做成现算。
 *
 * 3. **关系名拿不到就留空，不猜。**
 *    `{{relation}}` 在 O-021 缺席时**原样保留**（进 `unresolved`），
 *    而不是退成「朋友」或「她」。猜一个关系名等于替用户决定「她跟你是什么关系」，
 *    而那是设置面板里最不该被代填的一栏。
 */

import { charCount, entriesOf, replacePlaceholders, tableOf } from './vars.js'
import type { VarValue, VarValueTable } from './vars.js'
import { bandOf, clampLevel, toneSectionOf, TONE_BANDS } from './tone.js'
import type { Config } from './settings.js'
import { CHAR_NAME_MAX, USER_ADDRESS_MAX } from './settings.js'
import type {
  LogLike,
  PersonaCoreLike,
  Substituted,
  ToneBand,
  ToneInput,
  ToneSection,
  VarEntry,
  VarsInput,
  VarsService,
  VarsStats,
  VarsUnavailableReason,
} from './types.js'

/**
 * 用户称呼的兜底值。
 *
 * 「你」而不是「主人」或「亲爱的」：兜底值是**所有用户都会看到的那一个**，
 * 它必须不含任何关系预设。人设包自己怎么称呼由内核的「4.6 称呼与自称」定，
 * 这里只是让 `{{user}}` 有一个不空洞的值。
 */
export const DEFAULT_USER_ADDRESS = '你'

/** 错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 变量与浓度服务实现。 */
export class VarsRepository implements VarsService {
  private readonly coreOf: () => PersonaCoreLike | undefined
  private readonly log: LogLike
  private readonly settings: Config

  /**
   * @param coreOf 现取人格内核（每次调用都问一次，见文件头第 1 条）。
   * @param log 日志。
   * @param settings 配置。
   */
  constructor(coreOf: () => PersonaCoreLike | undefined, log: LogLike, settings: Config) {
    this.coreOf = coreOf
    this.log = log
    this.settings = settings
  }

  /** 是否可用。只受总开关影响：没有上游也能替换与出浓度段。 */
  get available(): boolean {
    return this.settings.enable
  }

  /** 不可用原因。 */
  get reason(): VarsUnavailableReason | undefined {
    return this.settings.enable ? undefined : 'disabled'
  }

  /** 三个变量当前的值与来源。 */
  table(input?: VarsInput): readonly VarEntry[] {
    return entriesOf(this.valuesOf(input))
  }

  /** 替换占位符。 */
  substitute(text: string, input?: VarsInput): Substituted {
    const source = typeof text === 'string' ? text : ''
    /*
     * 边界层可以被单独关掉（`substituteInBoundaries`）。
     *
     * 关掉之后**原样返回**，而不是返回空串：调用方拿到空边界会以为人设包坏了。
     * 这条开关的意义只在于「用户想让红线里那个 `{{user}}` 保持字面量」，
     * 所以它只挡 `scope: 'boundary'`，正文一律照旧替换。
     */
    if (this.settings.enable && input?.scope === 'boundary' && !this.settings.substituteInBoundaries) {
      return Object.freeze({
        text: source,
        chars: charCount(source),
        replaced: Object.freeze([]),
        unresolved: Object.freeze([]),
        unknown: Object.freeze([]),
        changed: false,
      })
    }
    if (!this.settings.enable) {
      // 关掉后**原样返回**而不是返回空串：调用方拿到空内核会以为人设包坏了。
      return Object.freeze({
        text: source,
        chars: charCount(source),
        replaced: Object.freeze([]),
        unresolved: Object.freeze([]),
        unknown: Object.freeze([]),
        changed: false,
      })
    }
    const table = this.valuesOf(input)
    const { text: out, stats } = replacePlaceholders(source, table)
    const replaced = [...stats.counts.entries()].map(([name, count]) =>
      Object.freeze({ name, count, source: table[name].source }),
    )
    if (stats.unknown.length > 0) {
      // 报一次就够：同一个未知变量在每段文本里都会出现，逐段报会刷屏。
      this.log.warn(
        '文本里有不认识的占位符：%s（已原样保留；变量只认 {{user}} / {{char}} / {{relation}}）',
        stats.unknown.join(' / '),
      )
    }
    return Object.freeze({
      text: out,
      chars: charCount(out),
      replaced: Object.freeze(replaced),
      unresolved: stats.unresolved,
      unknown: stats.unknown,
      changed: out !== source,
    })
  }

  /** 五个档位的声明。 */
  levels(): readonly ToneBand[] {
    return TONE_BANDS
  }

  /** 取一个档位。 */
  band(level?: number): ToneBand {
    return bandOf(clampLevel(level, this.settings.toneLevel))
  }

  /** 取浓度提示段。 */
  tone(input?: ToneInput): ToneSection {
    const level = clampLevel(input?.level, this.settings.toneLevel)
    return toneSectionOf(level)
  }

  /** 统计快照。 */
  stats(): VarsStats {
    const table = this.valuesOf()
    const tone = toneSectionOf(this.settings.toneLevel)
    const core = this.coreOf()
    return Object.freeze({
      available: this.settings.enable,
      reason: this.settings.enable ? undefined : 'disabled',
      level: this.settings.toneLevel,
      band: tone.band,
      userAddress: table.user.value,
      userSource: table.user.source,
      charName: table.char.value,
      relationLabel: table.relation.value,
      toneChars: tone.chars,
      corePresent: core !== undefined && core.available,
    })
  }

  /**
   * 合出变量值表。优先级：**临时覆盖 > 配置 > 上游 > 兜底**。
   *
   * 为什么临时覆盖排最前：`substitute(text, { userAddress })` 是**预览**语义
   * （设置面板里改了那一格想看看效果），它不该改配置——预览改配置会把
   * 「我只是看看」变成「我改了她的称呼」。
   * @param input 临时覆盖。
   */
  private valuesOf(input?: VarsInput): VarValueTable {
    return tableOf(
      this.userValue(input?.userAddress),
      this.charValue(input?.charName),
      this.relationValue(input?.relationLabel),
    )
  }

  /** 用户称呼：临时 > 配置 > 兜底「你」。**永远有值**，所以永远能替换。 */
  private userValue(wanted: string | undefined): VarValue {
    const fromInput = normalizeWord(wanted, USER_ADDRESS_MAX)
    if (fromInput !== '') {
      return { value: fromInput, source: 'input', note: '本次调用临时指定（预览用，不改配置）' }
    }
    if (this.settings.userAddress !== '') {
      return { value: this.settings.userAddress, source: 'config', note: '你在人设设置里填的称呼' }
    }
    return { value: DEFAULT_USER_ADDRESS, source: 'default', note: '你没设称呼，用兜底值「你」（不含任何关系预设）' }
  }

  /** 她的名字：临时 > 配置 > 空（空则占位符原样保留）。 */
  private charValue(wanted: string | undefined): VarValue {
    const fromInput = normalizeWord(wanted, CHAR_NAME_MAX)
    if (fromInput !== '') {
      return { value: fromInput, source: 'input', note: '本次调用临时指定（预览用，不改配置）' }
    }
    if (this.settings.charName !== '') {
      return { value: this.settings.charName, source: 'config', note: '你在人设设置里填的名字' }
    }
    // 刻意**不**去人设包里读 `displayName` 顶替：那是 O-020 的字段，
    // 而「人设包叫什么」与「她自称什么」是两件事（包名可能是中文目录名）。
    return {
      value: '',
      source: 'unset',
      note: '没设名字，{{char}} 原样保留——不拿人设包名顶替（包名≠自称）',
    }
  }

  /** 关系名：临时 > 上游 O-021 的当前关系变体 > 空。 */
  private relationValue(wanted: string | undefined): VarValue {
    const fromInput = normalizeWord(wanted, 12)
    if (fromInput !== '') {
      return { value: fromInput, source: 'input', note: '本次调用临时指定（预览用，不改配置）' }
    }
    const label = this.relationLabelOf()
    if (label !== '') {
      return { value: label, source: 'persona', note: '来自 ondra-persona-core 的当前关系变体（唯一真源）' }
    }
    return {
      value: '',
      source: 'unset',
      note: '拿不到关系名（ondra-persona-core 缺席或关系 id 未知），{{relation}} 原样保留——不猜一个关系',
    }
  }

  /** 从上游取关系中文名。任何异常都不外抛（组件错误不得传播）。 */
  private relationLabelOf(): string {
    const core = this.coreOf()
    if (core === undefined || !core.available) return ''
    try {
      const relation = core.stats().relation
      const variant = core.variant(relation)
      return variant === undefined ? '' : normalizeWord(variant.label, 12)
    } catch (error) {
      this.log.warn('从人设内核取关系名失败：%s', messageOf(error))
      return ''
    }
  }
}

/**
 * 修一个短词（与 `settings.normalizeShortWord` 同一口径，但**不共享实现**）。
 *
 * 为什么要有一份副本：`settings.ts` 那份处理的是「配置里来的值」，
 * 这份处理的是「调用方临时传来的值」。两者口径必须一致（都压空白、都按码点截断），
 * 但把 `settings.ts` 的导出搬过来会让 `vars`/`tone`/`service` 三个模块
 * 互相绕一圈（现在是单向 `types → settings → vars → tone → service`），
 * 一个纯字符串函数不值得为它破环。**改口径时两处同改**，这条写在文件末尾。
 * @param value 原始值。
 * @param max 长度上限。
 */
function normalizeWord(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const flat = value.replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length <= max ? flat : chars.slice(0, max).join('')
}

/* ------------------------------------------------------------------ *
 * 维护纪律
 *
 * `normalizeWord`（本文件）与 `settings.normalizeShortWord` 是**同一口径的两份实现**，
 * 改一处必须同改另一处。判定它们是否一致的方法很朴素：两个函数体逐字读一遍，
 * 只有「入参来自哪」这件事不同。之所以不复用，是为了保住模块单向依赖链
 * （`types → settings → vars → tone → service`），破环的代价大于重复三行。
 * ------------------------------------------------------------------ */
