/**
 * O-076 `ondra-privacy` 的对外契约。
 *
 * ## 台账只给了十二个字
 *
 * ```
 * | O-076 | `ondra-privacy` | 〔研〕 | 合规告知、风控三层提醒、出站清单 |
 * ```
 *
 * 「风控三层提醒」「出站清单」这两个词在手册里**一次都没有出现**（全文检索：
 * `出站` 0 命中、`三层` 0 命中、`提醒` 0 命中、`告知` 0 命中）。所以本包不能
 * 假装手册给过这三层的定义，只能从手册里**真实存在的三条红线**把它推出来：
 *
 * | 本包的三层 | 手册出处 | 原文要旨 |
 * |---|---|---|
 * | L1 告知 | §8.7「自动：低风险直接执行」 | 低风险不该打断人，但必须留下痕迹 |
 * | L2 确认 | §8.7「监督：每个高风险都弹确认」 | 高风险要一次点头 |
 * | L3 阻断 | §9.1 许可红线 / master-plan §6 禁令 6 / §9.4 | 有些事任何档位都不放行 |
 *
 * 这三层的分界不是「危险程度形容词」，而是**能不能撤销**：撤不回来的（密钥出域、
 * 私人数据发到未声明的主机）走 L3；撤得回来但对方已经看到了（截图、语音、带身份
 * 的文本）走 L2；纯元数据或匿名文本走 L1。
 *
 * ## 为什么档位（`ApprovalMode`）不改 `tier`
 *
 * `tier` 是**发现**，`decision` 是**处置**。若让「全自动」把 `tier` 直接改成
 * `notice`，面板上就再也看不见「这条其实是高风险」——那正是 §17-6 说的假开关的
 * 变体：开关拨了，风险描述也跟着消失了。所以两件事分成两个字段，档位只改
 * `decision`，`tier` 恒按事实算。
 *
 * ## 与 O-035 的口径对齐（别再写第二条密钥通路）
 *
 * `EgressSpec.credentialRef` **只存环境变量名**，本包从不解析它的值、从不把值
 * 放进任何返回值或日志。O-035 已经因为同一个理由把「密钥注入」重新定义成
 * 「存在性预检 + 引用登记」；本包沿用那个口径，不另开一条。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4）。 */
export const PRIVACY_SERVICE_KEY = 'ondra-privacy'

/** 名字合规正则（服务键 / 出站能力 id / 配置键共用）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 凭据引用名的形状：**环境变量名**，不是值。
 *
 * 大写字母开头、只含大写与下划线与数字。`sk-abc...` 这种一眼是值的写法**匹配不上**，
 * 于是它在登记期就会被拒——这是本包唯一能在「值还没泄漏」时拦住它的机会。
 */
export const CREDENTIAL_REF_RE = /^[A-Z][A-Z0-9_]{2,63}$/

/** 出站能力条数上限（防一个坏循环把注册表撑爆）。 */
export const MAX_SPECS = 64

/** 单条能力的允许主机上限。 */
export const MAX_HOSTS_PER_SPEC = 8

/** 同意默认有效期：30 天。**手册无出处，属工程取值，见 README 待裁决①**。 */
export const CONSENT_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** 一次评估里最多扫多少个字符的样本（防把整篇记忆塞进来扫）。 */
export const SAMPLE_MAX_CHARS = 8192

/** 出站内容的种类。 */
export type PayloadKind = 'text' | 'image' | 'audio' | 'file' | 'metadata'

/** 全部种类。 */
export const PAYLOAD_KINDS: readonly PayloadKind[] = Object.freeze([
  'text',
  'image',
  'audio',
  'file',
  'metadata',
])

/** 风险层（L1 / L2 / L3）。 */
export type RiskTier = 'notice' | 'confirm' | 'block'

/** 处置结果。 */
export type Decision = 'allow' | 'ask' | 'deny'

