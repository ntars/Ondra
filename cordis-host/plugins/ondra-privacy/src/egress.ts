/**
 * 判定层：**纯函数，不碰 ctx、不读写任何外部状态**。
 *
 * 这里只有四件事：主机名归一与匹配、声明合法性、敏感片段扫描、风险层与处置计算。
 * 服务层（`service.ts`）负责把「现在几点、同意有没有、档位是什么」这些事实喂进来，
 * 这样本文件可以被逐条复刻对拍，而不需要起进程。
 *
 * ## 三条判定顺序，以及为什么顺序不能换
 *
 * 1. **声明缺失 / 凭据写成值 / 主机不在清单里** —— 这三条是「声明本身有问题」，
 *    排在内容扫描之前。它们与内容无关，先判能给出更准的指路。
 * 2. **敏感片段** —— 只在内容里能看出来，排第二。
 * 3. **内容种类 / 身份 / 不可逆** —— 决定 L1 还是 L2，排最后。
 *
 * 反过来写（先判种类再看内容）会得到一个坏结果：一张含密钥的截图会先被判成
 * 「L2 要确认」，用户点一次头就发出去了，而真正的问题是那张图里有一把密钥。
 *
 * ## 主机匹配：`*.example.com` 不含 `example.com`
 *
 * 通配只匹配子域。若把 `*.example.com` 写成「也匹配裸域」，那么一条为
 * `api.example.com` 写的声明会顺带放行 `example.com`——根域上常挂着与 API
 * 无关的站点，等于把范围悄悄放大一圈。
 */

import type {
  ApprovalMode,
  Consent,
  DeclareCode,
  EgressRequest,
  EgressSpec,
  EgressVerdict,
  PayloadKind,
  RiskTier,
  SecretHit,
  SecretKind,
  VerdictCode,
} from './types.js'
import {
  CREDENTIAL_REF_RE,
  MAX_HOSTS_PER_SPEC,
  NAME_RE,
  PAYLOAD_KINDS,
  SAMPLE_MAX_CHARS,
} from './types.js'
import { consentKeyOf } from './consent.js'

/** 主机名形状：小写、点分、允许 `localhost`。 */
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

/**
 * 归一化一个主机名。
 *
 * 只认**主机**：带路径、带端口、带用户名的写法一律拒——那些信息本包用不上，
 * 而放进来只会在匹配时制造歧义（`api.x.com/v1` 与 `api.x.com` 是不是同一处？）。
 * @param raw 原始写法。
 * @returns 归一后的主机名；不合规返回 `null`。
 */
export function normalizeHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let text = raw.trim().toLowerCase()
  // 尾点（FQDN 写法）去掉：`api.x.com.` 与 `api.x.com` 是同一台机器。
  if (text.endsWith('.')) text = text.slice(0, -1)
  if (text === '') return null
  if (text.includes('/') || text.includes(':') || text.includes('@')) return null
  if (text.includes('*')) return null
  if (!HOST_RE.test(text)) return null
  return text
}

/**
 * 归一化一条允许主机（可带 `*.` 前缀）。
 * @param raw 原始写法。
 * @returns 归一后的模式；不合规返回 `null`。
 */
export function normalizeHostPattern(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim().toLowerCase()
  if (text.startsWith('*.')) {
    const rest = normalizeHost(text.slice(2))
    return rest === null ? null : `*.${rest}`
  }
  return normalizeHost(text)
}

/**
 * 一个主机是否命中某条模式。
 * @param pattern 允许模式（精确或 `*.` 通配）。
 * @param host 归一后的主机。
 */
export function hostMatches(pattern: string, host: string): boolean {
  if (pattern === host) return true
  if (!pattern.startsWith('*.')) return false
  const suffix = pattern.slice(1) // `.example.com`
  return host.endsWith(suffix) && host.length > suffix.length
}

/**
 * 主机是否在允许清单里。
 * @param patterns 允许模式清单。
 * @param host 归一后的主机。
 */
export function hostAllowed(patterns: readonly string[], host: string): boolean {
  return patterns.some(pattern => hostMatches(pattern, host))
}

/** 敏感片段的一条规则。 */
interface SecretRule {
  readonly kind: SecretKind
  readonly re: RegExp
}

/**
 * 规则表。
 *
 * 顺序即优先级：`private-key` 在最前，因为它最长也最确定；`long-hex` 在最后，
 * 因为它最容易误报（SHA-256 摘要也是 64 位十六进制）。
 */
