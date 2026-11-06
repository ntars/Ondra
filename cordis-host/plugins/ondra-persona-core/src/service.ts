/**
 * 内核服务：解析「用哪个人设」→ 取文本 → 切槽位 → 缓存 → 出两段。
 *
 * 三个设计取舍：
 *
 * 1. **加载器每轮现取（`loaderOf()`），不存实例。**
 *    插件装载顺序不确定，`ondra-persona-loader` 完全可能在本插件之后才上。
 *    存一个 `undefined` 实例，就等于「谁先装载决定了她的内核能不能出来」，
 *    而这种失败在日志里只会表现为「内核不可用」，查不到根因。
 *    现取的成本是一次 `ctx.get`（哈希查表），而它让装载顺序不再重要。
 *
 * 2. **缓存键带人设版本，且同时缓存「切好的布局」。**
 *    `kernel()` 每次调用都可能重新解包 20KB 的 zip 并重切一遍（§8.2 反模式②）。
 *    只缓存 `KernelView` 而不缓存布局，会让 `boundaries()` 每次重切一次——
 *    而它被闸门每轮都要读。两样一起缓存，键都是 `id@version`，换包即失效。
 *
 * 3. **探活结果按「开关 + 人设 id」记忆。**
 *    `available` 是个 getter，会被 `stats()`、界面、自检反复读。
 *    每次都真去读一遍 `SKILL.md` 是不可接受的；但只在构造时算一次又会
 *    「加载器晚到就永远不可用」。折中是：按 `(enable, 人设id)` 记忆，
 *    一旦探到「有 skill」，之后都是命中缓存。
 */

import { charCount, layoutOf, SLOT_SPECS } from './slots.js'
import type { SkillLayout } from './slots.js'
import { SKILL_FILE, activationOf, boundaryItemsOf, kernelOfLayout, kernelTextOf, referenceEntriesOf } from './kernel.js'
import { RELATION_VARIANTS, deltasOf, relationSectionOf, variantOf } from './variants.js'
import { effectiveRelation } from './settings.js'
import type { Config } from './settings.js'
import type {
  ActivationView,
  BoundaryItem,
  ComposeInput,
  ComposedKernel,
  KernelView,
  LogLike,
  PersonaCoreService,
  PersonaCoreStats,
  PersonaCoreUnavailableReason,
  PersonaDetailLike,
  PersonaLoaderLike,
  ReferenceEntry,
  RelationDelta,
  RelationVariant,
  SlotSpec,
} from './types.js'

/** 缓存里的一套。 */
interface CachedPersona {
  /** 详情（缓存时的那一份，用于边界与索引）。 */
  readonly detail: PersonaDetailLike
  /** 切好的布局。 */
  readonly layout: SkillLayout
  /** 内核视图。 */
  readonly view: KernelView
}

/** 错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 人设内核服务实现。 */
export class PersonaCoreRepository implements PersonaCoreService {
  private readonly loaderOf: () => PersonaLoaderLike | undefined
  private readonly log: LogLike
  private readonly settings: Config
  private readonly cache = new Map<string, CachedPersona>()
  private probeKey = ''
  private probeResult: { readonly ok: boolean; readonly reason?: PersonaCoreUnavailableReason; readonly id?: string } =
    Object.freeze({ ok: false, reason: 'no-loader' })
  /** 上一次 `ensure` 失败的原因（`probe` 用它把「为什么不可用」说清）。 */
  private lastFailure: PersonaCoreUnavailableReason = 'no-persona'

  /**
   * @param loaderOf 现取人设加载器（每次调用都问一次，见文件头第 1 条）。
   * @param log 日志。
   * @param settings 配置。
   */
  constructor(loaderOf: () => PersonaLoaderLike | undefined, log: LogLike, settings: Config) {
    this.loaderOf = loaderOf
    this.log = log
    this.settings = settings
  }

  /** 是否可用。 */
  get available(): boolean {
    return this.probe().ok
  }

  /** 不可用原因。 */
  get reason(): PersonaCoreUnavailableReason | undefined {
    return this.probe().reason
  }

  /** 六个槽位声明。 */
  slots(): readonly SlotSpec[] {
    return SLOT_SPECS
  }

  /** 取内核。 */
  kernel(personaId?: string): KernelView | undefined {
    const cached = this.ensure(personaId)
    return cached === undefined ? undefined : cached.view
  }

  /** 五个内置变体 + 自定义。 */
  variants(): readonly RelationVariant[] {
    return RELATION_VARIANTS
  }

  /** 取一个变体。 */
  variant(id: string): RelationVariant | undefined {
    return variantOf(id)
  }

  /** 关系层改哪三处。 */
  deltasOf(id: string): readonly RelationDelta[] {
    return deltasOf(id)
  }

  /** 拼两段。 */
  compose(input?: ComposeInput): ComposedKernel | undefined {
    const cached = this.ensure(input?.personaId)
    if (cached === undefined) return undefined
    const relation = effectiveRelation(this.settings.relation, input?.relation)
    const kernelText = kernelTextOf(cached.view, this.settings.includeExtras)
    const relationSection = relationSectionOf(relation, input?.overrides)
    const sections = Object.freeze([
      Object.freeze({ id: 'kernel' as const, order: 0, text: kernelText }),
      Object.freeze({ id: 'relation' as const, order: 1, text: relationSection.text }),
    ])
    return Object.freeze({
      personaId: cached.view.personaId,
      personaVersion: cached.view.personaVersion,
      relation,
      sections,
      chars: charCount(kernelText) + relationSection.chars,
      missing: cached.view.missing,
      hasExtras: this.settings.includeExtras && cached.view.extras.length > 0,
    })
  }

