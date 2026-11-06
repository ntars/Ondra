/**
 * O-005 的纯算法层：**四层合并 + 逐字段校验 + 来源追溯**。
 *
 * 这个文件刻意不碰 `ctx`、不读盘、不联网、不起定时器：四层合并是本插件唯一
 * 真正难写对的地方，脱开框架才能单独推演与核对（本轮禁止实装运行，见 §16.3）。
 *
 * 三条贯穿全文件的裁决：
 *
 * 1. **数组一律替换，不深合并。**
 *    深合并数组会让「用户在界面上删掉一条」永远删不掉——那条元素还活在下层里，
 *    合并后又冒出来，而且没有任何报错。这是配置系统里最难查的一类 bug。
 *
 * 2. **`null` 是显式置空，`undefined` / 缺键 是「本层未设置」。**
 *    二者混同会让「清空这个字段」变成「恢复默认」，反之亦然。
 *
 * 3. **单个字段出错只回退该字段，不整段失败。**
 *    手册要求「校验失败回退该字段默认值而非整体失败」。但回退本身是静默危险动作，
 *    所以必须逐条记 `ConfigIssue` 并计入 `fallbackCount`，让界面说得清「哪一层哪个字段被丢了」。
 */

import { LAYER_ORDER } from './types.js'
import type {
  ConfigIssue,
  FieldSpec,
  LayerName,
  LayerSet,
  LayerValues,
  ResolvedField,
  ResolvedSection,
  SectionDecl,
} from './types.js'

/** 命名硬约束（手册 §8.4）：服务键 / 工具名 / 配置键通用。 */
export const KEY_PATTERN_SOURCE = '^[a-z][a-z0-9_-]{1,63}$'

/**
 * 键名正则。刻意用字符串源编译，不在字面量里写字面量正则——
 * 静态括号配平自检会被 `{1,63}` 干扰（同类坑在 O-003 已踩过）。
 */
const KEY_PATTERN = new RegExp(KEY_PATTERN_SOURCE)

/**
 * 原型污染黑名单。
 *
 * 合并外部传入的对象时必须跳过这三个键：配置来自 YAML/JSON，一旦有人写
 * `{"__proto__": {...}}`，深合并就会把整条原型链改成别人的。
 */
const UNSAFE_KEYS: readonly string[] = Object.freeze(['__proto__', 'constructor', 'prototype'])

/** 判空对象（不裸判 `typeof`，避免 `null` 与数组漏网）。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** 键名是否合规（§8.4）。 */
export function isValidKey(key: string): boolean {
  return KEY_PATTERN.test(key)
}

/**
 * 深拷贝成「JSON 形状」的值：对象逐键递归、数组逐项递归、其余原样。
 *
 * 只认识 `null / 布尔 / 数字 / 字符串 / 数组 / 普通对象`——配置就该是这个形状。
 * 遇到 `undefined` 视为「不存在」，由调用方决定丢弃还是置空。
 */
export function cloneJsonShaped(value: unknown): unknown {
  if (value === null) return null
  if (Array.isArray(value)) return value.map((item) => cloneJsonShaped(item))
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (UNSAFE_KEYS.includes(key)) continue
      if (item === undefined) continue
      out[key] = cloneJsonShaped(item)
    }
    return out
  }
  return value
}

/**
 * 深冻结：让「只读契约」在运行时也成立。
 *
 * 只冻结普通对象与数组；`Date` 一类不碰（配置里本不该出现，出现了也不该被冻）。
 */
export function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item)
    return Object.freeze(value) as T
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) deepFreeze(item)
    return Object.freeze(value) as T
  }
  return value
}

/**
 * 两个值深合并：对象合、数组换、其余后者盖前者。
 *
 * @param lower 低优先级层已合并出的值。
 * @param upper 高优先级层提供的值；`null` 表示显式置空，直接覆盖。
 */
export function mergeValue(lower: unknown, upper: unknown): unknown {
  if (upper === null) return null
  if (lower === null || lower === undefined) return cloneJsonShaped(upper)
  if (isPlainObject(lower) && isPlainObject(upper)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(lower)) {
      if (UNSAFE_KEYS.includes(key)) continue
      out[key] = cloneJsonShaped(item)
    }
    for (const [key, item] of Object.entries(upper)) {
      if (UNSAFE_KEYS.includes(key)) continue
      if (item === undefined) continue
      const has = Object.hasOwn(out, key)
      // 关键：数组走「替换」而不是递归合并。
      out[key] = has && !Array.isArray(item) ? mergeValue(out[key], item) : cloneJsonShaped(item)
    }
    return out
  }
  return cloneJsonShaped(upper)
}

/** 把外部传入的层集合规整成「只含四个合法层的普通对象」。 */
export function normalizeLayers(layers: LayerSet | undefined): Record<LayerName, LayerValues> {
  const out: Record<string, LayerValues> = {}
  for (const name of LAYER_ORDER) {
    const raw = layers ? layers[name] : undefined
    out[name] = isPlainObject(raw) ? raw : {}
  }
  return out as Record<LayerName, LayerValues>
}

