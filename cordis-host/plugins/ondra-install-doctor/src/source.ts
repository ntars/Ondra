/**
 * 只读的磁盘端口：把一个 profile 目录读成「层 + 补丁文件」。
 *
 * ## 为什么要自己解析路径而不是问宿主
 *
 * 宿主解析 profile 用的是 `resolveProfileDir(name, home)` + `resolveBundleDir(…)`，
 * 这条链路依赖 `ondra` 的安装锚点（`installAnchor`）、`node_modules` 提升规则、
 * 以及 `INSTALLATION_OWNED_PROFILE_TUPLES` 那套 profile 模板知识。本包**拿不到**这些，
 * 硬抄一份必然与宿主漂移——那时报告说「装得上」而宿主说「skipped」，比没有报告更坏。
 *
 * 所以本包的策略是：**只认用户显式给的 `profile-path`**，并按 Node 的 `require.resolve`
 * 语义在「profile 目录 → 逐级向上」的 `node_modules` 里找包。这条规则是 Node 的
 * 公开语义，不是猜的。找不到就如实报 `not-found`（`BundleSkipCode` 之一），
 * 而不是回退到一个「大概对」的路径。
 *
 * ## 路径安全
 *
 * 声明里的 `patch` 是**包相对路径**。宿主 `bundlePatchPaths` 直接 `join(packageDir, file)`，
 * 从不校验。本包多处一道：`..` 逃出包目录的一律拒收（记 `bad-patch-declaration`），
 * 理由是一个 pb 级的越界读在自检工具里毫无必要。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { BundleLayerView, BundleSkipCode, LogLike, PatchFileView, PatchRow } from './types.js'
import { PROFILE_PATCH_FILENAME } from './types.js'
import { isRow, parsePatchYaml } from './yaml.js'

/** 读一个文本文件；读不到返回 `undefined`。 */
function readText(path: string, maxBytes: number): { text?: string; problem?: string } {
  try {
    const info = statSync(path)
    if (!info.isFile()) return { problem: '不是一个文件' }
    if (info.size > maxBytes) return { problem: '文件 ' + String(info.size) + ' 字节，超过上限 ' + String(maxBytes) }
    return { text: readFileSync(path, 'utf8') }
  } catch (error) {
    return { problem: textOf(error) }
  }
}

/** 读一个 JSON 文件；读不到或解析不了返回 `undefined`。 */
function readJson(path: string, maxBytes: number): { value?: unknown; problem?: string } {
  const read = readText(path, maxBytes)
  if (read.text === undefined) return { problem: read.problem ?? '读不到' }
  try {
    return { value: JSON.parse(read.text) as unknown }
  } catch (error) {
    return { problem: 'JSON 解析失败：' + textOf(error) }
  }
}

