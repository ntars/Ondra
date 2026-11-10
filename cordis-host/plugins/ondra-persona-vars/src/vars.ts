/**
 * 变量表与占位符替换。
 *
 * 三个设计要点：
 *
 * 1. **占位符语法是 `{{名字}}`，且只认闭集里的名字。**
 *    选双花括号不是审美：单人设卡生态里 `{{char}}` / `{{user}}` 已经是事实标准，
 *    而本仓两个人设包目前**一个占位符都没有**（逐字扫过），所以这里不是「兼容旧格式」，
 *    是「给作者一个以后能用的写法」。中文别名（`{{用户}}`）也认，因为作者是中文写手。
 *
 * 2. **替换用函数式 `replace`，不用替换字符串。**
 *    `'abc'.replace(/b/, '$&$&')` 会把 `$&` 当成「整个匹配」展开。用户填的称呼里
 *    出现 `$` 完全可能（`$ 小玖`、`A$AP`），用替换字符串会静默变成别的东西，
 *    而这类错误在提示词里看不出来。传函数就没有这个语义。
 *
 * 3. **认不出 / 没值 → 原样保留。**
 *    删掉一段占位符的后果是「她说话少半句」且无人报错；原样保留至少能被
 *    提示词预览（O-125）看见。空值同理：替换成空串等于在句子里挖洞。
 */

import { VAR_NAMES } from './types.js'
import type { VarName, VarSource, VarEntry } from './types.js'

/**
 * 变量名 → 别名表。
 *
 * **别名不是新变量**：`{{char}}` 与 `{{角色}}` 指向同一个值，共用同一个来源与同一个
 * 「没值」判定。别名表本身必须**互不重叠**（同一别名不能属于两个变量），
 * 否则「同一个占位符在两个地方换出不同的值」——这类错不会报错，只会让文本前后不一致。
 */
export const VAR_ALIASES: Readonly<Record<VarName, readonly string[]>> = Object.freeze({
  user: Object.freeze(['user', '用户', '称呼', 'user_name', 'username']),
  char: Object.freeze(['char', '角色', '人设', 'char_name']),
  relation: Object.freeze(['relation', '关系', '关系名']),
})

/** 变量中文名（界面与日志用）。 */
export const VAR_LABELS: Readonly<Record<VarName, string>> = Object.freeze({
  user: '用户称呼',
  char: '她的名字',
  relation: '关系名',
})

/**
 * 占位符正则。
 *
 * 名字部分限 `1–24` 个非花括号字符、不许换行：不限长会让一个漏写的 `{{` 把后面
 * 半段文章都吞进「变量名」里，然后在 `unknown` 里报出一个 200 字的「变量」。
 */
const PLACEHOLDER = /\{\{\s*([^{}\n]{1,24}?)\s*\}\}/g

/**
 * 别名冲突清单（正常应为空；自检会读它）。
 *
 * **必须在 `ALIAS_INDEX` 之前声明**：`buildAliasIndex()` 在模块求值时就会跑，
 * 而 `const` 在声明前处于暂时性死区——一旦真有冲突，反而会在加载期抛
 * `ReferenceError`，把一个「记一笔就够」的问题升级成「插件装不上」。
 */
const ALIAS_CONFLICT_LIST: string[] = []

/**
 * 建别名索引。
 *
 * 冲突**不抛错**（抛错会让整个插件加载失败，而这不是致命问题），
 * 只让先登记的赢，并把冲突记进 `ALIAS_CONFLICTS` 供自检读——
 * 静默覆盖才是真正危险的那种。
 */
function buildAliasIndex(): ReadonlyMap<string, VarName> {
  const index = new Map<string, VarName>()
  for (const name of VAR_NAMES) {
    for (const alias of VAR_ALIASES[name]) {
      const key = alias.toLowerCase()
      const hit = index.get(key)
      if (hit !== undefined && hit !== name) {
        ALIAS_CONFLICT_LIST.push(alias + ' → ' + hit + ' / ' + name)
        continue
      }
      index.set(key, name)
    }
  }
  return index
}

/** 别名 → 变量名（小写归一，ASCII 大小写不敏感）。 */
const ALIAS_INDEX: ReadonlyMap<string, VarName> = buildAliasIndex()

/** 别名冲突（导出只读副本）。 */
export const ALIAS_CONFLICTS: readonly string[] = Object.freeze([...ALIAS_CONFLICT_LIST])

/** 字符数（按码点算，中文一个字算一个）。 */
export function charCount(text: string): number {
  return Array.from(text).length
}

/**
 * 把一个别名解析成变量名。
 * @param raw 占位符里的原文（已去首尾空白）。
 */
export function aliasOf(raw: string): VarName | undefined {
  return ALIAS_INDEX.get(raw.toLowerCase())
}

/** 一个变量值。 */
export interface VarValue {
  /** 值（空串表示没值）。 */
  readonly value: string
  /** 来源。 */
  readonly source: VarSource
  /** 给用户看的说明。 */
  readonly note: string
}

/** 变量值表。 */
export type VarValueTable = Readonly<Record<VarName, VarValue>>

/** 替换统计（`substitute` 内部用，导出便于单测式复刻）。 */
export interface ReplaceStats {
  /** 每个变量被换了几次。 */
  readonly counts: ReadonlyMap<VarName, number>
  /** 认得出但没值。 */
  readonly unresolved: readonly VarName[]
  /** 完全不认识。 */
  readonly unknown: readonly string[]
}

/**
 * 替换占位符。
 *
 * 三条边界：
 * - 空值不替换（见文件头第 3 条）；
 * - 未知名字原样保留并去重记入 `unknown`；
 * - 同一变量出现多次只记次数，不重复报。
 * @param text 待替换文本。
 * @param table 变量值表。
 */
export function replacePlaceholders(
  text: string,
  table: VarValueTable,
): { readonly text: string; readonly stats: ReplaceStats } {
  const counts = new Map<VarName, number>()
  const unresolved: VarName[] = []
  const unknown: string[] = []

  // 函数式 replace：值里出现 `$&` `$1` 不会被当成替换模式（见文件头第 2 条）。
  const out = text.replace(PLACEHOLDER, (whole: string, rawName: string) => {
    const name = aliasOf(rawName)
    if (name === undefined) {
      if (!unknown.includes(rawName)) unknown.push(rawName)
      return whole
    }
    const entry = table[name]
    if (entry.value === '') {
      if (!unresolved.includes(name)) unresolved.push(name)
      return whole
    }
    counts.set(name, (counts.get(name) ?? 0) + 1)
    return entry.value
  })

  return { text: out, stats: { counts, unresolved: Object.freeze(unresolved), unknown: Object.freeze(unknown) } }
}

/**
 * 由三个值建变量值表。
 * @param user 用户称呼。
 * @param char 她的名字。
 * @param relation 关系名。
 */
export function tableOf(user: VarValue, char: VarValue, relation: VarValue): VarValueTable {
  return Object.freeze({ user, char, relation })
}

/**
 * 把变量值表摊成对外条目（顺序固定为 `VAR_NAMES`）。
 * @param table 变量值表。
 */
export function entriesOf(table: VarValueTable): readonly VarEntry[] {
  return Object.freeze(
    VAR_NAMES.map(name =>
      Object.freeze({
        name,
        label: VAR_LABELS[name],
        value: table[name].value,
        source: table[name].source,
        note: table[name].note,
      }),
    ),
  )
}
