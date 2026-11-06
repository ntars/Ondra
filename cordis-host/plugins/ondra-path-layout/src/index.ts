/**
 * O-002 `ondra-path-layout`：数据根解析、目录创建、权限收紧。
 *
 * 三条设计要点（都是踩过的坑，不是洁癖）：
 *
 * 1. **依赖 O-001 但不用 Cordis 的 `inject`**。`inject` 是硬依赖：服务缺席时插件保持
 *    PENDING，静默不加载。可「路径」是 L0 的命脉，一旦 PENDING 就没人知道为什么什么都没写出来。
 *    所以改成运行时 `ctx.get('ondra-identity')` 判空 + 一条中文 warn，降级到内置默认名。
 *
 * 2. **只在自己创建的目录上收紧权限**。对已有目录无条件 `chmod 0700` 会把 `~` 改成
 *    0700（连带 ssh、钥匙串一起锁死），把文件系统根改成 0700，甚至对 `/Library` 动手。
 *    所以 chmod 只对「数据根及其内部」生效，且根目录本身不 chmod 祖先。
 *
 * 3. **`0700` / `0600` 在 Windows 上无意义**。`chmod` 在 NTFS 上只会改只读位，
 *    所以非 POSIX 平台直接跳过，避免误把目录设成只读。
 *
 * 上游已有 `@ntars/ondra-home-paths`（MIT），但它只做**路径计算**、不建目录、
 * 不管权限，且不读 O-001 的目录名表。本插件复用它已核实的事实（`ONDRA_HOME`、
 * `~/.ondra`），机制自己写，理由记在 README「技术来源」。
 */

