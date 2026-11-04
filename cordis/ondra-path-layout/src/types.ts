/**
 * O-002 `ondra-path-layout` 的对外契约。
 *
 * 定位：**数据根解析、目录创建、权限收紧的唯一入口**。
 * 消费方（O-004 日志、O-006 存储、O-009 快照……）一律经 `ctx.get('ondra-path-layout')`
 * 取路径，**不得自己拼 `~/.ondra`，也不得自己 chmod**。
 *
 * 与 O-001 `ondra-identity` 的关系：目录**名字**归 O-001，目录**路径与权限**归本插件。
 * 本文件刻意不 import O-001 的源码（§15.5 禁止同轮互相 import），
 * 改为按结构对位声明 `IdentityLike`，双方契约一旦变形，本文件的类型会对不上。
 */

/** 本插件注册的服务键（连字符，非 `ondra:path-layout`）。全仓唯一归属。 */
export const PATH_LAYOUT_SERVICE_KEY = 'ondra-path-layout'

/** 数据根下的五个区域名。 */
export type AreaName = 'user' | 'logs' | 'cache' | 'tmp' | 'backups'

/** 数据根来源，用于在体检面板里解释「为什么路径在这儿」。 */
export type RootSource = 'config' | 'env' | 'default'

/** 五个区域的绝对路径。 */
export interface PathAreas {
  /** 数据根。 */
  readonly root: string
  /** 用户数据：偏好、凭据、记忆库。可备份，不可随手清。 */
  readonly user: string
  /** 日志：中文日志与代码日志。可轮转，不可整体删。 */
  readonly logs: string
  /** 缓存：随时可清空，不作真源。 */
  readonly cache: string
  /** 临时目录：进程退出后可丢弃。 */
  readonly tmp: string
  /** 备份：数据库快照。 */
  readonly backups: string
}

/**
 * O-001 身份服务的**结构对位**子集：本插件只读这几个字段。
 *
 * 之所以不用 `import type { IdentityService } from '../ondra-identity/src/types.js'`：
 * 那会让两个插件在编译期互相绑定，任一单独卸载都会让另一个编译失败（§15.5）。
 */
export interface IdentityLike {
  readonly dirs: {
    readonly user: string
    readonly logs: string
    readonly cache: string
    readonly tmp: string
    readonly backups: string
  }
  readonly env: {
    readonly home: string
  }
  /** 名字可能是别名，取一次即可；本插件只用它拼日志命名空间。 */
  loggerName(feature: string): string
}

/** 路径布局服务。 */
export interface PathLayoutService {
  /** 五个区域的绝对路径（启动时已确保存在且权限已收紧）。 */
  readonly areas: PathAreas
  /** 数据根的**用户可见**写法：默认根显示 `~/.ondra`，被改写时显示 `$ONDRA_HOME`。绝不暴露机器绝对路径。 */
  readonly display: string
  /** 数据根来源。 */
  readonly rootSource: RootSource
  /**
   * 在数据根下拼一个路径（不创建）。
   * @param segments 相对数据根的路径片段。
   */
  resolve(...segments: string[]): string
  /**
   * 取某个区域的绝对路径（不创建）。
   * @param area 区域名。
   */
  area(area: AreaName): string
  /**
   * 在某个区域下拼文件路径（不创建）。
   * @param area 区域名。
   * @param segments 相对该区域的路径片段。
   */
  fileIn(area: AreaName, ...segments: string[]): string
  /**
   * 确保某个区域下的子目录存在并收紧权限，返回其绝对路径。
   *
   * 只允许在数据根**内部**创建；越界（`..` 逃逸、绝对路径片段）抛 `PathEscapeError`。
   * @param area 区域名。
   * @param segments 相对该区域的子目录片段，可省略（此时即区域本身）。
   */
  ensure(area: AreaName, ...segments: string[]): string
  /**
   * 确保一个**私有文件**可用：父目录 0700、文件存在则收紧到 0600，不存在则以 0600 创建空文件。
   *
   * 用于 api-token、pid、锁这类文件。只允许数据根内部。
   * @param filePath 绝对路径。
   */
  prepareFile(filePath: string): string
  /**
   * 判断路径是否存在（不抛错）。
   * @param filePath 绝对路径。
   */
  exists(filePath: string): boolean
  /**
   * 判断一个绝对路径是否落在数据根内部（含根本身）。
   * @param filePath 待判断路径。
   */
  isInside(filePath: string): boolean
}

/** 路径越界：试图在数据根之外创建或改权限。 */
export class PathEscapeError extends Error {
  /** 越界的路径。 */
  readonly target: string
  /** 数据根。 */
  readonly root: string

  constructor(target: string, root: string) {
    super('路径「' + target + '」不在数据根「' + root + '」内部，拒绝创建或改权限')
    this.name = 'PathEscapeError'
    this.target = target
    this.root = root
  }
}

/** 目录创建或权限收紧失败。 */
export class PathLayoutError extends Error {
  /** 出错的路径。 */
  readonly target: string

  constructor(target: string, detail: string) {
    super('处理目录「' + target + '」失败：' + detail)
    this.name = 'PathLayoutError'
    this.target = target
  }
}
