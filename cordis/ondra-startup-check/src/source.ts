/**
 * 读端口：**只读**文件系统，路径关在根目录里。
 *
 * ## 为什么路径必须关起来
 *
 * 补丁文件里的路径来自 `package.json` 的声明，而 `package.json` 是**被检查的对象**。
 * 也就是说：一个坏掉的（或恶意的）包可以声明 `patch: "../../../../etc/passwd"`。
 * 本包要读它、解析它——所以端口必须自己拒绝越界，而不是相信调用方。
 *
 * 越界一律返回 `missing`（**不抛错**）：抛错会让「扫 82 个包」在第一个坏包上中断，
 * 而坏包正是最需要被看见的那个。
 *
 * ## 为什么不递归进 `node_modules`
 *
 * 一个包的 `node_modules` 可能有几万个文件，而自检要看的东西全在包根与 `src/` 下。
 * 递归进去的结果是「扫一个包要几十秒」，然后没人再点第二次。
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import type {
  LogLike,
  PackageFacts,
  PackageSource,
  PatchFileFacts,
  ProbeResult,
  SourceFile,
} from './types.js'

/** 只往这些目录里递归（深度有限）。 */
const WALK_DIRS: readonly string[] = Object.freeze(['src', 'locale'])

/** 递归深度上限。 */
const MAX_DEPTH = 3

/** 采集参数。 */
export interface CollectOptions {
  /** 单包最多读几个文件。 */
  readonly maxFiles: number
  /** 单文件最大字节数。 */
  readonly maxFileBytes: number
  /** 日志。 */
  readonly log: LogLike
}

/**
 * 去掉声明里的 `./` 前缀。
 * @param path 声明路径。
 */
export function stripDotSlash(path: string): string {
  let text = path.trim()
  while (text.startsWith('./')) text = text.slice(2)
  return text
}

/**
 * 判一段路径是不是安全的相对路径。
 * @param path 相对路径。
 */
export function isSafeRelative(path: string): boolean {
  if (path === '' || isAbsolute(path)) return false
  if (path.includes('\0')) return false
  const parts = path.split('/')
  return parts.every(part => part !== '..' && part !== '.')
}

/** 基于 `node:fs` 的只读端口。 */
export class FsSource implements PackageSource {
  /** 端口名。 */
  readonly id = 'fs'
  readonly #root: string
  readonly #maxBytes: number
  readonly #log: LogLike

  /**
   * @param root 扫描根（绝对路径）。
   * @param maxBytes 单文件上限。
   * @param log 日志。
   */
  constructor(root: string, maxBytes: number, log: LogLike) {
    this.#root = resolve(root)
    this.#maxBytes = maxBytes
    this.#log = log
  }

  /** 扫描根的绝对路径（只给内部与状态用）。 */
  get root(): string {
    return this.#root
  }