/** 把任意值折成一句文本。 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 包名是否安全（防 `../../etc` 这类拼法）。 */
export function isSafePackageName(name: string): boolean {
  if (name.trim() === '') return false
  if (name.startsWith('.') || name.startsWith('/') || name.includes('\\')) return false
  // 允许 scope：`@scope/name`，但每段都不许出现 `..`。
  return name.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

/**
 * 判一个声明的补丁路径是否安全（不许逃出包目录）。
 * @param declared 声明的相对路径。
 */
export function isSafePatchPath(declared: string): boolean {
  if (declared.trim() === '') return false
  if (isAbsolute(declared)) return false
  const parts = declared.split('/')
  return !parts.includes('..')
}

/**
 * 在「起点目录 → 逐级向上」的 `node_modules` 里解析一个包目录（Node 的公开语义）。
 * @param packageName 包名。
 * @param from 起点目录（绝对）。
 * @param stopAt 上界目录（含），到这就停。
 */
export function resolvePackageDir(packageName: string, from: string, stopAt: string): string | undefined {
  let current = resolve(from)
  const stop = resolve(stopAt)
  for (let guard = 0; guard < 64; guard += 1) {
    const candidate = join(current, 'node_modules', packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (current === stop) return undefined
    const parent = resolve(current, '..')
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/** profile 清单读出来的事实。 */
export interface ProfileFacts {
  readonly dir: string
  readonly name: string
  /** `ondra.profile.bundles` 里登记的包名（按顺序）。 */
  readonly bundles: readonly string[]
  /** 清单有没有读到。 */
  readonly manifestRead: boolean
  /** 读不到的原因。 */
  readonly problem?: string
  /** 清单里 `ondra.profile` 之外的 `ondra` 内容（只用于提示「这不像个 profile」）。 */
  readonly hasProfileBlock: boolean
}

/**
 * 读 profile 清单。
 * @param dir profile 目录（绝对）。
 * @param maxBytes 单文件上限。
 */
export function readProfileFacts(dir: string, maxBytes: number): ProfileFacts {
  const manifestPath = join(dir, 'package.json')
  const read = readJson(manifestPath, maxBytes)
  const name = dir.split(sep).filter(part => part !== '').pop() ?? dir

  if (read.value === undefined) {
    return { dir, name, bundles: [], manifestRead: false, problem: read.problem ?? '读不到 package.json', hasProfileBlock: false }
  }
  const manifest = isRecord(read.value) ? read.value : {}
  const ondra = isRecord(manifest['ondra']) ? manifest['ondra'] : {}
  const profile = isRecord(ondra['profile']) ? ondra['profile'] : undefined
  if (profile === undefined) {
    return {
      dir,
      name,
      bundles: [],
      manifestRead: true,
      problem: '`package.json` 里没有 `ondra.profile`：这不像一份 profile 目录',
      hasProfileBlock: false,
    }
  }
  const raw = profile['bundles']
  const bundles: string[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string' && item.trim() !== '') bundles.push(item.trim())
    }
  }
  return { dir, name, bundles, manifestRead: true, hasProfileBlock: true }
}

/** 单层读取的结果。 */
export interface LayerFacts {
  readonly layer: BundleLayerView
  /** 这一层解析出来的补丁行（合法的那部分）。 */
  readonly rows: readonly PatchRow[]
  /** 这一层里有不支持的 YAML 语法（判定要降级成 `unverifiable`）。 */
  readonly unsupported: boolean
}

/**
 * 读一个 bundle 层：解析目录 → 读清单 → 读补丁文件 → 解析。
 *
 * **永不抛错**：任何一步失败都折成 `skipped: true` + `skipCode`。
 * @param packageName profile 里登记的包名。
 * @param profileDir profile 目录（绝对）。
 * @param maxBytes 单文件上限。
 * @param log 日志。
 */
export function readLayer(
  packageName: string,
  profileDir: string,
  maxBytes: number,
  log: LogLike,
): LayerFacts {
  const empty = (code: BundleSkipCode, reason: string): LayerFacts => ({
    layer: {
      packageName,
      patches: Object.freeze([]),
      entries: 0,
      skipped: true,
      skipReason: reason,
      skipCode: code,
    },
    rows: Object.freeze([]),
    unsupported: false,
  })

  if (!isSafePackageName(packageName)) {
    return empty('not-found', '包名「' + packageName + '」含路径穿越或非法字符，拒绝解析')
  }

  // 从 profile 目录往上找 node_modules；上界取 profile 的父目录的父目录（覆盖
  // `profiles/<name>/node_modules` 与 `profiles/node_modules` 两级提升）。
  const stopAt = resolve(profileDir, '..', '..')
  const dir = resolvePackageDir(packageName, profileDir, stopAt)
  if (dir === undefined) {
    return empty(
      'not-found',
      '在 ' + profileDir + ' 及向上两级 node_modules 里找不到这个包（没装，或 profile 的 node_modules 没链接）',
    )
  }

  const manifestRead = readJson(join(dir, 'package.json'), maxBytes)
  if (manifestRead.value === undefined) {
    return empty('manifest-unreadable', manifestRead.problem ?? '读不到 package.json')
  }
  const manifest = isRecord(manifestRead.value) ? manifestRead.value : {}
  const ondra = isRecord(manifest['ondra']) ? manifest['ondra'] : undefined
  const bundle = ondra === undefined ? undefined : isRecord(ondra['bundle']) ? ondra['bundle'] : undefined
  if (bundle === undefined) {
    // 手册 §8.3-1：宿主只往 stderr 打一行，然后**永不加载**。
    return empty('no-ondra.bundle', '`package.json` 没有 `ondra.bundle`：宿主会打一行 declares no ondra.bundle 然后永不加载这个包')
  }

  // 平台闸：`bundle.platforms` 不含当前平台 → 宿主 assertBundlePlatform 抛错 → 跳过。
  const platforms = bundle['platforms']
  if (Array.isArray(platforms) && platforms.length > 0) {
    const list = platforms.filter((item): item is string => typeof item === 'string')
    if (!list.includes(process.platform)) {
      return empty('platform-unsupported', '`ondra.bundle.platforms` 不含当前平台 ' + process.platform + '（名单：' + list.join('、') + '）')
    }
  }

  const declared = bundle['patch']
  const paths: string[] = typeof declared === 'string' ? [declared] : []
  if (Array.isArray(declared)) {
    for (const item of declared) {
      if (typeof item === 'string') paths.push(item)
    }
    if (paths.length !== declared.length) {
      return empty('bad-patch-declaration', '`ondra.bundle.patch` 数组里有非字符串项：宿主会抛 bad declaration')
    }
  }
  if (paths.length === 0) {
    return empty('bad-patch-declaration', '`ondra.bundle.patch` 既不是字符串也不是字符串数组：宿主会抛 must be a file path or a list')
  }

  const patches: PatchFileView[] = []
  const rows: PatchRow[] = []
  let unsupported = false

  for (const path of paths) {
    if (!isSafePatchPath(path)) {
      patches.push({
        declared: path,
        path: join(dir, path),
        layer: packageName,
        read: false,
        parsed: false,
        problem: '路径是绝对路径或含 `..`：本包拒绝读取（宿主不校验，是本包多加的一道）',
        rows: 0,
        unsupported: false,
      })
      continue
    }
    const absolute = join(dir, path)
    const read = readText(absolute, maxBytes)
    if (read.text === undefined) {
      patches.push({
        declared: path,
        path: absolute,
        layer: packageName,
        read: false,
        parsed: false,
        problem: read.problem ?? '不存在',
        rows: 0,
        unsupported: false,
      })
      continue
    }

    const parsed = parsePatchYaml(read.text)
    if (!parsed.ok) {
      patches.push({
        declared: path,
        path: absolute,
        layer: packageName,
        read: true,
        parsed: false,
        problem: '第 ' + String(parsed.line) + ' 行：' + parsed.reason,
        rows: 0,
        unsupported: parsed.unsupported,
        unsupportedLine: parsed.line,
      })
      if (parsed.unsupported) unsupported = true
      continue
    }
    if (!Array.isArray(parsed.value)) {
      patches.push({
        declared: path,
        path: absolute,
        layer: packageName,
        read: true,
        parsed: false,
        problem: '顶层不是数组（宿主原文：config file must be a top-level array of entries）',
        rows: 0,
        unsupported: false,
      })
      continue
    }
    let bad = 0
    for (const item of parsed.value) {
      if (!isRow(item)) {
        bad += 1
        continue
      }
      rows.push(item as PatchRow)
    }
    patches.push({
      declared: path,
      path: absolute,
      layer: packageName,
      read: true,
      parsed: true,
      problem: bad > 0 ? '有 ' + String(bad) + ' 条不是对象，已跳过' : undefined,
      rows: parsed.value.length - bad,
      unsupported: false,
    })
  }

  // 有读不到 / 解析不了的补丁 → 宿主那一层整个被 catch 掉（loadProfileDirectory 的 try 块）。
  const broken = patches.find(item => !item.parsed)
  if (broken !== undefined) {
    if (broken.unsupported) {
      // 不是「错」，是「本包判不了」：这一层进未判定，不算跳过。
      log.warn('bundle「%s」的补丁「%s」超出本包 YAML 子集，判定降级为 unverifiable：%s', packageName, broken.declared, broken.problem ?? '')
      return {
        layer: { packageName, dir, patches: Object.freeze(patches), entries: 0, skipped: false },
        rows: Object.freeze(rows),
        unsupported: true,
      }
    }
    const code: BundleSkipCode = broken.read ? 'patch-unparsable' : 'patch-unreadable'
    return empty(code, '补丁「' + broken.declared + '」：' + (broken.problem ?? '读不到') + '（宿主会把整层跳过）')
  }

  return {
    layer: {
      packageName,
      dir,
      patches: Object.freeze(patches),
      entries: 0,
      skipped: false,
    },
    rows: Object.freeze(rows),
    unsupported,
  }
}

/**
 * 读 profile 自己的 `cordis.patch.yml`（最后一层）。
 * @param profileDir profile 目录。
 * @param maxBytes 单文件上限。
 */
export function readUserLayer(profileDir: string, maxBytes: number): LayerFacts {
  const path = join(profileDir, PROFILE_PATCH_FILENAME)
  if (!existsSync(path)) {
    return {
      layer: { packageName: 'user', patches: Object.freeze([]), entries: 0, skipped: false },
      rows: Object.freeze([]),
      unsupported: false,
    }
  }
  const read = readText(path, maxBytes)
  if (read.text === undefined) {
    return {
      layer: {
        packageName: 'user',
        patches: Object.freeze([{
          declared: PROFILE_PATCH_FILENAME,
          path,
          layer: 'user',
          read: false,
          parsed: false,
          problem: read.problem ?? '读不到',
          rows: 0,
          unsupported: false,
        }]),
        entries: 0,
        skipped: true,
        skipReason: read.problem ?? '读不到',
        skipCode: 'patch-unreadable',
      },
      rows: Object.freeze([]),
      unsupported: false,
    }
  }
  const parsed = parsePatchYaml(read.text)
  if (!parsed.ok || !Array.isArray(parsed.value)) {
    const problem = parsed.ok
      ? '顶层不是数组'
      : '第 ' + String(parsed.line) + ' 行：' + parsed.reason
    return {
      layer: {
        packageName: 'user',
        patches: Object.freeze([{
          declared: PROFILE_PATCH_FILENAME,
          path,
          layer: 'user',
          read: true,
          parsed: false,
          problem,
          rows: 0,
          unsupported: !parsed.ok && parsed.unsupported,
          unsupportedLine: parsed.ok ? undefined : parsed.line,
        }]),
        entries: 0,
        skipped: true,
        skipReason: problem,
        skipCode: 'patch-unparsable',
      },
      rows: Object.freeze([]),
      unsupported: !parsed.ok && parsed.unsupported,
    }
  }
  const rows: PatchRow[] = []
  for (const item of parsed.value) {
    if (isRow(item)) rows.push(item as PatchRow)
  }
  return {
    layer: {
      packageName: 'user',
      patches: Object.freeze([{
        declared: PROFILE_PATCH_FILENAME,
        path,
        layer: 'user',
        read: true,
        parsed: true,
        rows: rows.length,
        unsupported: false,
      }]),
      entries: 0,
      skipped: false,
    },
    rows: Object.freeze(rows),
    unsupported: false,
  }
}

/**
 * 列一个目录下的子目录名（只用于报告「这里其实有这些包」这类提示）。
 * @param dir 目录。
 */
export function listSubdirs(dir: string): readonly string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(item => item.isDirectory())
      .map(item => item.name)
      .sort()
  } catch {
    return Object.freeze([])
  }
}
