/**
 * O-084 `ondra-dev-rebrand` 的对外契约。
 *
 * ## 这个包为什么存在
 *
 * 「Dev.app 改名换图标并逐层重签」听起来是打包脚本的活，确实也是——但**改名的知识**
 * 目前散在三处互不相认的地方：显示名真源在 `scripts/product-name.mjs`，
 * 关于面板的名字硬编码在 `src/main.ts`，菜单与欢迎页的品牌词散在 `src/locale.ts` 的八种语言里。
 * 谁去改名都得先把这三处摸一遍，摸漏一处的表现是「Dock 叫新名、菜单写旧名」，
 * 而且**不会报错**。
 *
 * 所以本包的定位不是「执行改名」，而是**把改名与重签的知识收成一份可查询的契约**：
 *
 * 1. `spec()`：改名点位地图（每个点位在哪个文件、是不是单一真源）+ 逐层重签清单 + 七条不变量；
 * 2. `plan()`：把地图编成有序步骤，交给壳侧/打包链照着做；
 * 3. `audit()`：拿一份「观察到的包事实」（纯数据）回来对，报残留与签名问题；
 * 4. `judgeSignature()`：把 `codesign --display --verbose=4` 的原文翻成结构化问题。
 *
 * **本包不执行任何命令、不写任何文件、不碰 `desktop/`**。理由见 README「明确不负责」。
 *
 * ## 关于 `applied`
 *
 * `RebrandPlan.applied` 的类型是字面量 `false`。改名的动作发生在打包链里，
 * 不在插件进程里；写成 `boolean` 就等于给「假装改好了」留了位置。
 * 与 O-081 的 `PatchPlan.applied` 同一条纪律。
 */

/** 服务键。连字符，不是冒号（手册 §8.4）。 */
export const REBRAND_SERVICE_KEY = 'ondra-dev-rebrand'

/** 判定结论三值。判不了就说判不了，不拿「没查」当「没问题」。 */
export type Verdict = 'pass' | 'fail' | 'unverifiable'

/** 方案分支：`builder` 交给 electron-builder 签（默认），`manual` 打包后逐层手工重签。 */
export type RebrandBranch = 'builder' | 'manual'

/**
 * 原因码。
 *
 * `ok` 表示「没有缺口」；其余每个码都指一个**具体的缺什么**，
 * 而不是笼统的「失败」——笼统的失败码会逼人去读日志。
 */
export type RebrandReason =
  | 'ok'
  | 'disabled'
  | 'disposed'
  | 'no-brand-name'
  | 'no-bundle-id'
  | 'bad-bundle-id'
  | 'no-app-path'
  | 'no-signing-identity'
  | 'no-team-id'

/** 一条结论的出处档位。与手册 §1.8 的三档不同，这里标的是**证据强度**。 */
export type EvidenceSource = '手册' | '上游源码' | '上游注释' | '反推' | '通识'

/** 步骤种类。 */
export type StepKind = 'rename' | 'resign' | 'verify'

/**
 * 改名点位。
 *
 * `singleSource` 为 `true` 表示「改这里就够」；`false` 表示「这里也有一份，
 * 漏了就会新旧名并存」。这个字段是本包最有用的一列：它把「单一真源」这句话
 * 从口号变成可查的布尔值。
 */
export interface RebrandSite {
  /** 稳定标识，如 `display-name`。 */
  readonly id: string
  /** 上游文件（相对仓库根）。 */
  readonly file: string
  /** 具体常量 / 字段 / 方法。 */
  readonly symbol: string
  /** 当前值（只作说明，**不参与任何判定**，避免变成第二真源）。 */
  readonly current: string
  /** 改这里是否足够。 */
  readonly singleSource: boolean
  /** 改名时必须做什么。 */
  readonly action: string
  readonly source: EvidenceSource
}

/**
 * 逐层重签清单的一层。
 *
 * `action` 三值：
 * - `sign`：必须重签（由内向外）；
 * - `skip`：**预签子树，碰了就坏**（对应上游 `signIgnore`）；
 * - `sealed`：本身不签，由外层 bundle 的签名封住（`*.pak`）。
 */
export interface ResignLayer {
  readonly id: string
  /** `.app` 内相对路径。 */
  readonly path: string
  /** 由内向外的序号（10 起，留插空位）。 */
  readonly order: number
  readonly action: 'sign' | 'skip' | 'sealed'
  readonly why: string
  readonly source: EvidenceSource
}

/** 不变量：改名时**不许动**的东西。 */
export interface RebrandInvariant {
  readonly id: string
  readonly rule: string
  readonly why: string
}

/** 品牌规格全图。 */
export interface RebrandSpec {
  readonly sites: readonly RebrandSite[]
  readonly layers: readonly ResignLayer[]
  readonly invariants: readonly RebrandInvariant[]
}