/**
 * 单个值是否满足字段声明。
 * @returns 不满足时返回一句中文原因，满足时返回 `undefined`。
 */
export function checkFieldValue(spec: FieldSpec, value: unknown): string | undefined {
  switch (spec.kind) {
    case 'string': {
      if (typeof value !== 'string') return '必须是字符串'
      if (spec.pattern !== undefined && !new RegExp(spec.pattern).test(value)) {
        return '必须匹配 ' + spec.pattern
      }
      return undefined
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '必须是有限数字'
      if (spec.min !== undefined && value < spec.min) return '不能小于 ' + String(spec.min)
      if (spec.max !== undefined && value > spec.max) return '不能大于 ' + String(spec.max)
      return undefined
    }
    case 'boolean':
      return typeof value === 'boolean' ? undefined : '必须是布尔值'
    case 'enum': {
      const values = spec.values ?? []
      if (typeof value !== 'string') return '必须是字符串'
      if (!values.includes(value)) return '只能是 ' + values.join(' / ') + ' 之一'
      return undefined
    }
    case 'json': {
      if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
        return '必须是可序列化的 JSON 值'
      }
      return undefined
    }
    default:
      return '未知的字段种类'
  }
}

/**
 * 校验一个字段声明的**合法性**（注册期用，不是取值期）。
 * @returns 不合法时返回一句中文原因。
 */
export function checkFieldSpec(key: string, spec: FieldSpec): string | undefined {
  if (!isValidKey(key)) return '字段键「' + key + '」不符合 ' + KEY_PATTERN_SOURCE
  if (spec.secret === true && spec.default !== undefined) {
    return '密钥类字段「' + key + '」不得声明默认值（密钥只走环境变量与凭据域）'
  }
  if (spec.kind === 'enum') {
    const values = spec.values ?? []
    if (values.length === 0) return '枚举字段「' + key + '」必须给出 values 候选'
    for (const item of values) {
      if (typeof item !== 'string') return '枚举字段「' + key + '」的候选必须是字符串'
    }
  }
  if (spec.kind === 'number' && spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) {
    return '数字字段「' + key + '」的 min 大于 max'
  }
  if (spec.pattern !== undefined) {
    try {
      new RegExp(spec.pattern)
    } catch {
      return '字段「' + key + '」的 pattern 不是合法正则'
    }
  }
  if (spec.default !== undefined && spec.default !== null) {
    const bad = checkFieldValue(spec, spec.default)
    if (bad !== undefined) return '字段「' + key + '」的默认值不合法：' + bad
  }
  return undefined
}

/**
 * 把「校验不通过的原因」映射成问题码。
 *
 * 单独抽出来是因为嵌在三元里会写成一行四段，静态自检与人工复核都看不清
 * ——而问题码正是界面据以分支的东西，写错了没人会发现。
 *
 * 判定顺序刻意是「先看原因、再看种类」：一个数字字段被填成字符串，
 * 合理的码是 `type-mismatch`（填错类型），不是 `out-of-range`（超范围）。
 * 反过来说，如果先按种类判，界面就会提示「超出 0–100 的范围」，
 * 而用户其实填的是「一百」两个字，提示完全误导。
 */
function issueCodeOf(spec: FieldSpec, reason: string): ConfigIssue['code'] {
  if (reason.startsWith('必须是')) {
    // 「必须是字符串 / 必须是有限数字 / 必须是布尔值 / 必须是可序列化的 JSON 值」
    return 'type-mismatch'
  }
  if (spec.kind === 'enum') return 'not-in-enum'
  if (spec.kind === 'number') return 'out-of-range'
  if (spec.kind === 'string' && spec.pattern !== undefined) return 'pattern-mismatch'
  return 'type-mismatch'
}

/**
 * 解析一个字段：**逐层校验 → 从高到低取第一个可用的 → 对象型再深合并**。
 *
 * 为什么不是「先从高到低取第一个有值的，再拿它去校验」：
 * 那样高层的错值会把整段拖回默认值，用户在界面上看到的是「我填的东西全没了」。
 * 改成「逐层校验、错的层单独丢弃」后，错的只影响它自己那一层。
 */