  /** 边界条目。 */
  boundaries(personaId?: string): readonly BoundaryItem[] {
    const cached = this.ensure(personaId)
    if (cached === undefined) return Object.freeze([])
    const split = boundaryItemsOf(cached.layout, cached.detail.safety, this.settings.boundaryItemLimit)
    if (split.total > split.items.length) {
      this.log.warn(
        '边界条目共 %d 条，超过上限 %d，只返回前 %d 条（没有静默丢：这条日志就是证据）',
        split.total,
        this.settings.boundaryItemLimit,
        split.items.length,
      )
    }
    return split.items
  }

  /** 激活规则。 */
  activation(personaId?: string): ActivationView | undefined {
    const cached = this.ensure(personaId)
    return cached === undefined ? undefined : activationOf(cached.detail, cached.layout)
  }

  /** 渐进披露索引。 */
  references(personaId?: string): readonly ReferenceEntry[] {
    const cached = this.ensure(personaId)
    return cached === undefined ? Object.freeze([]) : referenceEntriesOf(cached.detail)
  }

  /** 统计快照。 */
  stats(): PersonaCoreStats {
    const probe = this.probe()
    const cached = probe.id === undefined ? undefined : this.ensure(probe.id)
    return Object.freeze({
      available: probe.ok,
      reason: probe.reason,
      personaId: probe.id === undefined ? null : probe.id,
      relation: this.settings.relation,
      slotCount: SLOT_SPECS.length,
      missingCount: cached === undefined ? 0 : cached.view.missing.length,
      kernelChars: cached === undefined ? 0 : cached.view.chars,
      boundaryCount: cached === undefined ? 0 : this.boundaries(probe.id).length,
      cachedKernels: this.cache.size,
      loaderPresent: this.loaderOf() !== undefined,
      skillPresent: cached !== undefined,
    })
  }

  /**
   * 解析当前该用哪个人设。
   *
   * 配置优先（那是用户明确指定的），否则问加载器的当前人设。
   * **不退回「列表第一个」**——「我配的那个找不到」与「随便给我一个」是两件事。
   */
  private resolveId(): string | undefined {
    if (this.settings.personaId !== '') return this.settings.personaId
    const loader = this.loaderOf()
    if (loader === undefined) return undefined
    return loader.activeId()
  }

  /** 探活（按开关 + 人设 id 记忆，见文件头第 3 条）。 */
  private probe(): { readonly ok: boolean; readonly reason?: PersonaCoreUnavailableReason; readonly id?: string } {
    const id = this.resolveId()
    const key = (this.settings.enable ? '1' : '0') + '|' + (id ?? '')
    if (key === this.probeKey) return this.probeResult

    let result: { ok: boolean; reason?: PersonaCoreUnavailableReason; id?: string }
    if (!this.settings.enable) {
      result = { ok: false, reason: 'disabled' }
    } else if (this.loaderOf() === undefined) {
      result = { ok: false, reason: 'no-loader' }
    } else if (id === undefined) {
      result = { ok: false, reason: 'no-persona' }
    } else {
      const cached = this.ensure(id)
      result =
        cached === undefined
          ? { ok: false, reason: this.lastFailure, id }
          : { ok: true, id }
    }
    this.probeKey = key
    this.probeResult = Object.freeze(result)
    return this.probeResult
  }

  /**
   * 取（或建）某个人设的缓存。
   * @param personaId 人设 id；省略按配置 / 加载器当前人设。
   */
  private ensure(personaId?: string): CachedPersona | undefined {
    if (!this.settings.enable) {
      this.lastFailure = 'disabled'
      return undefined
    }
    const loader = this.loaderOf()
    if (loader === undefined) {
      this.lastFailure = 'no-loader'
      return undefined
    }
    const id = personaId === undefined || personaId === '' ? this.resolveId() : personaId
    if (id === undefined) {
      this.lastFailure = 'no-persona'
      return undefined
    }
    const detail = loader.get(id) ?? (id === loader.activeId() ? loader.active() : undefined)
    if (detail === undefined) {
      this.lastFailure = 'no-persona'
      return undefined
    }
    const key = detail.id + '@' + detail.version
    const hit = this.cache.get(key)
    if (hit !== undefined) return hit

    let text: string | undefined
    try {
      text = loader.readText(detail.id, SKILL_FILE)
    } catch (error) {
      // 组件错误不得外抛（器官 ABI C3 的同一条精神）：这里是纯读取，读不到就降级。
      this.log.warn('读「%s」的 SKILL.md 失败：%s', detail.id, messageOf(error))
      text = undefined
    }
    if (text === undefined) {
      this.lastFailure = 'no-skill'
      this.log.warn('人设「%s」没有可读的 SKILL.md：组装不出内核（这一条要能被界面看见）', detail.id)
      return undefined
    }
    const sourceBytes = (detail.files.find(file => file.path === SKILL_FILE)?.bytes) ?? 0
    const layout = layoutOf(text)
    const view = kernelOfLayout(detail.id, detail.version, layout, sourceBytes)
    const entry: CachedPersona = Object.freeze({ detail, layout, view })
    if (this.settings.cacheKernels) this.cache.set(key, entry)
    return entry
  }
}
