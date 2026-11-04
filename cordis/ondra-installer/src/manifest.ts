/**
 * 清单解析：`components` 嵌套 → 展平 + 逐条校验 + 语义摘要。
 *
 * ## 为什么必须展平
 *
 * 手册 §4.6 要求「`components` 嵌套」。嵌套是人写清单时需要的（分组、批次），
 * 但**装的时候需要一个扁平列表**——否则「装到第几个了」这件事没法表达，
 * 进度条就只能按「第几组」走，而组里可能只有 1 个组件。
 *
 * 展平用 `/` 连接路径（`runtime/node`），账本与报错都用这条路径。**不用下标**：
 * 清单里加一个组件，下标全变，账本就对不上了。
 *
 * ## 为什么哈希缺失是「致命」而不是「跳过」
 *
 * 手册 §4.6 点名旧项目的病根：「`manifest.ts` 是平铺 `NODE_ARTIFACTS`，**只有哈希、
 * 无记账本**」。反过来说，**没有哈希的清单根本不该开装**——装完无法证明装的是什么。
 * 所以缺 `sha256` 直接进 `issues`，`ok` 为假，一步都不跑。
 *
 * ## 摘要为什么用「规范化后的组件表」而不是文件原文
 *
 * 用原文哈希，把清单的缩进改一下就「清单变了」，账本立刻判 `manifest-drift`——
 * 那是一次纯粹的假警报，而假警报会让人开始无视这条检查。
 * 规范化摘要只看**语义**：组件路径、名字、版本、哈希、文件名、类型、目标。
 */

import { isSha256Hex, sha256OfText } from './hash.js'
import { COMPONENT_KINDS } from './types.js'
import type { ComponentKind, ComponentSpec, ManifestIssue, ManifestParse } from './types.js'

/** 嵌套层数上限。八层足够表达「运行时 → 子模块 → 平台包」，再多是写错了。 */
export const MAX_DEPTH = 8

/** 清单格式版本。本包只认 1。 */
const MANIFEST_VERSION = 1

/** 路径片段长度上限（绝大多数文件系统单段 255 字节）。 */
const MAX_SEGMENT = 255

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 相对路径是否安全。
 *
 * 拒绝四类：绝对路径、`..` 逃逸、反斜杠（Windows 分隔符在 POSIX 上会被当普通字符，
 * 于是 `..\\x` 能绕过 `..` 检查）、空片段。
 * @param value 待判路径。
 */
export function isSafeRelative(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (text === '' || text.length > 1024) return false
  if (text.startsWith('/')) return false
  if (text.includes('\\') || text.includes('\0')) return false
  const segments = text.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return false
    if (segment.length > MAX_SEGMENT) return false
  }
  return true
}

/** 解析选项。 */
export interface ParseOptions {
  /** 组件数上限。 */
  readonly maxComponents: number
}

/** 遍历中的累计状态。 */
interface Walk {
  readonly out: ComponentSpec[]
  readonly issues: ManifestIssue[]
  readonly seen: Set<string>
  readonly max: number
  overflowed: boolean
}

/**
 * 读一个字符串字段。
 * @param item 原始对象。
 * @param key 字段名。
 */
