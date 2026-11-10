/**
 * O-001 `ondra-identity`：空谷 Ondra 的身份真源。
 *
 * 职责边界（写死，越界即违规）：
 * - 只回答「叫什么名字」：产品名、进程名、pidfile 名、环境变量前缀、日志命名空间根；
 * - **不解析路径、不建目录、不 chmod**（那是 O-002 `ondra-path-layout` 的事）；
 * - 不读盘、不写盘、不联网、不注册定时器。
 *
 * 为什么值得独立成插件：命名是最便宜也最容易分裂的真源。产品名散在十个插件里，
 * 改名就要改十处且必漏一处；服务键一旦写成冒号写法，模型侧会直接拒绝
 * （手册 §8.4），而失败现场看起来像「这个工具根本不存在」。
 */

import { join } from 'node:path'
import type { Context } from '@ntars/cordis'
import { IDENTITY_SERVICE_KEY } from './types.js'
import type {
  DirNames,
  EnvKeys,
  FileNames,
  IdentityService,
  KeyKind,
  ProductFacts,
} from './types.js'

export type * from './types.js'
// 契约里既有纯类型也有运行时值，分开导出才不违背「类型导入不得混入运行时值」。
export { IDENTITY_SERVICE_KEY } from './types.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致（手册 §8.3-3）。 */
export const name = 'ondra-identity'

/**
 * 键名合法形状（手册 §8.4）。
 *
 * 刻意用字符串源而不是正则字面量：字面量里的 `{1,63}` 会让静态括号配平自检
 * 误报，而自检是每轮必跑的机械步骤，不该被自己的写法干扰。
 */
const KEY_PATTERN_SOURCE = '^[a-z][a-z0-9_-]{1,63}$'
/** 环境变量前缀形状：大写字母开头，全大写，结尾必须带下划线。 */
const ENV_PREFIX_PATTERN_SOURCE = '^[A-Z][A-Z0-9_]*_$'
/** 单个路径片段形状：不许含分隔符，防止目录名越界。 */
const SEGMENT_PATTERN_SOURCE = '^[A-Za-z0-9][A-Za-z0-9._-]*$'

/** 键名校验器（模块级编译一次）。 */
const KEY_PATTERN = new RegExp(KEY_PATTERN_SOURCE)
/** 环境变量前缀校验器。 */
const ENV_PREFIX_PATTERN = new RegExp(ENV_PREFIX_PATTERN_SOURCE)
/** 路径片段校验器。 */
const SEGMENT_PATTERN = new RegExp(SEGMENT_PATTERN_SOURCE)

/** 配置项：全部带默认值，不配置也能跑（手册 §3.3-2「默认给好，全部可调」）。 */
export interface Config {
  /** 英文名。 */
  readonly productName: string
  /** 中文名。 */
  readonly productNameZh: string
  /** 标语。 */
  readonly slogan: string
  /** 官网域名。 */
  readonly homepage: string
  /** 版本号。 */
  readonly version: string
  /** 许可证标识。 */
  readonly license: string
  /** 应用标识：数据目录名与包名前缀共用。 */
  readonly appId: string
  /** 进程名。 */
  readonly processName: string
  /** pid 文件名。 */
  readonly pidFileName: string
  /** 互斥锁文件名。 */
  readonly lockFileName: string
  /** 界面令牌文件名。 */
  readonly apiTokenFileName: string
  /** 环境变量前缀，含结尾下划线。 */
  readonly envPrefix: string
  /** 日志命名空间根。 */
  readonly logNamespace: string
  /** 用户数据目录名。 */
  readonly userDirName: string
  /** 日志目录名。 */
  readonly logsDirName: string
  /** 缓存目录名。 */
  readonly cacheDirName: string
  /** 临时目录名。 */
  readonly tmpDirName: string
  /** 备份目录名。 */
  readonly backupDirName: string
  /** 是否严格校验键名（正式版必须为 true）。 */
  readonly strictKeys: boolean
}

/** 默认值：只在这里出现一次，其他插件一律经服务读取。 */
const DEFAULT_CONFIG: Config = {
  productName: 'Ondra',
  productNameZh: '空谷',
  slogan: '于无声处，听见共鸣',
  homepage: 'ai.ntars.cn',
  version: '1.0',
  license: 'AGPL-3.0',
  appId: 'ondra',
  processName: 'ondra',
  pidFileName: 'ondra.pid',
  lockFileName: 'ondra.lock',
  apiTokenFileName: 'api-token',
  envPrefix: 'ONDRA_',
  logNamespace: 'ondra',
  userDirName: 'user',
  logsDirName: 'logs',
  cacheDirName: 'cache',
  tmpDirName: 'tmp',
  backupDirName: 'backups',
  strictKeys: true,
}

