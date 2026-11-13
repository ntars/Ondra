/**
 * 服务实现：从上游取两段 + 边界，按槽位切内核，交装箱，出四段与报告。
 *
 * 四个设计取舍：
 *
 * 1. **上游每轮现取（`coreOf()` / `varsOf()`），不存实例。**
 *    插件装载顺序不确定。存下来的 `undefined` 会让「谁先装载」决定
 *    「这一轮她有没有人格」，而这种失败在日志里只会表现为「有点不像」。
 *
 * 2. **不缓存拼装结果。** 预算、浓度档、关系、称呼，任何一处变了，
 *    结果就必须变。缓存它就要处理「哪个配置改了要失效」——
 *    而提示词拼装的调用频率是「每轮一次」，缓存收益远小于它引入的风险。
 *    真正贵的是「读包 + 切槽位」，那件事已经由 O-021 缓存好了（§8.5）。
 *
 * 3. **内核按槽位裁，但先对拍。** 只有「六槽位拼起来 === O-021 的内核段」才按槽位裁；
 *    不一致就整段带上并报 `kernel-mismatch`。理由见 `text.ts` 的 `sameKernel()`。
 *
 * 4. **降级要说清，不许静默。** 上游缺席、槽位缺失、超预算、边界层单独超预算——
 *    四件事全部进 `report.degradations`，且都能被 `stats()` 与日志读到。
 */

import {
  boundaryUnit,
  composeAssembly,
  emptyAssembly,
  extraUnit,
  kernelWholeUnit,
  relationUnit,
  priorityOf,
  slotUnit,
  toneUnit,
} from './sections.js'
import { charCount, sameKernel } from './text.js'
import { clampBudget } from './settings.js'
import { BUDGET_PRESETS, SECTION_IDS } from './types.js'
import type {
  AssembleInput,
  AssembleService,
  AssembleStats,
  AssembleUnavailableReason,
  AssembledPrompt,
  AssemblyUnit,
  BudgetPreset,
  Degradation,
  LogLike,
  PersonaCoreLike,
  PersonaVarsLike,
  SectionId,
} from './types.js'
import type { Config } from './settings.js'

/** 错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 来源是否来了（取到且 `available`）。 */
function usable<T extends { readonly available: boolean }>(source: T | undefined): source is T {
  return source !== undefined && source.available
}

/** 四段字数全零的快照。 */
const ZERO_CHARS: Readonly<Record<SectionId, number>> = Object.freeze({
  kernel: 0,
  relation: 0,
  tone: 0,
  boundaries: 0,
})

/** 四段拼装服务实现。 */
export class AssembleRepository implements AssembleService {
  private readonly coreOf: () => PersonaCoreLike | undefined
  private readonly varsOf: () => PersonaVarsLike | undefined
  private readonly log: LogLike
  private readonly settings: Config

  /** 上一次的观察值（只用于 `stats()`，不参与拼装）。 */
  private lastUsedChars = 0
  private lastOverBudget = false
  private lastDroppedCount = 0
  private lastSectionChars: Readonly<Record<SectionId, number>> = ZERO_CHARS

  /**
   * @param coreOf 现取人格内核（见文件头第 1 条）。
   * @param varsOf 现取变量与浓度。
   * @param log 日志。
   * @param settings 配置。
   */
  constructor(
    coreOf: () => PersonaCoreLike | undefined,
    varsOf: () => PersonaVarsLike | undefined,
    log: LogLike,
    settings: Config,
  ) {
    this.coreOf = coreOf
    this.varsOf = varsOf
    this.log = log
    this.settings = settings
  }

  /** 是否可用。 */
  get available(): boolean {
    if (!this.settings.enable) return false
    const core = this.coreOf()
    return usable(core)
  }

  /** 不可用原因。 */
  get reason(): AssembleUnavailableReason | undefined {
    if (!this.settings.enable) return 'disabled'
    const core = this.coreOf()
    return usable(core) ? undefined : 'no-core'
  }

  /** 三个预算预设。 */
  presets(): readonly BudgetPreset[] {
    return BUDGET_PRESETS
  }

  /** 当前生效的预算。 */
  budget(): number {
    return this.settings.budgetChars
  }