function resolveField(
  sectionId: string,
  key: string,
  spec: FieldSpec,
  layers: Record<LayerName, LayerValues>,
): ResolvedField {
  const issues: ConfigIssue[] = []
  /** 通过校验的层，按优先级升序。 */
  const accepted: { layer: LayerName; value: unknown }[] = []
  /** 通过校验但被更高层覆盖的层。 */
  const lowerAccepted: LayerName[] = []

  for (const layer of LAYER_ORDER) {
    const bag = layers[layer]
    if (!Object.hasOwn(bag, key)) continue
    const value = bag[key]
    if (value === undefined) continue

    if (spec.secret === true) {
      // 密钥永不从配置来：值丢弃、记一条，且不覆盖任何东西。
      issues.push({
        section: sectionId,
        key,
        layer,
        code: 'secret-not-allowed',
        message: '字段「' + key + '」是密钥类，配置里给的值已被丢弃（密钥只走环境变量与凭据域）',
      })
      continue
    }

    // `null` 是「显式置空」，不是「类型错」：它必须能覆盖下层，否则
    // 界面上「清空这个字段」会变成「恢复默认」。因此跳过类型校验直接接受。
    if (value === null) {
      accepted.push({ layer, value })
      continue
    }

    const bad = checkFieldValue(spec, value)
    if (bad !== undefined) {
      issues.push({
        section: sectionId,
        key,
        layer,
        code: issueCodeOf(spec, bad),
        message: '字段「' + key + '」在 ' + layer + ' 层的值不合法：' + bad + '（该层贡献已丢弃）',
      })
      continue
    }

    accepted.push({ layer, value })
  }

  if (accepted.length === 0) {
    // 四层都没给出可用值：取出厂默认。
    const fallback = spec.default === undefined ? undefined : deepFreeze(cloneJsonShaped(spec.default))
    return deepFreeze({
      key,
      value: fallback,
      source: 'default' as const,
      mergedFrom: [] as readonly LayerName[],
      overridden: [] as readonly LayerName[],
      issues,
    })
  }

  // 从高优先级往低走：只要相邻两层都是普通对象就继续合并，一旦遇到非对象即停。
  const top = accepted[accepted.length - 1]!
  let value: unknown = cloneJsonShaped(top.value)
  const mergedFrom: LayerName[] = [top.layer]
  for (let index = accepted.length - 2; index >= 0; index -= 1) {
    const entry = accepted[index]!
    if (!isPlainObject(entry.value) || !isPlainObject(value)) {
      lowerAccepted.push(entry.layer)
      continue
    }
    value = mergeValue(entry.value, value)
    mergedFrom.unshift(entry.layer)
  }

  return deepFreeze({
    key,
    value,
    source: top.layer,
    mergedFrom,
    overridden: lowerAccepted,
    issues,
  })
}

/**
 * 解析一个段。
 * @param decl 段声明（已通过注册期校验）。
 * @param layers 四层取值。
 */
export function resolveSection(decl: SectionDecl, layers: LayerSet | undefined): ResolvedSection {
  const normalized = normalizeLayers(layers)
  const fields: Record<string, ResolvedField> = {}
  const values: Record<string, unknown> = {}
  const issues: ConfigIssue[] = []
  let fallbackCount = 0

  for (const [key, spec] of Object.entries(decl.fields)) {
    const resolved = resolveField(decl.id, key, spec, normalized)
    fields[key] = resolved
    values[key] = resolved.value
    for (const issue of resolved.issues) issues.push(issue)
    // 「回退默认」必须是可观测事件：有层尝试过给值，但全部被校验丢弃。
    // 密钥类字段不计入：它本就禁止默认值，「丢弃」是设计意图而非回退，
    // 算进来会把 fallbackCount 变成一个吓人却无意义的数字。
    const triedAndRejected = resolved.issues.some((issue) => issue.code !== 'secret-not-allowed')
    if (resolved.source === 'default' && triedAndRejected) {
      fallbackCount += 1
    }
  }

  // 层里出现了段内没声明的字段：记一条，且**不进 values**（严格白名单，防拼写错静默生效）。
  for (const layer of LAYER_ORDER) {
    for (const key of Object.keys(normalized[layer])) {
      if (Object.hasOwn(decl.fields, key)) continue
      issues.push({
        section: decl.id,
        key,
        layer,
        code: 'unknown-field',
        message: '段「' + decl.id + '」没有声明字段「' + key + '」，' +
          layer + ' 层的该值已被忽略（多半是拼写错误）',
      })
    }
  }

  return deepFreeze({
    id: decl.id,
    title: decl.title,
    values,
    fields,
    issues,
    fallbackCount,
  })
}

/**
 * 展开四档预设：把该档的增补值合成一个可直接塞进 `bundle` 层的对象。
 *
 * 走 `mergeValue` 而不是 `Object.assign`：预设里的对象型字段（例如某个子配置）
 * 应该与已有 bundle 层**深合并**，而不是整块顶掉。
 */
export function expandPreset(
  decl: SectionDecl,
  preset: string,
): Readonly<Record<string, unknown>> {
  const presets = decl.presets
  if (!presets) return deepFreeze({})
  const patch = (presets as Record<string, Readonly<Record<string, unknown>> | undefined>)[preset]
  if (patch === undefined) return deepFreeze({})
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE_KEYS.includes(key)) continue
    if (value === undefined) continue
    out[key] = cloneJsonShaped(value)
  }
  return deepFreeze(out)
}