/** 分级自动审批三档（手册 §8.7）。 */
export type ApprovalMode = 'supervised' | 'auto' | 'full'

/** 全部档位。 */
export const APPROVAL_MODES: readonly ApprovalMode[] = Object.freeze([
  'supervised',
  'auto',
  'full',
])

/** 同意是谁给的。 */
export type ConsentBy = 'user' | 'policy'

/**
 * 判定结果码。
 *
 * **一个码只对应一种处境**（纪律 143）：`consent-missing`（从没问过）与
 * `consent-expired`（问过、过期了）分开，因为前者要点一次、后者要重新点一次，
 * 排查与文案都不一样。
 */
export type VerdictCode =
  | 'allowed'
  | 'gate-off'
  | 'unknown-capability'
  | 'host-not-declared'
  | 'credential-ref-invalid'
  | 'secret-detected'
  | 'payload-needs-consent'
  | 'identity-needs-consent'
  | 'irreversible-needs-consent'
  | 'consent-missing'
  | 'consent-expired'
  | 'internal-error'

/** 被扫出来的敏感片段种类。 */
export type SecretKind =
  | 'api-key'
  | 'bearer-token'
  | 'private-key'
  | 'long-hex'
  | 'url-credential'

/**
 * 一个敏感片段。
 *
 * **只有位置与种类，没有原文**——这是刻意的：判定结果会被写进日志、面板、错误
 * 上下文，一旦带上原文，本包就成了新的泄漏点。与 O-072 审计「只记形状」同一手法。
 */
export interface SecretHit {
  /** 种类。 */
  readonly kind: SecretKind
  /** 在样本中的起始下标（UTF-16 码元）。 */
  readonly start: number
  /** 结束下标（不含）。 */
  readonly end: number
}

/** 一条出站能力（**声明**，不含任何一次调用的信息）。 */
export interface EgressSpec {
  /** 能力 id，kebab。 */
  readonly id: string
  /** 声明方插件名（同一 id 只能有一个主人）。 */
  readonly owner: string
  /** 中文标题，给用户看。 */
  readonly title: string
  /** 允许发往的主机（可写 `*.example.com`）。**空 = 哪儿都不许去**。 */
  readonly hosts: readonly string[]
  /** 这一类能力默认发什么。 */
  readonly payload: PayloadKind
  /** 需要的凭据**变量名**（不是值）。 */
  readonly credentialRef?: string
  /** 有没有不联网也能用的替代路径。 */
  readonly localOnly: boolean
  /** 为什么必须出本机（一句话，给用户看）。 */
  readonly reason: string
  /** 出处（手册章节 / 上游契约）。 */
  readonly source: string
}

/** 登记结果码。**一个码只对应一种处境**（纪律 143）。 */
export type DeclareCode =
  | 'ok'
  | 'bad-id'
  | 'bad-owner'
  | 'bad-meta'
  | 'bad-host'
  | 'bad-payload'
  | 'bad-credential'
  | 'owner-conflict'
  | 'too-many'

/** 登记结果。 */
export interface DeclareResult {
  /** 成功没有。 */
  readonly ok: boolean
  /** 结果码。 */
  readonly code: DeclareCode
  /** 说明。 */
  readonly detail: string
  /** 指路（失败时给）。 */
  readonly hint?: string
}

/** 一次出站请求。 */
export interface EgressRequest {
  /** 能力 id。 */
  readonly id: string
  /** 目标主机。 */
  readonly host: string
  /** 本次实际发什么（缺省用声明的 `payload`）。 */
  readonly payload?: PayloadKind
  /** 是否带可识别身份（账号、姓名、位置、可反查的 id）。 */
  readonly identity?: boolean
  /** 发出去之后撤不撤得回来（群发、下单、删除类）。 */
  readonly irreversible?: boolean
  /**
   * 待发内容的**样本**，只用来扫敏感片段。
   *
   * 本包不保存它、不返回它、不写日志；扫完即弃。超过 `SAMPLE_MAX_CHARS` 的部分不扫
   * （结果里会带 `truncated` 说明，避免「扫过了所以没问题」的误解）。
   */
  readonly sample?: string
}