  /** 拼四段。 */
  assemble(input?: AssembleInput): AssembledPrompt {
    const budgetChars = clampBudget(input?.budgetChars, this.settings.budgetChars)
    const includeHeadings = input?.includeHeadings ?? this.settings.includeHeadings

    if (!this.settings.enable) {
      const result = emptyAssembly(
        budgetChars,
        Object.freeze([
          Object.freeze({ kind: 'no-core' as const, note: '总开关被关（enable=false）：不拼装任何段落' }),
        ]),
      )
      this.remember(result)
      return result
    }

    const core = this.coreOf()
    if (!usable(core)) {
      const result = emptyAssembly(
        budgetChars,
        Object.freeze([
          Object.freeze({
            kind: 'no-core' as const,
            note: '没有装载 ondra-persona-core（O-021）或它不可用：没有任何人格可拼',
          }),
        ]),
      )
      this.remember(result)
      return result
    }

    const degradations: Degradation[] = []
    // 显式收窄：`usable()` 的结果存进布尔变量后，闭包里再用 `vars.substitute` 时
    // TS 未必还认得出「它非空」。这里直接落成 `PersonaVarsLike | undefined`，
    // 让下面每一处 `!== undefined` 都是真判断，而不是靠类型收窄的推断链。
    const varsRaw = this.varsOf()
    const vars: PersonaVarsLike | undefined = varsRaw !== undefined && varsRaw.available ? varsRaw : undefined
    if (vars === undefined) {
      degradations.push(
        Object.freeze({
          kind: 'no-vars' as const,
          note: '没有装载 ondra-persona-vars（O-022）：占位符原样保留、没有浓度段，其余照常',
        }),
      )
    }

    // 1. 两段：内核 + 关系微调。
    const composed = this.composeOf(core, input?.relation, degradations)
    if (composed === undefined) {
      return this.finish(
        emptyAssembly(
          budgetChars,
          Object.freeze([
            ...degradations,
            Object.freeze({
              kind: 'no-core' as const,
              note: 'ondra-persona-core 在位但 compose() 没有返回（人设包缺 SKILL.md 一类），本轮只出空段',
            }),
          ]),
        ),
      )
    }

    // 2. 变量替换（对内核、关系、边界三处都做）。
    const subst = (text: string): string => {
      if (vars === undefined || text === '') return text
      try {
        return vars.substitute(text, { userAddress: input?.userAddress }).text
      } catch (error) {
        // 组件错误不得传播（CBI C3 的同一条精神）：替换失败就用原文。
        this.log.warn('变量替换失败，该段按原文使用：%s', messageOf(error))
        return text
      }
    }

    /*
     * 边界条目走同一个替换函数，但**声明自己是边界层**。
     *
     * 这条通道是 `substituteInBoundaries` 唯一的落点：上游关掉它时只挡这一路，
     * 内核与关系段照常替换。少了这个 `scope`，那个设置就是一句空话——
     * 用户关掉它，红线里的 `{{user}}` 照样被换掉，而日志与界面都说「已关闭」。
     */
    const substBoundary = (text: string): string => {
      if (vars === undefined || text === '') return text
      try {
        return vars.substitute(text, { userAddress: input?.userAddress, scope: 'boundary' }).text
      } catch (error) {
        this.log.warn('边界条目变量替换失败，该条按原文使用：%s', messageOf(error))
        return text
      }
    }

    // 3. 单元：内核按槽位（先对拍），关系一段，浓度一段，边界逐条豁免。
    const units: AssemblyUnit[] = []
    const kernelUnits = this.kernelUnits(core, composed.kernelText, subst, degradations)
    if (kernelUnits !== undefined) {
      for (const unit of kernelUnits) units.push(unit)
    }
    const relationText = subst(composed.relationText)
    if (relationText !== '') units.push(relationUnit(relationText))

    if (vars !== undefined) {
      const toneText = this.toneText(vars, input?.toneLevel)
      if (toneText !== '') units.push(toneUnit(toneText))
    }

    for (const unit of this.boundaryUnits(core, substBoundary)) units.push(unit)

    // 4. 装箱。
    const result = composeAssembly({
      units,
      budgetChars,
      includeHeadings,
      missingSlots: composed.missing,
      hasExtras: composed.hasExtras,
      degradations: Object.freeze(degradations),
    })

    if (result.report.overBudget && this.settings.reportOverBudget) {
      this.log.warn(
        '人格拼装超预算：用了 %d 字符 / 预算 %d（边界层豁免占 %d），掉了 %d 段未展开「%s」',
        result.report.usedChars,
        result.report.budgetChars,
        result.report.exemptChars,
        result.report.droppedCount,
        result.report.dropped.map(item => item.label).join(' / '),
      )
    }
    return this.finish(result)
  }