  /**
   * 把相对路径解成绝对路径（越界返回 `null`）。
   * @param rel 相对路径。
   */
  #resolve(rel: string): string | null {
    if (!isSafeRelative(rel)) return null
    const target = resolve(this.#root, rel)
    if (target !== this.#root && !target.startsWith(this.#root + sep)) return null
    return target
  }

  /** 列目录。 */
  async list(dir: string): Promise<readonly string[]> {
    const target = this.#resolve(dir === '' ? '.' : dir)
    if (target === null) return []
    try {
      const entries = await readdir(target, { withFileTypes: true })
      return entries.map(entry => entry.name).sort()
    } catch {
      return []
    }
  }

  /** 探测。 */
  async probe(path: string): Promise<ProbeResult> {
    const target = this.#resolve(path)
    if (target === null) return 'missing'
    try {
      const info = await stat(target)
      if (info.isDirectory()) return 'dir'
      if (info.size > this.#maxBytes) return 'too-big'
      return 'file'
    } catch {
      return 'missing'
    }
  }

  /** 读文本。 */
  async read(path: string): Promise<string | null> {
    const target = this.#resolve(path)
    if (target === null) return null
    try {
      const info = await stat(target)
      if (info.isDirectory() || info.size > this.#maxBytes) return null
      return await readFile(target, 'utf8')
    } catch (error) {
      // 不存在是常态（可选文件），不刷日志。
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined
      if (code !== 'ENOENT') this.#log.warn('读不到 %s（已跳过）', path)
      return null
    }
  }
}

/**
 * 走一遍目录，收集相对路径（只进 `src` 与 `locale`，深度有限）。
 * @param source 端口。
 * @param dir 当前目录（相对）。
 * @param depth 当前深度。
 * @param budget 剩余文件预算。
 */
async function walk(
  source: PackageSource,
  dir: string,
  depth: number,
  budget: { left: number },
): Promise<string[]> {
  if (budget.left <= 0 || depth > MAX_DEPTH) return []
  const names = await source.list(dir)
  const out: string[] = []
  for (const name of names) {
    if (budget.left <= 0) break
    if (name === 'node_modules' || name === '.' || name === '..') continue
    const path = dir === '' ? name : `${dir}/${name}`
    const probe = await source.probe(path)
    if (probe === 'dir') {
      // 只往 `src` / `locale` 里走：`lib` / `node_modules` 里没有自检要看的东西，
      // 进去只会把一次扫描拖成几十秒。
      if (!WALK_DIRS.includes(name)) continue
      out.push(...(await walk(source, path, depth + 1, budget)))
      continue
    }
    if (probe === 'file' || probe === 'too-big') {
      out.push(path)
      budget.left -= 1
    }
  }
  return out
}

/**
 * 读一个 JSON 文件。
 * @param source 端口。
 * @param path 相对路径。
 * @returns 解析结果与失败原因。
 */
async function readJson(
  source: PackageSource,
  path: string,
): Promise<{ readonly value: Record<string, unknown> | null; readonly error?: string }> {
  const text = await source.read(path)
  if (text === null) return { value: null, error: '读不到（不存在或太大）' }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { value: null, error: '顶层不是对象' }
    }
    return { value: parsed as Record<string, unknown> }
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 从清单里取补丁声明。
 * @param manifest 清单。
 */
function patchDeclarations(manifest: Record<string, unknown> | null): readonly string[] {
  if (manifest === null) return ['cordis.patch.yml']
  const ondra = manifest['ondra']
  if (typeof ondra !== 'object' || ondra === null || Array.isArray(ondra)) return []
  const bundle = (ondra as Record<string, unknown>)['bundle']
  if (typeof bundle !== 'object' || bundle === null || Array.isArray(bundle)) return []
  const declared = (bundle as Record<string, unknown>)['patch']
  if (typeof declared === 'string') return [stripDotSlash(declared)]
  if (Array.isArray(declared) && declared.every(item => typeof item === 'string')) {
    return (declared as string[]).map(stripDotSlash)
  }
  return []
}

/**
 * 只采集源码（建索引时用）。
 *
 * 建索引只需要「谁提供了哪个键」，不需要 README / locale / 补丁。分开一条轻路径
 * 是为了让「扫 82 个包」不必把 82 份 README 也读一遍。
 * @param source 端口。
 * @param options 采集参数。
 * @returns 源码清单。
 */
export async function collectSources(
  source: PackageSource,
  options: CollectOptions,
): Promise<readonly SourceFile[]> {
  const budget = { left: options.maxFiles }
  const files = await walk(source, '', 0, budget)
  const sources: SourceFile[] = []
  for (const path of files) {
    if (!path.startsWith('src/') || !path.endsWith('.ts') || path.endsWith('.d.ts')) continue
    const text = await source.read(path)
    if (text === null) continue
    sources.push({ path, text })
  }
  return Object.freeze(sources)
}

/**
 * 采集一个包的全部事实。
 * @param source 端口。
 * @param name 包名（目录名）。
 * @param options 采集参数。
 * @returns 事实。
 */
export async function collectFacts(
  source: PackageSource,
  name: string,
  options: CollectOptions,
): Promise<PackageFacts> {
  const budget = { left: options.maxFiles }
  const files = await walk(source, '', 0, budget)

  const manifestRead = await readJson(source, 'package.json')
  const tsconfigRead = await readJson(source, 'tsconfig.json')
  const localeZhRead = await readJson(source, 'locale/zh.json')
  const localeEnRead = await readJson(source, 'locale/en.json')
  const readme = await source.read('README.md')

  // 补丁：按声明顺序读。声明为空（没有 ondra.bundle）时仍试着读默认文件名，
  // 这样第十项能给出「文件在、但没声明」这种最隐蔽的处境。
  const declared = patchDeclarations(manifestRead.value)
  const patchPaths = declared.length > 0 ? declared : ['cordis.patch.yml']
  const patches: PatchFileFacts[] = []
  for (const path of patchPaths) {
    if (!isSafeRelative(path)) {
      patches.push({ path, text: null, problem: '路径越界（含 `..` 或绝对路径）' })
      continue
    }
    const probe = await source.probe(path)
    if (probe === 'missing') {
      patches.push({ path, text: null, problem: '不存在' })
      continue
    }
    if (probe === 'too-big') {
      patches.push({ path, text: null, problem: `超过 ${options.maxFileBytes} 字节` })
      continue
    }
    if (probe === 'dir') {
      patches.push({ path, text: null, problem: '是目录，不是文件' })
      continue
    }
    const text = await source.read(path)
    patches.push(text === null ? { path, text: null, problem: '读不出来' } : { path, text })
  }

  const sources: SourceFile[] = []
  for (const path of files) {
    if (!path.startsWith('src/') || !path.endsWith('.ts')) continue
    if (path.endsWith('.d.ts')) continue
    const text = await source.read(path)
    if (text === null) continue
    sources.push({ path, text })
  }

  return {
    name,
    files: Object.freeze([...files]),
    manifest: manifestRead.value,
    ...(manifestRead.error !== undefined ? { manifestError: manifestRead.error } : {}),
    tsconfig: tsconfigRead.value,
    ...(tsconfigRead.error !== undefined ? { tsconfigError: tsconfigRead.error } : {}),
    patches: Object.freeze(patches),
    readme,
    localeZh: localeZhRead.value,
    localeEn: localeEnRead.value,
    sources: Object.freeze(sources),
  }
}

/**
 * 判一个名字像不像包目录（`ondra-…`）。
 * @param name 名字。
 */
export function looksLikePackage(name: string): boolean {
  return name.startsWith('ondra-') && !name.includes('/')
}