/** 判定结果。 */
export interface EgressVerdict {
  /** 能不能就这么发（`decision === 'allow'`）。 */
  readonly ok: boolean
  /** 处置：放行 / 要点头 / 拒绝。 */
  readonly decision: Decision
  /** 风险层（不受档位影响）。 */
  readonly tier: RiskTier
  /** 结果码。 */
  readonly code: VerdictCode
  /** 一句说明。 */
  readonly detail: string
  /** 指路（能直接照做的一句话）。 */
  readonly hint?: string
  /** 同意键（`id@host`），`grant()` 用它。 */
  readonly consentKey: string
  /** 扫出来的敏感片段（只有位置与种类）。 */
  readonly secrets: readonly SecretHit[]
  /** 样本被截断、只扫了前面一段。 */
  readonly truncated: boolean
  /** 本次是否要求开沙箱写边界（`full` 档的代价）。 */
  readonly requiresSandbox: boolean
}

/** 一条同意。 */
export interface Consent {
  /** 键：`id@host`。 */
  readonly key: string
  /** 能力 id。 */
  readonly id: string
  /** 主机。 */
  readonly host: string
  /** 什么时候点的头。 */
  readonly at: number
  /** 谁点的（人 / 策略）。 */
  readonly by: ConsentBy
  /** 到期时刻（`0` = 不过期）。 */
  readonly expiresAt: number
}

/** 同意结果。 */
export interface ConsentResult {
  /** 成功没有。 */
  readonly ok: boolean
  /** 结果码。 */
  readonly code: 'ok' | 'unknown-key' | 'invalid-mode'
  /** 说明。 */
  readonly detail: string
  /** 落盘了没有（没有落盘 = 重启会重新问）。 */
  readonly persisted: boolean
}

/**
 * 同意账本的读写端口。
 *
 * 只读写一段文本，序列化格式归 `consent.ts`（单一真源）。这样换存储（文件 /
 * SQLite / 测试用内存）都不用改格式代码。
 */
export interface ConsentLedger {
  /** 端口名（面板上显示用的是哪个）。 */
  readonly id: string
  /** 读全文；`null` = 还没有（不是「读失败」）。 */
  read(): string | null
  /** 写全文；返回是否成功。**不得抛错**。 */
  write(text: string): boolean
  /** 给用户看的相对位置（不暴露机器绝对路径，O-002 口径）。 */
  readonly display: string
}

/** 一条能力的展示视图。 */
export interface EgressView extends EgressSpec {
  /** 已登记几条同意（含过期的）。 */
  readonly consents: number
  /** 最近一次同意的时刻（没有则 `undefined`）。 */
  readonly lastAt?: number
}

/** 三层提醒的静态说明。 */
export interface TierDoc {
  /** 层。 */
  readonly tier: RiskTier
  /** 中文标题。 */
  readonly title: string
  /** 这一层是什么意思。 */
  readonly meaning: string
  /** 出处。 */
  readonly source: string
  /** 这一层会怎么处置。 */
  readonly behavior: string
}

/** 合规告知文本。 */
export interface NoticeText {
  /** 标题。 */
  readonly title: string
  /** 正文段落（可直接显示）。 */
  readonly body: readonly string[]
  /** 逐条出站能力（**只列形状，不列凭据值**）。 */
  readonly entries: readonly {
    readonly id: string
    readonly title: string
    readonly hosts: readonly string[]
    readonly payload: PayloadKind
    readonly localOnly: boolean
    readonly credentialRef?: string
  }[]
  /** 怎么撤回。 */
  readonly revokeHint: string
}

/** 不能用的原因（闭集）。 */
export type PrivacyReason = 'disabled'