  /** 统计快照。 */
  stats(): AssembleStats {
    const core = this.coreOf()
    const vars = this.varsOf()
    return Object.freeze({
      available: this.available,
      reason: this.reason,
      budgetChars: this.settings.budgetChars,
      lastUsedChars: this.lastUsedChars,
      lastOverBudget: this.lastOverBudget,
      lastDroppedCount: this.lastDroppedCount,
      lastSectionChars: this.lastSectionChars,
      corePresent: usable(core),
      varsPresent: usable(vars),
    })
  }

  /** 记下观察值（只给 `stats()` 用）。 */
  private finish(result: AssembledPrompt): AssembledPrompt {
    this.remember(result)
    return result
  }

  /** 同上。 */
  private remember(result: AssembledPrompt): void {
    this.lastUsedChars = result.report.usedChars
    this.lastOverBudget = result.report.overBudget
    this.lastDroppedCount = result.report.droppedCount
    const chars: Record<SectionId, number> = { ...ZERO_CHARS }
    for (const section of result.sections) chars[section.id] = section.chars
    this.lastSectionChars = Object.freeze(chars)
  }

  /**
   * 调上游 `compose()`，把两段与缺槽位取出来。
   *
   * 与 O-021 的 `compose()` 契约对齐：`sections[0]` 是内核、`sections[1]` 是关系。
   * **按 `id` 找而不是按下标找**：下标依赖上游的数组构造顺序，而上游完全可能
   * 改成先放关系段——那种变化不会报错，只会让两段互换位置。
   * @param core 上游。
   * @param relation 临时关系 id。
   * @param degradations 降级说明（就地追加）。
   */
  private composeOf(
    core: PersonaCoreLike,
    relation: string | undefined,
    degradations: Degradation[],
  ): { readonly kernelText: string; readonly relationText: string; readonly missing: readonly string[]; readonly hasExtras: boolean } | undefined {
    try {
      // 只把「非空字符串」的关系传下去：传 `undefined` 会让上游走它自己的配置值，
      // 传 `''` 会被上游的 `isRelationId` 判成非法（这属于上游口径，本插件不猜）。
      const composed = relation === undefined || relation === '' ? core.compose() : core.compose({ relation })
      if (composed === undefined) return undefined
      const kernelSection = composed.sections.find(section => section.id === 'kernel')
      const relationSection = composed.sections.find(section => section.id === 'relation')
      if (kernelSection === undefined) {
        // 对不上就整段不带，但要说清：这是「上游契约变了」，不是「人设包坏了」。
        degradations.push(
          Object.freeze({
            kind: 'no-core' as const,
            note: 'ondra-persona-core 的 compose() 没有给出 id=kernel 的段（上游契约可能变了）：本轮不出内核',
          }),
        )
        return undefined
      }
      return {
        kernelText: kernelSection.text,
        relationText: relationSection === undefined ? '' : relationSection.text,
        missing: composed.missing,
        hasExtras: composed.hasExtras,
      }
    } catch (error) {
      this.log.warn('调用 ondra-persona-core 的 compose() 失败：%s', messageOf(error))
      degradations.push(
        Object.freeze({
          kind: 'no-core' as const,
          note: '调用 ondra-persona-core 的 compose() 抛错：本轮不出内核（详见日志）',
        }),
      )
      return undefined
    }
  }

