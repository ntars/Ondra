/**
 * 扫描与装包：找根 → 列包 → 解包 → 出摘要/详情。
 *
 * 这一层是**唯一碰文件系统的地方**（`service.ts` 只管状态与缓存）。
 * 分开的理由：`service.ts` 里的判定（谁胜出、哪个是当前人设）需要被反复推敲，
 * 而它们与「怎么读一个 zip」毫无关系；混在一起会让「换一种存储」变成重写整个插件。
 *
 * 三条边界：
 *
 * 1. **只读。** 本文件不出现任何写调用（`writeFileSync` / `mkdir` 之外没有别的）。
 *    唯一的「创建」是 `pathLayout.ensure('user', userSubdir)`——那是**建用户根目录**，
 *    不是写人设包。人设包本体永远只读（master-plan §17-7）。
 *
 * 2. **包坏了不抛到外面。** 一个坏包不该让「另外三个人设」也加载不出来，
 *    所以每个包独立 try/catch，失败转成一条 `PersonaIssue`。
 *
 * 3. **根不存在不算错。** 随包根在某些安装形态下确实没有（用户装的是精简版）；
 *    用户根第一次启动时也一定不存在。两者都只记 `exists: false`，
 *    由 `service.ts` 决定「一个根都没有」才报 `no-root`。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMeta } from './meta.js'
import { PERSONA_ARCHIVE_SUFFIX } from './types.js'
import { ZipError, openZip, readTextEntry } from './zip.js'
import type {
  PathLayoutLike,
  PersonaDetail,
  PersonaFileEntry,
  PersonaIssue,
  PersonaIssueCode,
  PersonaRoot,
  PersonaRootKind,
} from './types.js'
import type { Config } from './settings.js'
import type { ZipArchive } from './zip.js'

/** 随包根相对本插件包的默认位置。 */
const BUNDLED_DIR_NAME = 'ondra-persona-skills'

/** 包内运行入口文件名。 */
export const SKILL_FILE = 'SKILL.md'

/** 包内元信息文件名。 */
export const META_FILE = 'meta.json'

/** 扫描依赖。 */
export interface ScanDeps {
  /** 配置。 */
  readonly settings: Config
  /** O-002 路径服务；缺席时用户根不可用（只扫随包根）。 */
  readonly pathLayout: PathLayoutLike | undefined
}

/** 一个包的装包结果。 */
export interface LoadOutcome {
  /** 成功时的详情。 */
  readonly detail?: PersonaDetail
  /** 问题清单。 */
  readonly issues: readonly PersonaIssue[]
}

/** 错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 算随包根的默认路径。
 *
 * 人设资产**不属于插件**，因此不再放在插件目录里。仓库内的正位是
 * `content/personas/bundled/`（随仓库分发的内容资产）。
 *
 * ## 为什么不能只写死「向上三级」
 *
 * 插件在本仓有两种落地形态，**深度不一样**：
 *
 * | 形态 | `import.meta.url` 所在 | 到仓库根 |
 * | --- | --- | --- |
 * | 仓库内开发 | `plugins/<包>/lib/scan.js` | 向上 **3** 级 |
 * | 打好的运行包 | `node_modules/@ondra/<包>/lib/scan.js` | 向上 **4** 级 |
 *
 * 只写死 3 级时，开发态一切正常，**只有安装包里的她不知道自己是谁**：
 * 路径落到 `node_modules/content/personas/bundled`，一个不存在的目录，
 * 于是扫到 0 个人设 → 当前人设为空 → 人格内核 `available=false`
 * → 输出过滤的「硬红线 / 关系越线」两步永远不命中。
 * 全程没有任何报错，只有界面上人格段是空的。
 *
 * 所以这里按**由近及远**逐个试，取第一个真实存在的目录；层级数变了也不用再改。
 *
 * 保留旧的「插件同级目录」作为候选，只为兼容已经按旧布局打好的安装包：
 * 全都不存在时仍返回第一个候选，让上层如实报 `exists: false` 而不是拼一个空串。
 *
 * 用 `import.meta.url` 而不是 `process.cwd()`：cwd 是「用户从哪儿启动的」，
 * 在 Finder 双击启动的桌面应用里是 `/`，据此拼路径必然找不到。
 */
export function defaultBundledDir(): string {
  const candidates = [
    new URL('../../../content/personas/bundled', import.meta.url),
    new URL('../../../../content/personas/bundled', import.meta.url),
    new URL('../../../../../content/personas/bundled', import.meta.url),
    new URL(`../../${BUNDLED_DIR_NAME}`, import.meta.url),
  ]
  try {
    for (const candidate of candidates) {
      const path = resolve(fileURLToPath(candidate))
      try {
        if (statSync(path).isDirectory()) return path
      } catch {
        // 这个候选不在位，试下一个。
      }
    }
    return resolve(fileURLToPath(candidates[0]))
  } catch {
    return ''
  }
}

/**
 * 解析两个扫描根。**用户根在前**（同 id 时用户胜出，见 `types.ts` 第 5 条）。
 * @param deps 依赖。
 */
export function resolveRoots(deps: ScanDeps): PersonaRoot[] {
  const roots: PersonaRoot[] = []

  const userPath = ((): string | undefined => {
    if (deps.pathLayout === undefined) return undefined
    try {
      return deps.pathLayout.ensure('user', deps.settings.userSubdir)
    } catch {
      // 建不出来（权限、数据根是只读卷）不是致命：用户根就是不可用，随包根照常。
      return undefined
    }
  })()
  if (userPath !== undefined) {
    roots.push({
      kind: 'user',
      path: userPath,
      display: (deps.pathLayout === undefined ? '' : deps.pathLayout.display) + '/user/' + deps.settings.userSubdir,
      exists: true,
      found: 0,
    })
  }

  const bundledPath = deps.settings.bundledDir !== '' ? deps.settings.bundledDir : defaultBundledDir()
  if (bundledPath !== '') {
    roots.push({
      kind: 'bundled',
      path: bundledPath,
      display: 'cordis/' + BUNDLED_DIR_NAME,
      exists: existsAsDir(bundledPath),
      found: 0,
    })
  }
  return roots
}