import { accessSync, chmodSync, constants, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from 'node:path'
import type { Context } from '@ntars/cordis'
import {
  PATH_LAYOUT_SERVICE_KEY,
  PathEscapeError,
  PathLayoutError,
} from './types.js'
import type { AreaName, IdentityLike, PathAreas, PathLayoutService, RootSource } from './types.js'

// 契约里既有纯类型也有运行时值（错误类供 `instanceof` 判定），分开导出才不违背
// 「类型导入不得混入运行时值」这条自检项。
export type * from './types.js'
export { PATH_LAYOUT_SERVICE_KEY, PathEscapeError, PathLayoutError } from './types.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-path-layout'

/** 默认数据根目录名（与上游 `@ntars/ondra-home-paths` 的 `ONDRA_HOME_DIR_NAME` 一致）。 */
const DEFAULT_HOME_DIR_NAME = '.ondra'
/** 默认数据根覆盖变量名（与上游 `ONDRA_HOME_ENV` 一致）。 */
const DEFAULT_HOME_ENV = 'ONDRA_HOME'
/** 目录权限：仅本人可读写进入。 */
const DIR_MODE = 0o700
/** 私有文件权限：仅本人可读写。 */
const FILE_MODE = 0o600
/** 数据根下五个区域的固定顺序（也是创建顺序）。 */
const AREA_ORDER: readonly AreaName[] = ['user', 'logs', 'cache', 'tmp', 'backups']
/** 非 POSIX 平台不折腾权限位。 */
const POSIX = process.platform !== 'win32'

/** 身份服务缺席时的兜底目录名：与 O-001 默认值保持一致。 */
const FALLBACK_DIR_NAMES: Record<AreaName, string> = {
  user: 'user',
  logs: 'logs',
  cache: 'cache',
  tmp: 'tmp',
  backups: 'backups',
}

/** 配置项：全部有默认值。 */
export interface Config {
  /**
   * 数据根。留空表示自动解析：`$ONDRA_HOME` → `~/.ondra`。
   * 支持 `~` / `~/` 前缀。
   */
  readonly root: string
  /**
   * 是否收紧权限（0700 / 0600）。默认 true；只有调试时才建议关。
   */
  readonly tightenPermissions: boolean
  /**
   * 数据根不存在时是否创建。默认 true。
   * 设为 false 时只解析不创建，用于「只读启动」或体检。
   */
  readonly createRoot: boolean
}

/** 默认配置。 */
const DEFAULT_CONFIG: Config = {
  root: '',
  tightenPermissions: true,
  createRoot: true,
}

/** 配置校验失败。 */
export class PathLayoutConfigError extends Error {
  /** 出错字段。 */
  readonly field: string

  constructor(field: string, detail: string) {
    super('配置项 ' + field + ' 不合法：' + detail)
    this.name = 'PathLayoutConfigError'
    this.field = field
  }
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 展开 `~` 前缀。
 * @param path 可能以 `~` 开头的路径。
 */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** 补全配置。 */
function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const root = raw['root']
  const tighten = raw['tightenPermissions']
  const create = raw['createRoot']
  return {
    root: typeof root === 'string' ? root : DEFAULT_CONFIG.root,
    tightenPermissions: typeof tighten === 'boolean' ? tighten : DEFAULT_CONFIG.tightenPermissions,
    createRoot: typeof create === 'boolean' ? create : DEFAULT_CONFIG.createRoot,
  }
}

/**
 * 判定一个绝对路径是否等于或位于某个根内部。
 *
 * 用「补分隔符再前缀比较」，避免 `/data/ondra-evil` 被误判为在 `/data/ondra` 内部。
 * @param root 数据根（已 resolve）。
 * @param target 待判断路径（已 resolve）。
 */
function isWithin(root: string, target: string): boolean {
  if (target === root) return true
  const withSep = root.endsWith(sep) ? root : root + sep
  return target.startsWith(withSep)
}

/**
 * 判断路径是否存在（不抛错）。
 * @param path 绝对路径。
 */
function existsSyncQuiet(path: string): boolean {
  try {
    accessSync(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 只在 POSIX 上收紧权限，失败时抛中文错误。
 * @param path 目标路径。
 * @param mode 权限位。
 * @param isDir 是否目录（只影响错误措辞）。
 */
function tighten(path: string, mode: number, isDir: boolean): void {
  if (!POSIX) return
  try {
    chmodSync(path, mode)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new PathLayoutError(path, (isDir ? '收紧目录权限失败：' : '收紧文件权限失败：') + detail)
  }
}

/**
 * 建目录，可选收紧权限。已存在则只收紧权限，不报错。
 * @param path 绝对路径。
 * @param doTighten 是否收紧到 0700（`tightenPermissions=false` 时传 false）。
 */
function ensureDir(path: string, doTighten: boolean): void {
  if (existsSyncQuiet(path)) {
    let isDir = false
    try {
      isDir = statSync(path).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) throw new PathLayoutError(path, '同名路径已存在但不是目录')
    if (doTighten) tighten(path, DIR_MODE, true)
    return
  }
  try {
    // recursive: true 让父目录缺失也能一次建好；父目录不 chmod（见文件头第 2 条）。
    mkdirSync(path, { recursive: true, mode: doTighten ? DIR_MODE : undefined })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new PathLayoutError(path, '创建目录失败：' + detail)
  }
  if (doTighten) tighten(path, DIR_MODE, true)
}

/**
 * 解析数据根。
 * @param configured 配置里显式给的数据根，空串表示未给。
 * @param env 环境变量表。
 * @returns 绝对路径与来源。
 */
function resolveRoot(configured: string, env: Record<string, string | undefined>): {
  root: string
  source: RootSource
} {
  const trimmed = configured.trim()
  if (trimmed !== '') {
    return { root: resolvePath(expandHome(trimmed)), source: 'config' }
  }
  const fromEnv = env[DEFAULT_HOME_ENV]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return { root: resolvePath(expandHome(fromEnv)), source: 'env' }
  }
  return { root: join(homedir(), DEFAULT_HOME_DIR_NAME), source: 'default' }
}

/**
 * 数据根的用户可见写法。
 * @param root 已解析的绝对根。
 * @param source 来源。
 */
function displayOf(root: string, source: RootSource): string {
  if (source === 'default') return '~/' + DEFAULT_HOME_DIR_NAME
  if (source === 'env') return '$' + DEFAULT_HOME_ENV
  const home = homedir()
  if (isWithin(home, root) && root !== home) {
    const tail = root.slice(resolvePath(home).length + 1)
    return '~/' + tail.split(sep).join('/')
  }
  return root
}

/**
 * 构造路径布局服务。
 * @param root 已解析的数据根。
 * @param source 根的来源。
 * @param dirNames 五个区域目录名（来自 O-001 或兜底）。
 * @param config 已补全的配置。
 */
function createService(
  root: string,
  source: RootSource,
  dirNames: Record<AreaName, string>,
  config: Config,
): PathLayoutService {
  const areas: PathAreas = Object.freeze({
    root,
    user: join(root, dirNames.user),
    logs: join(root, dirNames.logs),
    cache: join(root, dirNames.cache),
    tmp: join(root, dirNames.tmp),
    backups: join(root, dirNames.backups),
  })

  /** 把片段拼到根内，拒绝逃逸。 */
  function joinInside(base: string, segments: readonly string[]): string {
    for (const segment of segments) {
      if (segment === '' || segment === '.' || segment === '..') {
        throw new PathEscapeError(base, root)
      }
      if (isAbsolute(segment) || segment.includes('..')) {
        throw new PathEscapeError(join(base, segment), root)
      }
    }
    const target = resolvePath(join(base, ...segments))
    if (!isWithin(root, target)) throw new PathEscapeError(target, root)
    return target
  }

  const service: PathLayoutService = {
    areas,
    display: displayOf(root, source),
    rootSource: source,
    resolve(...segments: string[]): string {
      return joinInside(root, segments)
    },
    area(areaName: AreaName): string {
      return areas[areaName]
    },
    fileIn(areaName: AreaName, ...segments: string[]): string {
      return joinInside(areas[areaName], segments)
    },
    ensure(areaName: AreaName, ...segments: string[]): string {
      const target = joinInside(areas[areaName], segments)
      ensureDir(target, config.tightenPermissions)
      return target
    },
    prepareFile(filePath: string): string {
      const target = resolvePath(filePath)
      if (!isWithin(root, target)) throw new PathEscapeError(target, root)
      const parent = dirname(target)
      ensureDir(parent, config.tightenPermissions)
      if (!existsSyncQuiet(target)) {
        try {
          writeFileSync(target, '', {
            mode: config.tightenPermissions ? FILE_MODE : undefined,
            flag: 'wx',
          })
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          throw new PathLayoutError(target, '创建私有文件失败：' + detail)
        }
      } else {
        const stat = statSync(target)
        if (stat.isDirectory()) throw new PathLayoutError(target, '期望文件但实际是目录')
      }
      if (config.tightenPermissions) tighten(target, FILE_MODE, false)
      return target
    },
    exists(filePath: string): boolean {
      return existsSyncQuiet(filePath)
    },
    isInside(filePath: string): boolean {
      return isWithin(root, resolvePath(filePath))
    },
  }

  // createRoot=false 时只解析不创建；此时 ensure() 仍会按需创建（那是调用方的明示意图）。
  if (config.createRoot) {
    ensureDir(root, config.tightenPermissions)
    for (const areaName of AREA_ORDER) ensureDir(areas[areaName], config.tightenPermissions)
  }

  return Object.freeze(service)
}

declare module '@ntars/cordis' {
  interface Context {
    /** 路径布局服务；未装载 O-002 时为 undefined。 */
    'ondra-path-layout'?: PathLayoutService
  }
}

/**
 * Cordis 入口：解析数据根、创建五个区域、注册服务。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Config): void {
  const complete = completeConfig(config)

  // 身份服务是软依赖：缺席也能跑，但降级要说清楚。
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(
    identity ? identity.loggerName('path-layout') : 'ondra.path-layout',
  )

  let dirNames: Record<AreaName, string>
  let envTable: Record<string, string | undefined>
  if (identity) {
    // 用数据接一次，避免把服务对象整个握住（服务可能随卸载消失）。
    dirNames = {
      user: identity.dirs.user,
      logs: identity.dirs.logs,
      cache: identity.dirs.cache,
      tmp: identity.dirs.tmp,
      backups: identity.dirs.backups,
    }
    envTable = { [identity.env.home]: process.env[identity.env.home] }
  } else {
    log.warn(
      '未找到身份服务 ondra-identity，已降级到内置默认目录名（user/logs/cache/tmp/backups）与环境变量 %s；请确认 O-001 已装载',
      DEFAULT_HOME_ENV,
    )
    dirNames = { ...FALLBACK_DIR_NAMES }
    envTable = process.env
  }

  const { root, source } = resolveRoot(complete.root, envTable)
  log.info(
    '数据根解析完成：%s（来源 %s）',
    displayOf(root, source),
    source === 'config' ? '配置' : source === 'env' ? '环境变量' : '默认',
  )

  let service: PathLayoutService
  try {
    service = createService(root, source, dirNames, complete)
  } catch (error) {
    // 路径是 L0 命脉：建不出来就不提供半残服务，让下游明确拿到 undefined。
    log.error(
      '数据根初始化失败，本插件不注册服务：%s',
      error instanceof Error ? error.message : String(error),
    )
    return
  }

  ctx.effect(
    () => ctx.provide(PATH_LAYOUT_SERVICE_KEY, service),
    'ondra-path-layout: 注册路径服务',
  )

  log.info(
    '五个区域就绪：%s',
    AREA_ORDER.map((areaName) => dirNames[areaName]).join(' / '),
  )
  if (!complete.tightenPermissions) {
    log.warn('tightenPermissions=false：目录与文件权限未收紧到 0700 / 0600，仅调试期可用')
  }
}

/**
 * 配置校验器（标准 schema 形状）。
 * 不引 `@ntars/schemastery`：本轮禁止装依赖，手写校验更可控。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => { readonly value: Config } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      const complete = completeConfig(value)
      const issues: { message: string }[] = []
      if (complete.root.trim() !== '' && complete.root.trim().startsWith('-')) {
        issues.push({ message: '配置项 root 不能以连字符开头' })
      }
      if (issues.length > 0) return { issues }
      return { value: complete }
    },
  },
}