/** 配置诊断项：只带一句中文，够设置页直接显示。 */
interface ConfigIssue {
  readonly message: string
}

/** 校验结果：成功带完整配置，失败带问题清单。 */
type ConfigResult = { readonly value: Config } | { readonly issues: readonly ConfigIssue[] }

/** 配置校验失败。继承 Error，便于上层按类型区分「配置错」与「运行错」。 */
export class IdentityConfigError extends Error {
  /** 出错字段名。 */
  readonly field: string

  constructor(field: string, detail: string) {
    super('配置项 ' + field + ' 不合法：' + detail)
    this.name = 'IdentityConfigError'
    this.field = field
  }
}

/** 键名不合规。本地先拦，绝不把错键传给模型侧。 */
export class IdentityKeyError extends Error {
  /** 违规的键。 */
  readonly key: string
  /** 键的种类。 */
  readonly kind: KeyKind

  constructor(key: string, kind: KeyKind) {
    super(
      kind + ' 键「' + key + '」不符合 ' + KEY_PATTERN_SOURCE +
      '（须小写字母开头，只允许小写字母、数字、下划线与连字符，总长 2–64，冒号不合法）',
    )
    this.name = 'IdentityKeyError'
    this.key = key
    this.kind = kind
  }
}

/** 判空对象（不裸判 typeof，避免 null 漏网）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读字符串字段：缺省补默认值。 */
function readString(raw: Record<string, unknown>, key: keyof Config): string {
  const fallback = DEFAULT_CONFIG[key] as string
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') {
    throw new IdentityConfigError(String(key), '必须是字符串')
  }
  return value
}

/** 读布尔字段：缺省补默认值。 */
function readBoolean(raw: Record<string, unknown>, key: keyof Config): boolean {
  const fallback = DEFAULT_CONFIG[key] as boolean
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') {
    throw new IdentityConfigError(String(key), '必须是布尔值')
  }
  return value
}

/**
 * 把外部配置补成完整配置（缺项补默认，不报错；类型不符直接抛）。
 * @param value 宿主传入的配置行内容，可能是 undefined。
 */
function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  return {
    productName: readString(raw, 'productName'),
    productNameZh: readString(raw, 'productNameZh'),
    slogan: readString(raw, 'slogan'),
    homepage: readString(raw, 'homepage'),
    version: readString(raw, 'version'),
    license: readString(raw, 'license'),
    appId: readString(raw, 'appId'),
    processName: readString(raw, 'processName'),
    pidFileName: readString(raw, 'pidFileName'),
    lockFileName: readString(raw, 'lockFileName'),
    apiTokenFileName: readString(raw, 'apiTokenFileName'),
    envPrefix: readString(raw, 'envPrefix'),
    logNamespace: readString(raw, 'logNamespace'),
    userDirName: readString(raw, 'userDirName'),
    logsDirName: readString(raw, 'logsDirName'),
    cacheDirName: readString(raw, 'cacheDirName'),
    tmpDirName: readString(raw, 'tmpDirName'),
    backupDirName: readString(raw, 'backupDirName'),
    strictKeys: readBoolean(raw, 'strictKeys'),
  }
}

/**
 * 语义校验：schema 表达不了的约束在这里一次性拦住。
 * 任何一条不过直接抛错，让插件启动失败而不是带着错配置跑。
 * @param config 已补全的配置。
 */
function assertConfig(config: Config): void {
  const keyed: ReadonlyArray<keyof Config> = ['appId', 'processName', 'logNamespace']
  for (const field of keyed) {
    const value = config[field] as string
    if (!KEY_PATTERN.test(value)) {
      throw new IdentityConfigError(String(field), '必须匹配 ' + KEY_PATTERN_SOURCE)
    }
  }
  if (!ENV_PREFIX_PATTERN.test(config.envPrefix)) {
    throw new IdentityConfigError('envPrefix', '必须匹配 ' + ENV_PREFIX_PATTERN_SOURCE)
  }
  const segments: ReadonlyArray<keyof Config> = [
    'userDirName',
    'logsDirName',
    'cacheDirName',
    'tmpDirName',
    'backupDirName',
  ]
  for (const field of segments) {
    const value = config[field] as string
    if (!SEGMENT_PATTERN.test(value) || value === '.' || value === '..') {
      throw new IdentityConfigError(String(field), '必须是单段安全目录名')
    }
  }
  const files: ReadonlyArray<keyof Config> = ['pidFileName', 'lockFileName', 'apiTokenFileName']
  for (const field of files) {
    const value = config[field] as string
    if (value.trim() === '' || value.includes('/') || value.includes('\\')) {
      throw new IdentityConfigError(String(field), '必须是纯文件名，不许含路径分隔符')
    }
  }
}

