/**
 * O-005 的注册表：**段键单一归属 + 声明期校验**。
 *
 * 为什么注册要拦得这么死：段键就是配置命名空间，界面上「哪一屏设置归谁管」
 * 全靠它。一旦两个插件登记同一个段键，后注册的会悄悄覆盖前者的声明，
 * 表现是「我明明写了这个字段，界面上没有」——而且只在两者同时装载时出现。
 *
 * 因此这里的纪律是 **fail-fast**：注册期有问题直接抛，让问题在装载时就炸；
 * 运行期（`resolve` / `presetOf`）一律不抛，取不到就返回空让调用方降级——
 * 配置读不出来不该让主对话跟着崩。
 */

import { ConfigSchemaError, PRESET_ORDER } from './types.js'
import type { FieldSpec, PresetName, SectionDecl } from './types.js'
import { checkFieldSpec, checkFieldValue, deepFreeze, expandPreset, isValidKey } from './layers.js'

/**
 * 预设档名的合法集合。
 *
 * 刻意 `import` 自 `types.ts` 的 `PRESET_ORDER` 而**不另抄一份**：
 * 档名列表一旦有两份，加档时必漏一处，表现为「新档位在声明期被自己拒掉」。
 */
const PRESET_NAMES: readonly string[] = PRESET_ORDER

/** 注册表内部条目。 */
interface Entry {
  /** 冻结后的声明。 */
  readonly decl: SectionDecl
  /** 登记方名字，用于「段键被谁占了」的报错。 */
  readonly by: string
}

/** 声明期校验：把不合法的声明挡在注册表之外。 */
function assertDecl(decl: SectionDecl, by: string): void {
  if (!isValidKey(decl.id)) {
    throw new ConfigSchemaError(
      'bad-name',
      decl.id,
      '段键「' + decl.id + '」不符合 ^[a-z][a-z0-9_-]{1,63}$（小写字母开头，只允许小写字母、' +
      '数字、下划线与连字符；冒号不合法）',
    )
  }
  if (decl.title.trim() === '') {
    throw new ConfigSchemaError('bad-field-spec', decl.id, '段「' + decl.id + '」必须给一个中文段名')
  }
  for (const [key, spec] of Object.entries(decl.fields)) {
    const bad = checkFieldSpec(key, spec)
    if (bad !== undefined) {
      throw new ConfigSchemaError('bad-field-spec', decl.id, bad, key)
    }
  }
  const presets = decl.presets
  if (presets !== undefined) {
    for (const [name, patch] of Object.entries(presets)) {
      if (!PRESET_NAMES.includes(name)) {
        throw new ConfigSchemaError(
          'bad-field-spec',
          decl.id,
          '段「' + decl.id + '」的预设档名「' + name + '」不合法，只能是 ' + PRESET_NAMES.join(' / '),
        )
      }
      if (patch === undefined) continue
      for (const [key, value] of Object.entries(patch)) {
        const spec: FieldSpec | undefined = decl.fields[key]
        if (spec === undefined) {
          throw new ConfigSchemaError(
            'bad-field-spec',
            decl.id,
            '段「' + decl.id + '」的预设「' + name + '」引用了未声明字段「' + key + '」',
            key,
          )
        }
        const bad = checkFieldValue(spec, value)
        if (bad !== undefined) {
          throw new ConfigSchemaError(
            'bad-field-spec',
            decl.id,
            '段「' + decl.id + '」的预设「' + name + '」里字段「' + key + '」的值不合法：' + bad,
            key,
          )
        }
      }
    }
  }
  if (by.trim() === '') {
    throw new ConfigSchemaError('bad-name', decl.id, '段「' + decl.id + '」的登记方名字不能为空')
  }
}