/** 现状。 */
export interface PrivacyStatus {
  /** 总开关。 */
  readonly enabled: boolean
  /** 审批档位。 */
  readonly approvalMode: ApprovalMode
  /** 登记了几条能力。 */
  readonly specs: number
  /** 有效同意几条。 */
  readonly consents: number
  /** 过期未清的几条。 */
  readonly expired: number
  /** 账本落盘了没有。 */
  readonly persisted: boolean
  /** 账本位置（相对路径；没落盘则 `undefined`）。 */
  readonly ledgerDisplay?: string
  /** 目标主机不在声明清单里时是否直接拒（`strictHosts`）。 */
  readonly strictHosts: boolean
  /** 是否扫敏感片段。 */
  readonly scanSecrets: boolean
  /** 不能用的原因（开着就没有）。 */
  readonly reason?: PrivacyReason
}

/** 计数。 */
export interface PrivacyStats {
  /** 登记尝试。 */
  readonly declares: number
  /** 登记成功。 */
  readonly declaresOk: number
  /** 被拒登记。 */
  readonly declaresRefused: number
  /** 评估次数。 */
  readonly evaluates: number
  /** 放行。 */
  readonly allowed: number
  /** 要点头。 */
  readonly asked: number
  /** 拒绝（**只计 `tier === 'block'`**，与「要点头」分开）。 */
  readonly denied: number
  /** 因敏感片段拒绝的次数。 */
  readonly secretsFound: number
  /** 给了几条同意。 */
  readonly granted: number
  /** 撤回几条。 */
  readonly revoked: number
  /** 清理掉几条过期的。 */
  readonly expiredCleared: number
  /** 落盘失败次数。 */
  readonly writeFailed: number
}

/** O-001 的日志名前缀子集。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** 日志。 */
export interface LogLike {
  info(message: string, ...args: readonly unknown[]): void
  warn(message: string, ...args: readonly unknown[]): void
  error(message: string, ...args: readonly unknown[]): void
}

/** O-003 时钟子集。 */
export interface ClockLike {
  now(): number
}

/** O-002 路径子集（**只取用户区，且只要拼路径 + 建私有文件**）。 */
export interface PathLayoutLike {
  fileIn(area: 'user', ...segments: string[]): string
  prepareFile(filePath: string): string
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

/** 本插件对外提供的服务。 */
export interface PrivacyService {
  /** 开关开着没有。 */
  readonly available: boolean
  /** 不能用的原因（开着就没有）。 */
  readonly reason?: PrivacyReason
  /** 登记一条出站能力（同 id 同主人 = 幂等覆盖）。 */
  declare(spec: EgressSpec): DeclareResult
  /** 撤一条（幂等）。 */
  undeclare(id: string): boolean
  /** 全部声明。 */
  specs(): readonly EgressSpec[]
  /** 展示视图（带同意计数）。 */
  list(): readonly EgressView[]
  /** 问「这一次能不能发」。**永不抛错**。 */
  evaluate(request: EgressRequest): EgressVerdict
  /** 点一次头（`consentKey` 来自 `evaluate()`）。 */
  grant(consentKey: string, by?: ConsentBy): ConsentResult
  /** 撤回一条同意。 */
  revoke(consentKey: string): boolean
  /** 全部同意（含过期的，`expiresAt` 自己判）。 */
  consents(): readonly Consent[]
  /** 清过期同意，返回清掉几条。 */
  sweep(): number
  /** 合规告知文本（由声明表生成，不是硬编码清单）。 */
  notice(): NoticeText
  /** 三层提醒的静态说明。 */
  tiers(): readonly TierDoc[]
  /** 现状。 */
  status(): PrivacyStatus
  /** 计数。 */
  stats(): PrivacyStats
  /** 换账本（`null` = 只放内存）。 */
  useLedger(ledger: ConsentLedger | null): void
  /** 撤（幂等）。 */
  dispose(): void
}