/** 冻结成产品事实（只读快照，调用方改不动）。 */
function toProductFacts(config: Config): ProductFacts {
  return Object.freeze({
    name: config.productName,
    nameZh: config.productNameZh,
    fullName: config.productNameZh + ' ' + config.productName,
    slogan: config.slogan,
    homepage: config.homepage,
    version: config.version,
    license: config.license,
    appId: config.appId,
  })
}

/** 冻结成环境变量名表。 */
function toEnvKeys(config: Config): EnvKeys {
  return Object.freeze({
    prefix: config.envPrefix,
    home: config.envPrefix + 'HOME',
    profile: config.envPrefix + 'PROFILE',
    profileDir: config.envPrefix + 'PROFILE_DIR',
  })
}

/** 冻结成目录名表。 */
function toDirNames(config: Config): DirNames {
  return Object.freeze({
    user: config.userDirName,
    logs: config.logsDirName,
    cache: config.cacheDirName,
    tmp: config.tmpDirName,
    backups: config.backupDirName,
  })
}

/** 冻结成文件名表。 */
function toFileNames(config: Config): FileNames {
  return Object.freeze({
    pid: config.pidFileName,
    lock: config.lockFileName,
    apiToken: config.apiTokenFileName,
  })
}

/**
 * 构造身份服务实例。
 * @param config 已通过语义校验的完整配置。
 */
function createService(config: Config): IdentityService {
  const product = toProductFacts(config)
  const env = toEnvKeys(config)
  const dirs = toDirNames(config)
  const files = toFileNames(config)
  const namespace = config.logNamespace
  const strict = config.strictKeys

  return {
    product,
    env,
    dirs,
    files,
    processName: config.processName,
    logNamespace: namespace,
    envKey(suffix: string): string {
      return config.envPrefix + suffix.trim().toUpperCase()
    },
    isValidKey(key: string): boolean {
      return KEY_PATTERN.test(key)
    },
    assertKey(key: string, kind: KeyKind = 'service'): string {
      if (KEY_PATTERN.test(key)) return key
      if (strict) throw new IdentityKeyError(key, kind)
      // 非严格期放行但不静默：调用方自行记 warn，正式版必须置 strictKeys=true。
      return key
    },
    loggerName(feature: string): string {
      const trimmed = feature.trim()
      if (trimmed === '') return namespace
      return namespace + '.' + trimmed
    },
    pidFileIn(dir: string): string {
      return join(dir, files.pid)
    },
    lockFileIn(dir: string): string {
      return join(dir, files.lock)
    },
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 身份真源服务；未装载 O-001 时为 undefined。 */
    'ondra-identity'?: IdentityService
  }
}

/**
 * Cordis 入口：注册身份服务。
 * @param ctx 宿主上下文。
 * @param config 已补默认值的配置行内容。
 */
export function apply(ctx: Context, config: Config): void {
  // 再补一次：宿主可能跳过 schema 直接调用 apply（测试组合里很常见）。
  const complete = completeConfig(config)
  assertConfig(complete)
  const service = createService(complete)
  const log = ctx.logger(complete.logNamespace + '.identity')

  // 注册是 effect：插件卸载即撤下，消费方随之收到服务消失。
  ctx.effect(
    () => ctx.provide(IDENTITY_SERVICE_KEY, service),
    'ondra-identity: 注册身份服务',
  )

  log.info(
    '身份真源就绪：%s（%s），appId=%s，环境变量前缀=%s',
    service.product.fullName,
    service.product.version,
    service.product.appId,
    service.env.prefix,
  )
  if (!complete.strictKeys) {
    log.warn('strictKeys=false：键名不合规时放行不抛错，仅用于兼容期；正式版必须置 true')
  }
}

/**
 * 配置校验器：标准 schema 形状，宿主在启动前调用。
 *
 * 刻意不引入 `@ntars/schemastery`——本轮交付禁止安装依赖，
 * 引入一个无法核实版本的依赖，比手写一个够用的标准 schema 风险更高。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => ConfigResult
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown): ConfigResult {
      try {
        const complete = completeConfig(value)
        assertConfig(complete)
        return { value: complete }
      } catch (error) {
        const message = error instanceof Error ? error.message : '配置不合法'
        return { issues: [{ message }] }
      }
    },
  },
}
