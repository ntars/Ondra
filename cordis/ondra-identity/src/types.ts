/**
 * O-001 `ondra-identity` 的对外契约。
 *
 * 定位：**产品名 / 进程名 / pidfile 名 / 环境变量前缀的唯一真源**。
 * 本文件只声明形状，不落任何 IO；目录解析与权限归 O-002 `ondra-path-layout`。
 *
 * 命名硬约束（手册 §8.4）：服务键、工具名、配置键必须匹配
 * `^[a-z][a-z0-9_-]{1,63}$`（首字符小写字母，全长 2–64，只允许小写字母、
 * 数字、下划线与连字符）。**冒号不合法**，带冒号会被模型侧直接拒绝。
 */

/** 本插件注册的服务键（连字符写法）。全仓唯一归属，其他插件只许消费。 */
export const IDENTITY_SERVICE_KEY = 'ondra-identity'

/** 键名种类，仅用于错误信息措辞。 */
export type KeyKind = 'service' | 'tool' | 'config'

/** 产品事实：品牌与法务信息，改动需同步 1.1 定案。 */
export interface ProductFacts {
  /** 英文名，用作包名前缀与目录名的一部分。 */
  readonly name: string
  /** 中文名。 */
  readonly nameZh: string
  /** 完整品牌名（中英并列）。 */
  readonly fullName: string
  /** 标语。 */
  readonly slogan: string
  /** 官网域名。 */
  readonly homepage: string
  /** 版本号。 */
  readonly version: string
  /** 许可证标识。 */
  readonly license: string
  /** 应用标识：数据目录名、包名前缀、日志根命名空间共用同一个词。 */
  readonly appId: string
}

/** 环境变量名。宿主侧确实会设置 `ONDRA_PROFILE` / `ONDRA_PROFILE_DIR`。 */
export interface EnvKeys {
  /** 变量前缀，含结尾下划线，例如 `ONDRA_`。 */
  readonly prefix: string
  /** 数据根覆盖变量，例如 `ONDRA_HOME`。 */
  readonly home: string
  /** 当前 profile 名，由宿主注入。 */
  readonly profile: string
  /** 当前 profile 目录，由宿主注入。 */
  readonly profileDir: string
}

/** 数据根下的五个一级目录名（只有名字，不含路径）。 */
export interface DirNames {
  /** 用户数据：偏好、凭据、记忆库。可备份。 */
  readonly user: string
  /** 日志：中文日志与代码日志。 */
  readonly logs: string
  /** 缓存：可随时清空，不作真源。 */
  readonly cache: string
  /** 临时目录：进程退出后可丢弃。 */
  readonly tmp: string
  /** 备份：数据库快照等。 */
  readonly backups: string
}

/** 数据根下的具名文件名（只有名字，不含路径与目录）。 */
export interface FileNames {
  /** 单实例锁文件，内容为进程号。 */
  readonly pid: string
  /** 互斥锁文件，防两个实例同时写库。 */
  readonly lock: string
  /** 界面接口令牌文件名（相对 `user/` 目录）。 */
  readonly apiToken: string
}

/** 身份服务：所有命名口径的唯一查询入口。 */
export interface IdentityService {
  /** 产品事实。 */
  readonly product: ProductFacts
  /** 环境变量名。 */
  readonly env: EnvKeys
  /** 一级目录名。 */
  readonly dirs: DirNames
  /** 具名文件名。 */
  readonly files: FileNames
  /** 操作系统进程名。 */
  readonly processName: string
  /** 日志命名空间根，例如 `ondra`。 */
  readonly logNamespace: string
  /**
   * 拼一个环境变量名：`envKey('HOME')` → `'ONDRA_HOME'`。
   * @param suffix 去掉前缀后的部分，大小写不敏感，内部统一转大写。
   */
  envKey(suffix: string): string
  /**
   * 校验一个键是否合规（不抛错）。
   * @param key 待校验的键。
   */
  isValidKey(key: string): boolean
  /**
   * 校验一个键，不合规立即抛 `IdentityKeyError`。
   * 设计意图：**在本地先拦，绝不把不合规的键传给模型侧**。
   * @param key 待校验的键。
   * @param kind 键的种类，只影响错误信息措辞。
   */
  assertKey(key: string, kind?: KeyKind): string
  /**
   * 拼日志命名空间：`loggerName('emotion.core')` → `'ondra.emotion.core'`。
   * @param feature 功能短名，允许点分层级。
   */
  loggerName(feature: string): string
  /**
   * 拼 pid 文件的完整路径。
   * @param dir 数据根（由 O-002 解析后传入），本插件不解析路径。
   */
  pidFileIn(dir: string): string
  /**
   * 拼锁文件的完整路径。
   * @param dir 数据根。
   */
  lockFileIn(dir: string): string
}