function stringField(item: Record<string, unknown>, key: string): string | undefined {
  const value = item[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * 递归展平。
 * @param raw 待处理节点。
 * @param prefix 父级路径。
 * @param depth 当前层。
 * @param walk 累计状态。
 */
function walkNode(raw: unknown, prefix: string, depth: number, walk: Walk): void {
  if (walk.overflowed) return
  const at = prefix === '' ? 'components' : prefix

  if (!isRecord(raw)) {
    walk.issues.push({ path: at, reason: 'bad-type', message: '组件必须是一个对象' })
    return
  }

  const name = stringField(raw, 'name')
  if (name === undefined) {
    walk.issues.push({ path: at, reason: 'bad-name', message: '缺少 `name`（或用它做路径的组名）' })
    return
  }
  const path = prefix === '' ? name : `${prefix}/${name}`

  // 组：有 `components` 数组
  const children: unknown = raw['components']
  if (children !== undefined) {
    if (!Array.isArray(children)) {
      walk.issues.push({ path, reason: 'bad-type', message: '`components` 必须是数组' })
      return
    }
    if (depth >= MAX_DEPTH) {
      walk.issues.push({ path, reason: 'too-deep', message: `嵌套超过 ${String(MAX_DEPTH)} 层` })
      return
    }
    if (children.length === 0) {
      walk.issues.push({ path, reason: 'no-components', message: '组里没有任何组件' })
      return
    }
    for (const child of children) walkNode(child, path, depth + 1, walk)
    return
  }

  // 叶：组件
  if (walk.out.length >= walk.max) {
    if (!walk.overflowed) {
      walk.issues.push({
        path,
        reason: 'too-many',
        message: `组件数超过上限 ${String(walk.max)}`,
      })
      walk.overflowed = true
    }
    return
  }

  const sha = raw['sha256']
  let sha256: string | undefined
  if (sha === undefined) {
    walk.issues.push({ path, reason: 'no-sha256', message: '缺少 `sha256`（每组件独立哈希，不可省）' })
  } else if (!isSha256Hex(sha)) {
    walk.issues.push({ path, reason: 'bad-sha256', message: '`sha256` 必须是 64 位小写十六进制' })
  } else {
    sha256 = sha
  }

  const file = raw['file']
  if (file === undefined) {
    walk.issues.push({ path, reason: 'no-file', message: '缺少 `file`（相对来源目录的文件名）' })
  } else if (!isSafeRelative(file)) {
    walk.issues.push({ path, reason: 'unsafe-path', message: '`file` 必须是安全的相对路径（不得绝对、不得含 `..`）' })
  }

  const destRaw = raw['dest']
  if (destRaw !== undefined && !isSafeRelative(destRaw)) {
    walk.issues.push({ path, reason: 'unsafe-path', message: '`dest` 必须是安全的相对路径' })
  }

  const kindRaw = raw['kind']
  let kind: ComponentKind = 'file'
  if (kindRaw !== undefined) {
    if (typeof kindRaw !== 'string' || !COMPONENT_KINDS.includes(kindRaw as ComponentKind)) {
      walk.issues.push({ path, reason: 'bad-kind', message: '`kind` 只能是 `file` 或 `archive`' })
    } else {
      kind = kindRaw as ComponentKind
    }
  }

  if (sha256 === undefined || !isSafeRelative(file)) return
  if (walk.seen.has(path)) {
    walk.issues.push({ path, reason: 'duplicate-name', message: '组件路径重复（同名组件只能出现一次）' })
    return
  }
  walk.seen.add(path)

  const version = stringField(raw, 'version')
  const dest = isSafeRelative(destRaw) ? destRaw.trim() : undefined
  walk.out.push(
    Object.freeze({
      path,
      name,
      ...(version === undefined ? {} : { version }),
      sha256,
      file: file.trim(),
      kind,
      optional: raw['optional'] === true,
      exec: raw['exec'] === true,
      ...(dest === undefined ? {} : { dest }),
    }),
  )
}

/**
 * 规范化摘要：只看语义，不看缩进与键序。
 * @param components 展平后的组件。
 */
export function digestOf(components: readonly ComponentSpec[]): string {
  const rows = [...components]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(item => [
      item.path,
      item.name,
      item.version ?? '',
      item.sha256,
      item.file,
      item.kind,
      item.optional ? 1 : 0,
      item.exec ? 1 : 0,
      item.dest ?? '',
    ])
  return sha256OfText(JSON.stringify(rows))
}

/**
 * 解析清单文本。**永不抛错**：任何异常都变成 `issues`。
 * @param text 清单文本。
 * @param options 解析选项。
 */
export function parseManifest(text: string, options: ParseOptions): ManifestParse {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return Object.freeze({
      ok: false,
      issues: Object.freeze([
        {
          path: '',
          reason: 'not-object',
          message: `清单不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
        },
      ]),
    } satisfies ManifestParse)
  }

  if (!isRecord(parsed)) {
    return Object.freeze({
      ok: false,
      issues: Object.freeze([{ path: '', reason: 'not-object', message: '清单根必须是一个对象' }]),
    } satisfies ManifestParse)
  }

  if (parsed['version'] !== MANIFEST_VERSION) {
    return Object.freeze({
      ok: false,
      issues: Object.freeze([
        {
          path: 'version',
          reason: 'bad-version',
          message: `只认识清单版本 ${String(MANIFEST_VERSION)}，读到 ${String(parsed['version'])}`,
        },
      ]),
    } satisfies ManifestParse)
  }

  const list = parsed['components']
  if (!Array.isArray(list) || list.length === 0) {
    return Object.freeze({
      ok: false,
      issues: Object.freeze([{ path: 'components', reason: 'no-components', message: '`components` 必须是非空数组' }]),
    } satisfies ManifestParse)
  }

  const walk: Walk = {
    out: [],
    issues: [],
    seen: new Set<string>(),
    max: Math.max(1, Math.trunc(options.maxComponents)),
    overflowed: false,
  }
  for (const node of list) walkNode(node, '', 1, walk)

  if (walk.issues.length > 0) {
    return Object.freeze({ ok: false, issues: Object.freeze(walk.issues) })
  }

  // 排序保证摘要与顺序无关（清单里调换两行不该算「清单变了」）。
  const components = Object.freeze([...walk.out].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
  return Object.freeze({ ok: true, components, digest: digestOf(components) })
}