  /**
   * 把内核切成可裁单元。
   *
   * 三种情况：
   * ① 拿不到 `kernel()`（老版本上游 / 抛错）→ 整段内核作为一个**不可裁**单元；
   * ② 槽位拼起来与 `compose()` 的内核段对不上 → 同上，并报 `kernel-mismatch`；
   * ③ 对得上 → 每槽位一个单元，外加引言块一个单元。
   * @param core 上游。
   * @param kernelText `compose()` 给出的内核段。
   * @param subst 替换函数。
   * @param degradations 降级说明（就地追加）。
   */
  private kernelUnits(
    core: PersonaCoreLike,
    kernelText: string,
    subst: (text: string) => string,
    degradations: Degradation[],
  ): readonly AssemblyUnit[] | undefined {
    let view: ReturnType<PersonaCoreLike['kernel']>
    try {
      view = core.kernel()
    } catch (error) {
      this.log.warn('读取内核槽位失败，退回整段内核：%s', messageOf(error))
      view = undefined
    }
    if (view === undefined) {
      degradations.push(
        Object.freeze({
          kind: 'kernel-mismatch' as const,
          note: '拿不到六槽位（上游没有 kernel() 或抛错）：内核整段带上、不按槽位裁剪',
        }),
      )
      return [kernelWholeUnit(subst(kernelText))]
    }

    const slots = view.slots.filter(slot => slot.found && slot.text !== '')
    const extras = view.extras.filter(extra => extra.text !== '')
    // 对拍：引言块 + 六个槽位 +（若开着 `includeExtras`）未映射章节，用 `\n\n` 拼起来，
    // 与 `compose()` 的内核段逐字比。
    // **必须把 extras 算进来**：O-021 的 `kernelTextOf()` 在 `includeExtras` 打开时会
    // 把未映射章节接在内核末尾。漏掉它们，对拍就必然不一致——于是每一轮都退化成
    // 「整段内核不裁剪」，那是一种**看起来正常、其实永久失效**的退化。
    const rebuilt = [view.essence?.text ?? '', ...slots.map(slot => slot.text), ...extras.map(extra => extra.text)]
      .filter(part => part !== '')
      .join('\n\n')
    if (!sameKernel(rebuilt, kernelText)) {
      degradations.push(
        Object.freeze({
          kind: 'kernel-mismatch' as const,
          note:
            '六槽位拼起来（' +
            String(charCount(rebuilt)) +
            ' 字）与 ondra-persona-core 给的内核段（' +
            String(charCount(kernelText)) +
            ' 字）对不上：内核整段带上、不按槽位裁剪（宁可超预算也不猜分段）',
        }),
      )
      return [kernelWholeUnit(subst(kernelText))]
    }

    const units: AssemblyUnit[] = []
    let order = 0
    if (view.essence !== undefined && view.essence.text !== '') {
      const text = subst(view.essence.text)
      units.push(
        Object.freeze({
          id: 'essence',
          section: 'kernel' as SectionId,
          label: '一句话内核',
          priority: priorityOf('essence'),
          order,
          text,
          chars: charCount(text),
          exempt: false,
        }),
      )
      order += 1
    }
    for (const slot of slots) {
      const text = subst(slot.text)
      units.push(slotUnit(slot.id, slot.label, order, text))
      order += 1
    }
    for (const extra of extras) {
      const text = subst(extra.text)
      units.push(extraUnit(order, text))
      order += 1
    }
    if (view.missing.length > 0) {
      degradations.push(
        Object.freeze({
          kind: 'missing-slot' as const,
          note:
            '人设包缺 ' +
            String(view.missing.length) +
            ' 个槽位（' +
            view.missing.join(' / ') +
            '）：这几段留空，不拿别的段落顶替',
        }),
      )
    }
    return units
  }

  /**
   * 取浓度段正文。
   *
   * 取不到就**返回空串**（这一段不带），不编一句。编出来的浓度提示会把
   * 默认档从「人设包原本的说法」变成「插件作者的说法」。
   * @param vars 上游。
   * @param level 临时档位。
   */
  private toneText(vars: PersonaVarsLike, level: number | undefined): string {
    try {
      const section = level === undefined ? vars.tone() : vars.tone({ level })
      return typeof section.text === 'string' ? section.text : ''
    } catch (error) {
      this.log.warn('取说话浓度段失败，本轮不带浓度段：%s', messageOf(error))
      return ''
    }
  }

  /**
   * 边界条目 → 单元（全部豁免裁剪）。
   *
   * 排序口径：**硬约束在前**，同硬度内按上游给的顺序。
   * 这与 O-021 `boundaries()` 的顺序基本一致，但显式排一次是为了
   * 「上游改了顺序，红线也不至于排到软约束后面」。
   * @param core 上游。
   * @param subst 替换函数。
   */
  private boundaryUnits(core: PersonaCoreLike, subst: (text: string) => string): readonly AssemblyUnit[] {
    let items: readonly { readonly id: string; readonly text: string; readonly hard: boolean }[]
    try {
      items = core.boundaries()
    } catch (error) {
      this.log.warn('读取边界条目失败，本轮不带边界层：%s', messageOf(error))
      return Object.freeze([])
    }
    const sorted = [...items].sort((left, right) => {
      if (left.hard !== right.hard) return left.hard ? -1 : 1
      return 0
    })
    return Object.freeze(
      sorted
        .map((item, index) => boundaryUnit(item.id, subst(item.text), index, item.hard))
        .filter(unit => unit.text !== ''),
    )
  }
}

/**
 * 四段拼装的**段顺序**（导出给自检与下游对拍）。
 *
 * 直接由 `SECTION_IDS` 派生，**不另写一份**：段顺序是契约的一部分，
 * 两份顺序表迟早会不一致，而那种不一致不会报错，只会让「浓度」出现在「人格」前面。
 */
export const ASSEMBLY_ORDER: readonly SectionId[] = SECTION_IDS