/** 一条可执行步骤。`command` 只是「照抄给壳侧」的文本，本包不执行。 */
export interface RebrandStep {
  readonly index: number
  readonly kind: StepKind
  readonly title: string
  readonly detail: string
  readonly file?: string
  readonly layer?: string
  readonly command?: string
  readonly source: EvidenceSource
}

/** 改名计划。 */
export interface RebrandPlan {
  readonly branch: RebrandBranch
  readonly steps: readonly RebrandStep[]
  /** **恒为 `false`**：本包永不执行。 */
  readonly applied: false
  readonly reason: RebrandReason
  readonly detail: string
}

/** Info.plist 里与品牌相关的字段（观察值，由调用方读出来喂进来）。 */
export interface PlistFacts {
  readonly CFBundleName?: string
  readonly CFBundleDisplayName?: string
  readonly CFBundleExecutable?: string
  readonly CFBundleIdentifier?: string
  readonly CFBundleIconFile?: string
  readonly URLSchemes?: readonly string[]
}

/** 一处观察到的品牌词。`where` 用来指回文件行，方便定位。 */
export interface BrandSample {
  readonly where: string
  readonly text: string
}

/** 观察到的包事实。**全部是数据，本包不自己去读**。 */
export interface BundleFacts {
  readonly plist?: PlistFacts
  /** bundle 内实际存在的图标文件名（相对 `Contents/Resources`）。 */
  readonly iconFiles?: readonly string[]
  /** 文案里出现的品牌词（菜单、欢迎页、关于面板…）。 */
  readonly brands?: readonly BrandSample[]
  /** 允许出现的品牌词全集（全名 / 短名 / 英文名）。不给就不判。 */
  readonly acceptedBrands?: readonly string[]
  /** `NSMicrophoneUsageDescription` 原文。 */
  readonly microphoneUsage?: string
  /** 产物文件名，如 `ondra-1.0.1-mac-arm64.dmg`。 */
  readonly artifactName?: string
  /** `app.getPath('userData')` 的值。 */
  readonly userDataPath?: string
  /** `codesign --display --verbose=4` 原文。 */
  readonly signature?: string
  /** 被重签过的路径（manual 分支用；用来抓「误伤预签子树」）。 */
  readonly resignedPaths?: readonly string[]
  /** 已知未签的路径。 */
  readonly unsignedPaths?: readonly string[]
}

/** 审计结论一条。 */
export interface AuditIssue {
  readonly code: string
  readonly severity: 'error' | 'warn' | 'info'
  readonly message: string
  readonly evidence: string
}

/** 审计结果。 */
export interface RebrandAudit {
  readonly verdict: Verdict
  readonly issues: readonly AuditIssue[]
}

/** 期望的签名身份。 */
export interface SignatureExpectation {
  /**
   * 证书限定名。**不含** `Developer ID Application:` 前缀（上游自己拼），
   * 但通常**要含团队后缀** `(TEAMID)`——上游是整行严格相等，少一段就对不上。
   */
  readonly signingIdentity: string
  /** Apple Team ID。 */
  readonly teamId: string
  /** 是否同时要求安全时间戳与 hardened runtime（运行时二进制要，`.app` 本体上游不查）。 */
  readonly runtime?: boolean
}

/** 签名判定结果。 */
export interface SignatureVerdict {
  readonly verdict: Verdict
  readonly issues: readonly AuditIssue[]
}

/** 计数。 */
export interface RebrandStats {
  readonly specs: number
  readonly plans: number
  readonly audits: number
}

/** 本插件对外提供的服务。 */
export interface RebrandService {
  readonly available: boolean
  readonly reason?: RebrandReason
  /** 品牌规格全图。**永不抛**。 */
  spec(): RebrandSpec
  /** 改名 + 重签 + 校验的有序步骤。**永不抛**。 */
  plan(): RebrandPlan
  /** 拿观察事实来对。**永不抛**。 */
  audit(facts: BundleFacts): RebrandAudit
  /** 判一段 `codesign --display --verbose=4` 原文。**永不抛**。 */
  judgeSignature(details: string, expected?: SignatureExpectation): SignatureVerdict
  stats(): RebrandStats
  dispose(): void
}

/** O-001 身份子集。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** 日志。 */
export interface LogLike {
  info(message: string, ...args: readonly unknown[]): void
  warn(message: string, ...args: readonly unknown[]): void
  error(message: string, ...args: readonly unknown[]): void
}

/** O-005 字段声明形状。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'json'
  readonly default: unknown
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly pattern?: string
  readonly advancedOnly?: boolean
  readonly sensitive?: boolean
  readonly doc?: string
}

/** O-005 段声明形状。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 解析结果形状。 */
export interface ResolvedSectionLike {
  readonly id: string
  readonly values: Readonly<Record<string, unknown>>
  readonly fallbackCount: number
}

/** O-005 服务形状。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    id: string,
    layers: { readonly user?: Readonly<Record<string, unknown>> },
  ): ResolvedSectionLike | undefined
}
