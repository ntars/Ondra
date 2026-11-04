/**
 * 上游条目 → 本包 `CatalogEntry` 的归一。
 *
 * ## 为什么要有这一层
 *
 * 上游把多语言文本、可选字段、版本列表一起给出来，字段大量可选。界面若直接吃上游形状，
 * 每个消费方都要写一遍「这个字段可能没有、那个可能是对象」——写三遍就会有一遍漏掉，
 * 而漏掉的表现是界面上出现 `[object Object]`。
 *
 * 所以归一只有一处：**所有可选在这里收成 `undefined` 或空数组**，出去之后字段类型是稳的。
 *
 * ## 版本为什么取 `[0]`
 *
 * 上游把「非空、按 SemVer 优先级降序」写进了类型注释
 * （`plugin-market-index/src/types.ts` 的 `MarketPlugin.versions`）。所以「最新」= 第一个，
 * 本包不自己实现 SemVer 比较——那是一个「看起来简单、实际全是坑」的东西
 * （预发布标签、构建号、`0.x` 的 caret 语义）。上游已经算好了，照用。
 */

import type { CatalogEntry, HostEntryLike, LocalizedLike } from './types.js'

/**
 * 按语言挑一条本地化文本。
 *
 * 顺序：精确匹配 → 语言前缀（`zh-CN` → `zh`）→ `en` → 任取第一条非空。
 * 最后那步是刻意的：**宁可显示一个看不懂的语种，也不要显示空白**——
 * 空白会让人以为条目坏了，而它只是没翻成中文。
 * @param value 本地化文本。
 * @param language 目标语言。
 */
export function pickText(value: LocalizedLike | undefined, language: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') {
    const text = value.trim()
    return text === '' ? undefined : text
  }
  const table = value
  const exact = table[language]
  if (typeof exact === 'string' && exact.trim() !== '') return exact.trim()

  const dash = language.indexOf('-')
  if (dash > 0) {
    const prefix = table[language.slice(0, dash)]
    if (typeof prefix === 'string' && prefix.trim() !== '') return prefix.trim()
  }

  const en = table['en']
  if (typeof en === 'string' && en.trim() !== '') return en.trim()

  for (const candidate of Object.values(table)) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return undefined
}

/**
 * 只留字符串、去空。
 * @param value 原始数组。
 */
function stringsOf(value: readonly string[] | undefined): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([])
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '') out.push(item.trim())
  }
  return Object.freeze(out)
}

/**
 * 最新版本号。
 * @param entry 上游条目。
 */
export function latestVersionOf(entry: HostEntryLike): string | undefined {
  const versions = entry.versions
  if (!Array.isArray(versions) || versions.length === 0) return undefined
  const first = versions[0]
  if (first === undefined || typeof first.version !== 'string') return undefined
  return first.version
}

/**
 * 某个版本的安装参数。**只取上游给的，不自己拼。**
 *
 * 自己拼 `name@version` 看着等价，但只要上游的 spec 带了 registry 前缀或 lockfile 语义，
 * 拼出来的就是错的，而错的表现是「装上了另一个版本」。
 * @param entry 上游条目。
 * @param version 目标版本；省略 = 默认版本 → 最新版。
 */
export function installSpecOf(
  entry: HostEntryLike,
  version?: string,
): { spec?: string; registry?: string; version?: string } {
  const versions = entry.versions
  if (!Array.isArray(versions) || versions.length === 0) return {}

  const wanted = version ?? entry.defaultVersion ?? latestVersionOf(entry)
  const found = wanted === undefined ? undefined : versions.find(item => item.version === wanted)
  const picked = found ?? versions[0]
  if (picked === undefined) return {}

  const spec = picked.install?.spec
  const registry = picked.install?.registry
  return {
    ...(typeof spec === 'string' && spec !== '' ? { spec } : {}),
    ...(typeof registry === 'string' && registry !== '' ? { registry } : {}),
    version: picked.version,
  }
}

/** 归一参数。 */
export interface NormalizeOptions {
  readonly language: string
  readonly allowed: boolean
  readonly origin: 'builtin' | 'user' | 'host'
  readonly indexUrl?: string
}

/**
 * 上游条目 → 统一形状。
 * @param entry 上游条目。
 * @param options 归一参数。
 */
export function toCatalog(entry: HostEntryLike, options: NormalizeOptions): CatalogEntry {
  const versions = Array.isArray(entry.versions) ? entry.versions : []
  const spec = installSpecOf(entry)
  const category = entry.metadata?.category
  // 每项只挑一次：`pickText` 要遍历语言表，三处各调一遍是白扫三遍。
  const title = pickText(entry.title, options.language)
  const description = pickText(entry.description, options.language)
  const latest = latestVersionOf(entry)

  return Object.freeze({
    name: entry.name,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(typeof entry.author === 'string' && entry.author !== '' ? { author: entry.author } : {}),
    ...(typeof entry.homepage === 'string' && entry.homepage !== '' ? { homepage: entry.homepage } : {}),
    ...(typeof entry.icon === 'string' && entry.icon !== '' ? { icon: entry.icon } : {}),
    keywords: stringsOf(entry.metadata?.keywords),
    labels: stringsOf(entry.metadata?.labels),
    ...(typeof category === 'string' && category !== '' ? { category } : {}),
    ...(latest === undefined ? {} : { latestVersion: latest }),
    ...(typeof entry.defaultVersion === 'string' && entry.defaultVersion !== ''
      ? { defaultVersion: entry.defaultVersion }
      : {}),
    ...(typeof entry.installation?.status === 'string' ? { installStatus: entry.installation.status } : {}),
    ...(typeof entry.installation?.installedVersion === 'string'
      ? { installedVersion: entry.installation.installedVersion }
      : {}),
    versionCount: versions.length,
    allowed: options.allowed,
    origin: options.origin,
    ...(options.indexUrl === undefined ? {} : { indexUrl: options.indexUrl }),
    ...(spec.spec === undefined ? {} : { installSpec: spec.spec }),
  })
}