/** 把声明冻结成只读快照（含 fields 与 presets 的深层冻结）。 */
function freezeDecl(decl: SectionDecl): SectionDecl {
  const fields: Record<string, FieldSpec> = {}
  for (const [key, spec] of Object.entries(decl.fields)) {
    const copy: Record<string, unknown> = { kind: spec.kind }
    if (spec.default !== undefined) copy.default = spec.default
    /*
     * 枚举候选归一：`options` 与 `values` 是同一个意思的两种写法
     * （理由见 `types.ts` 的 `values` 注释）。快照里**只留 `values`**，
     * 让下游（设置页渲染、取值校验、诊断）只需认一个名字——
     * 否则每加一个读者就要再写一次 `?? options`，漏一处就少一批候选。
     */
    const candidates = spec.values ?? spec.options
    if (candidates !== undefined) copy.values = [...candidates]
    if (spec.min !== undefined) copy.min = spec.min
    if (spec.max !== undefined) copy.max = spec.max
    if (spec.pattern !== undefined) copy.pattern = spec.pattern
    if (spec.secret !== undefined) copy.secret = spec.secret
    if (spec.advancedOnly !== undefined) copy.advancedOnly = spec.advancedOnly
    if (spec.doc !== undefined) copy.doc = spec.doc
    fields[key] = deepFreeze(copy as unknown as FieldSpec)
  }
  const frozen: Record<string, unknown> = {
    id: decl.id,
    title: decl.title,
    fields: deepFreeze(fields),
  }
  if (decl.presets !== undefined) {
    const presets: Record<string, unknown> = {}
    for (const name of PRESET_NAMES) {
      const patch = (decl.presets as Record<string, unknown>)[name]
      if (patch === undefined) continue
      presets[name] = deepFreeze(patch)
    }
    frozen.presets = deepFreeze(presets)
  }
  if (decl.owner !== undefined) frozen.owner = decl.owner
  return deepFreeze(frozen as unknown as SectionDecl)
}

/**
 * 段注册表。
 *
 * 故意做成普通类而不是 `extends Service`：注册表是纯数据结构，
 * 生命周期由 `index.ts` 里的 `ctx.effect()` 统一管，不必绑框架基类。
 */
export class SectionRegistry {
  /** 段键 → 条目。 */
  private readonly entries = new Map<string, Entry>()

  /**
   * 登记一个段。
   * @param decl 段声明。
   * @param by 登记方名字（插件名），用于冲突报错。
   * @throws {ConfigSchemaError} 声明不合法或段键已被占用。
   */
  register(decl: SectionDecl, by: string): void {
    assertDecl(decl, by)
    const existing = this.entries.get(decl.id)
    if (existing !== undefined) {
      throw new ConfigSchemaError(
        'section-taken',
        decl.id,
        '段键「' + decl.id + '」已被「' + existing.by + '」登记；一个段键只能有一个归属方（§15.4）',
      )
    }
    this.entries.set(decl.id, { decl: freezeDecl(decl), by })
  }

  /**
   * 撤销一个段。
   *
   * **只撤自己登记的那一份**：若该段键已被别的登记方接管（理论上不会发生，
   * 但卸载/重装交错的瞬间可能），这里什么也不做，免得把别人的段撤掉。
   * @param id 段键。
   * @param by 撤销请求方名字。
   */
  unregister(id: string, by: string): void {
    const existing = this.entries.get(id)
    if (existing === undefined) return
    if (existing.by !== by) return
    this.entries.delete(id)
  }

  /** 段是否已登记。 */
  has(id: string): boolean {
    return this.entries.has(id)
  }

  /** 全部段键，升序（界面按固定顺序渲染，避免每次装载顺序不同导致跳版）。 */
  list(): readonly string[] {
    return Object.freeze([...this.entries.keys()].sort())
  }

  /** 取声明快照。 */
  section(id: string): SectionDecl | undefined {
    return this.entries.get(id)?.decl
  }

  /** 取某档的增补值。 */
  presetOf(id: string, preset: PresetName): Readonly<Record<string, unknown>> {
    const decl = this.entries.get(id)?.decl
    if (decl === undefined) return deepFreeze({})
    return expandPreset(decl, preset)
  }
}