/** 路径是不是一个存在的目录。 */
function existsAsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 列出一个根下的所有人设包（不递归）。
 * @param rootPath 根路径。
 */
export function listArchives(rootPath: string): string[] {
  let names: string[]
  try {
    names = readdirSync(rootPath)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith(PERSONA_ARCHIVE_SUFFIX)) continue
    const full = resolve(rootPath, name)
    try {
      if (!statSync(full).isFile()) continue
    } catch {
      continue
    }
    out.push(full)
  }
  out.sort()
  return out
}

/** 包文件名去掉后缀，作为 id 的最后一级候选。 */
function stemOf(archivePath: string): string {
  const name = basename(archivePath)
  const cut = name.toLowerCase().lastIndexOf(PERSONA_ARCHIVE_SUFFIX)
  return cut > 0 ? name.slice(0, cut) : name
}

/** 把 `ZipError` 映射成问题码。 */
function codeOfZipError(error: ZipError): PersonaIssueCode {
  return error.code === 'zip64' || error.code === 'encrypted' || error.code === 'unsupported-method'
    ? 'unsupported-zip'
    : 'zip-error'
}

/**
 * 装一个包。
 * @param archivePath 包绝对路径。
 * @param rootKind 来自哪个根。
 * @param settings 配置。
 */
export function loadOne(archivePath: string, rootKind: PersonaRootKind, settings: Config): LoadOutcome {
  const fileLabel = basename(archivePath)
  const issues: PersonaIssue[] = []
  /** 收一条问题。 */
  const push = (code: PersonaIssueCode, detail: string, id?: string): void => {
    issues.push(id === undefined ? { code, file: fileLabel, detail } : { code, id, file: fileLabel, detail })
  }

  let archiveBytes = 0
  try {
    archiveBytes = statSync(archivePath).size
  } catch (error) {
    push('zip-error', '读不到文件大小：' + messageOf(error))
    return { issues: Object.freeze(issues) }
  }
  if (archiveBytes > settings.maxArchiveBytes) {
    push(
      'too-large',
      '包有 ' + String(archiveBytes) + ' 字节，超过上限 ' + String(settings.maxArchiveBytes) + '，已跳过',
    )
    return { issues: Object.freeze(issues) }
  }

  let buffer: Buffer
  try {
    buffer = readFileSync(archivePath)
  } catch (error) {
    push('zip-error', '读不到文件：' + messageOf(error))
    return { issues: Object.freeze(issues) }
  }

  let archive: ZipArchive
  try {
    archive = openZip(buffer, fileLabel)
  } catch (error) {
    if (error instanceof ZipError) {
      push(codeOfZipError(error), error.message)
    } else {
      push('zip-error', '解包失败：' + messageOf(error))
    }
    return { issues: Object.freeze(issues) }
  }

  if (!archive.has(META_FILE)) {
    push('no-meta', '包里没有 meta.json，无法判定这是谁的人设包，已跳过')
    return { issues: Object.freeze(issues) }
  }
  const metaText = readTextEntry(archive, META_FILE)
  if (metaText === undefined) {
    push('bad-meta', 'meta.json 不是可读的 UTF-8 文本')
    return { issues: Object.freeze(issues) }
  }
  const parsed = parseMeta(metaText, stemOf(archivePath), fileLabel)
  for (const issue of parsed.issues) issues.push(issue)
  const meta = parsed.meta
  if (meta === undefined) return { issues: Object.freeze(issues) }

  // SKILL.md 是「运行入口」。没有它，人设能列出来但组装不出内核——
  // 所以这里只报问题、不拒收：列出来 + 说清楚「它不能用」，比静默消失好查。
  const skillText = readTextEntry(archive, SKILL_FILE)
  if (skillText === undefined) {
    push('no-skill', '包里没有可读的 SKILL.md：人设会出现在列表里，但组装不出内核', meta.id)
  }

  const files: PersonaFileEntry[] = archive.entries.map(entry => {
    if (entry.bytes > settings.maxEntryBytes && /\.(md|json|txt|ya?ml)$/i.test(entry.path)) {
      push(
        'entry-too-large',
        '「' + entry.path + '」有 ' + String(entry.bytes) + ' 字节，超过单文件上限，读文本时会被拒',
        meta.id,
      )
    }
    return { path: entry.path, bytes: entry.bytes, declared: meta.declaredFiles[entry.path] !== undefined }
  })

  const detail: PersonaDetail = Object.freeze({
    id: meta.id,
    name: meta.name,
    displayName: meta.displayName,
    version: meta.version,
    role: 'user',
    rootKind,
    archivePath,
    archiveName: fileLabel,
    triggerWords: meta.triggerWords,
    tags: meta.tags,
    tagsSource: meta.tagsSource,
    language: meta.language,
    skillChars: skillText === undefined ? 0 : Array.from(skillText).length,
    fileCount: files.length,
    archiveBytes,
    profile: meta.profile,
    source: meta.source,
    structure: meta.structure,
    safety: meta.safety,
    license: meta.license,
    declaredFiles: meta.declaredFiles,
    files: Object.freeze(files),
  })
  return { detail, issues: Object.freeze(issues) }
}