const SECRET_RULES: readonly SecretRule[] = Object.freeze([
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'api-key', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { kind: 'api-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'api-key', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { kind: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { kind: 'url-credential', re: /\/\/[^\s/@:]+:[^\s/@]+@/g },
  { kind: 'long-hex', re: /\b[0-9a-fA-F]{32,}\b/g },
])

/** 一次扫描最多报几个片段（再多也没有意义，人看不过来）。 */
export const MAX_HITS = 32

/** 扫描结果。 */
export interface ScanResult {
  /** 命中片段（只有位置与种类）。 */
  readonly hits: readonly SecretHit[]
  /** 样本是否被截断。 */
  readonly truncated: boolean
}

/**
 * 扫一段文本里的敏感片段。
 *
 * **只回位置与种类，绝不回原文**：返回值会进日志与面板，带上原文就等于本包自己
 * 成了新的泄漏点。调用方拿到 `{start, end}` 自己决定怎么遮。
 * @param text 待扫文本。
 * @returns 命中片段与是否截断。
 */
export function scanSecrets(text: string): ScanResult {
  const truncated = text.length > SAMPLE_MAX_CHARS
  const sample = truncated ? text.slice(0, SAMPLE_MAX_CHARS) : text
  const raw: SecretHit[] = []
  for (const rule of SECRET_RULES) {
    rule.re.lastIndex = 0
    for (let match = rule.re.exec(sample); match !== null; match = rule.re.exec(sample)) {
      const start = match.index
      const end = start + match[0].length
      // 零宽匹配不该出现，但正则一旦被改坏就会变成死循环。
      if (end <= start) break
      raw.push({ kind: rule.kind, start, end })
      if (raw.length >= MAX_HITS * 4) break
    }
  }
  // 重叠只留先出现的那条（规则表已按确定性排序）。
  raw.sort((left, right) => left.start - right.start || right.end - left.end)
  const hits: SecretHit[] = []
  let lastEnd = -1
  for (const hit of raw) {
    if (hit.start < lastEnd) continue
    hits.push(hit)
    lastEnd = hit.end
    if (hits.length >= MAX_HITS) break
  }
  return { hits: Object.freeze(hits), truncated }
}

/**
 * 检查一条声明是否合法。
 * @param spec 声明。
 * @param existing 已有的全部声明（用于判主人冲突）。
 * @returns 不合规时的码；合规返回 `null`。
 */
export function specIssue(spec: EgressSpec, existing: readonly EgressSpec[]): DeclareCode | null {
  if (typeof spec.id !== 'string' || !NAME_RE.test(spec.id)) return 'bad-id'
  if (typeof spec.owner !== 'string' || !NAME_RE.test(spec.owner)) return 'bad-owner'
  // 标题 / 理由 / 出处是给人看的：空着等于「用户不知道自己在同意什么」。
  if (typeof spec.title !== 'string' || spec.title.trim() === '') return 'bad-meta'
  if (typeof spec.reason !== 'string' || spec.reason.trim() === '') return 'bad-meta'
  if (typeof spec.source !== 'string' || spec.source.trim() === '') return 'bad-meta'
  if (!Array.isArray(spec.hosts)) return 'bad-host'
  if (spec.hosts.length > MAX_HOSTS_PER_SPEC) return 'bad-host'
  for (const host of spec.hosts) {
    if (normalizeHostPattern(host) === null) return 'bad-host'
  }
  if (!PAYLOAD_KINDS.some(kind => kind === spec.payload)) return 'bad-payload'
  if (spec.credentialRef !== undefined && !CREDENTIAL_REF_RE.test(spec.credentialRef)) {
    return 'bad-credential'
  }
  const other = existing.find(item => item.id === spec.id && item.owner !== spec.owner)
  if (other !== undefined) return 'owner-conflict'
  return null
}

/** 判定所需的**事实**（纯函数只吃这个）。 */
export interface EvalFacts {
  /** 声明（`undefined` = 没人登记过这个 id）。 */
  readonly spec: EgressSpec | undefined
  /** 这次请求。 */
  readonly request: EgressRequest
  /** 这个键上已有的同意（可能已过期）。 */
  readonly consent: Consent | undefined
  /** 判定时刻。 */
  readonly now: number
  /** 审批档位。 */
  readonly mode: ApprovalMode
  /** 闸门开着没有。 */
  readonly enabled: boolean
  /** 主机不在声明里时直接拒。 */
  readonly strictHosts: boolean
  /** 扫敏感片段。 */
  readonly scanSecrets: boolean
}

/** 一条同意的状态。 */
export function consentState(
  consent: Consent | undefined,
  now: number,
): 'none' | 'valid' | 'expired' {
  if (consent === undefined) return 'none'
  if (consent.expiresAt !== 0 && consent.expiresAt <= now) return 'expired'
  return 'valid'
}

/** 一层判定的中间结果。 */
interface TierFinding {
  readonly tier: RiskTier
  readonly code: VerdictCode
  readonly detail: string
  readonly hint?: string
}

/**
 * 算风险层与结果码。**不看档位、不看同意**——那两件事在 `decide()` 里。
 * @param facts 事实。
 * @returns 层与码。
 */
function findTier(facts: EvalFacts): TierFinding {
  // 重命名接住布尔开关：直接叫 `scanSecrets` 会遮住同名的模块级扫描函数，调用点就不再是函数。
  const { spec, request, strictHosts, scanSecrets: scanEnabled } = facts

  if (spec === undefined) {
    return {
      tier: 'block',
      code: 'unknown-capability',
      detail: `没有登记过出站能力「${request.id}」：本包不知道该发什么、该发到哪。`,
      hint: '由能力方先调 declare() 登记主机与内容种类，再调 evaluate()。',
    }
  }

  if (spec.credentialRef !== undefined && !CREDENTIAL_REF_RE.test(spec.credentialRef)) {
    return {
      tier: 'block',
      code: 'credential-ref-invalid',
      detail: '凭据引用不是变量名形状：配置里只许写变量名，不许写值（master-plan §6 禁令 6）。',
      hint: '把 `credentialRef` 改成环境变量名（如 `ONDRA_LLM_KEY`），值只留在凭据域。',
    }
  }

  const host = normalizeHost(request.host)
  if (host === null) {
    return {
      tier: 'block',
      code: 'host-not-declared',
      detail: `目标主机「${request.host}」不是合法主机名（不许带路径、端口、用户名）。`,
      hint: '只传主机名，如 `api.deepseek.com`。',
    }
  }

  if (!hostAllowed(spec.hosts, host)) {
    return strictHosts
      ? {
          tier: 'block',
          code: 'host-not-declared',
          detail: `「${spec.id}」声明的主机里没有 ${host}：发到别处不是配置差异，是 bug 或事故。`,
          hint: '要么改声明里的 hosts，要么改调用处的主机——两者必须一致。',
        }
      : {
          tier: 'confirm',
          code: 'host-not-declared',
          detail: `「${spec.id}」声明的主机里没有 ${host}（strictHosts 关着，改为问一次）。`,
          hint: '确认这次真的该发到这台机器。',
        }
  }

  if (scanEnabled && request.sample !== undefined && request.sample !== '') {
    const scanned = scanSecrets(request.sample)
    if (scanned.hits.length > 0) {
      const kinds = [...new Set(scanned.hits.map(hit => hit.kind))].join(' / ')
      return {
        tier: 'block',
        code: 'secret-detected',
        detail: `待发内容里有 ${scanned.hits.length} 处敏感片段（${kinds}）：密钥出域不可撤回。`,
        hint: '先把这些片段遮掉再发；返回的命中只有位置与种类，原文没有离开本函数。',
      }
    }
  }

  const payload: PayloadKind = request.payload ?? spec.payload
  if (payload === 'image' || payload === 'audio' || payload === 'file') {
    return {
      tier: 'confirm',
      code: 'payload-needs-consent',
      detail: `要发的是${payloadName(payload)}：里面有什么本包看不出来，只能由人点头。`,
      hint: '先看一眼要发的东西，再决定要不要发。',
    }
  }

  if (request.identity === true) {
    return {
      tier: 'confirm',
      code: 'identity-needs-consent',
      detail: '这次出站带可识别身份（账号 / 姓名 / 位置）：对方能把它和「谁」对上。',
      hint: '能去掉身份就去掉；去不掉就明确点头一次。',
    }
  }

  if (request.irreversible === true) {
    return {
      tier: 'confirm',
      code: 'irreversible-needs-consent',
      detail: '这次出站撤不回来（对方已经看到、或动作已生效）。',
      hint: '确认之后再发；发出去没有后悔药。',
    }
  }

  return {
    tier: 'notice',
    code: 'allowed',
    detail: '低风险出站：只发元数据或不带身份的文本。',
  }
}

/**
 * 内容种类的中文名。
 * @param payload 种类。
 */
function payloadName(payload: PayloadKind): string {
  switch (payload) {
    case 'image':
      return '图片'
    case 'audio':
      return '语音'
    case 'file':
      return '文件'
    case 'text':
      return '文本'
    case 'metadata':
      return '元数据'
  }
}

/**
 * 算处置。
 *
 * `block` 恒 `deny`：**任何档位都不放行**。若「全自动」能放开红线，那条红线就
 * 只是一句提示，而它保护的是「密钥不出域」与「数据不发去没声明的地方」——这两件
 * 事一旦发生就收不回来。
 * @param tier 风险层。
 * @param state 同意状态。
 * @param facts 事实。
 * @returns 处置。
 */
function decide(tier: RiskTier, state: 'none' | 'valid' | 'expired', facts: EvalFacts): DecisionOf {
  if (tier === 'block') return { decision: 'deny', requiresSandbox: false }
  if (tier === 'notice') return { decision: 'allow', requiresSandbox: false }
  if (state === 'valid') return { decision: 'allow', requiresSandbox: false }
  switch (facts.mode) {
    case 'supervised':
      return { decision: 'ask', requiresSandbox: false }
    case 'auto':
      // 低风险已在上一行放行；走到这里的都是 L2。`irreversible` 在 auto 档仍要问。
      return facts.request.irreversible === true
        ? { decision: 'ask', requiresSandbox: false }
        : { decision: 'allow', requiresSandbox: false }
    case 'full':
      // §8.7：全自动免审批，但**自动开启沙箱写边界**（可回滚）。
      return { decision: 'allow', requiresSandbox: true }
  }
}

/** 处置结果（带沙箱要求）。 */
interface DecisionOf {
  readonly decision: 'allow' | 'ask' | 'deny'
  readonly requiresSandbox: boolean
}

/**
 * 一次完整判定。
 * @param facts 事实。
 * @returns 判定结果。
 */
export function evaluateWith(facts: EvalFacts): EgressVerdict {
  const host = normalizeHost(facts.request.host) ?? facts.request.host.trim().toLowerCase()
  const key = consentKeyOf(facts.request.id, host)

  // 样本只扫一次：红线分支与结果返回用的是同一批命中，不各扫一遍。
  const scanned =
    facts.scanSecrets && facts.request.sample !== undefined && facts.request.sample !== ''
      ? scanSecrets(facts.request.sample)
      : { hits: Object.freeze([]) as readonly SecretHit[], truncated: false }

  // 闸门关着：**不做告知与确认，但红线照拦**。
  // 红线不是「摩擦」，是正确性：一条能被开关关掉的红线，等于没有。
  if (!facts.enabled) {
    const finding = findTier(facts)
    const blocked = finding.tier === 'block'
    return Object.freeze({
      ok: !blocked,
      decision: blocked ? 'deny' : 'allow',
      tier: finding.tier,
      code: blocked ? finding.code : 'gate-off',
      detail: blocked ? finding.detail : '隐私闸门关着：不做告知与确认（红线仍拦）。',
      ...(blocked && finding.hint !== undefined ? { hint: finding.hint } : {}),
      consentKey: key,
      secrets: scanned.hits,
      truncated: scanned.truncated,
      requiresSandbox: false,
    })
  }

  const finding = findTier(facts)
  const state = consentState(facts.consent, facts.now)
  const decided = decide(finding.tier, state, facts)

  // 层是 confirm 而处置是 ask 时，把「为什么还要问」说清楚：
  // 从没问过 vs 问过但过期了，是两种不同处境（纪律 143：别复用同一个码）。
  let code = finding.code
  let detail = finding.detail
  if (finding.tier === 'confirm' && decided.decision === 'ask') {
    if (state === 'expired') {
      code = 'consent-expired'
      detail = `${finding.detail} 上次的同意已过期，需要重新点一次。`
    } else if (state === 'none') {
      code = 'consent-missing'
      detail = `${finding.detail} 这台机器上还没有同意过。`
    }
  }

  return Object.freeze({
    ok: decided.decision === 'allow',
    decision: decided.decision,
    tier: finding.tier,
    code,
    detail,
    ...(finding.hint !== undefined ? { hint: finding.hint } : {}),
    consentKey: key,
    secrets: scanned.hits,
    truncated: scanned.truncated,
    requiresSandbox: decided.requiresSandbox,
  })
}
