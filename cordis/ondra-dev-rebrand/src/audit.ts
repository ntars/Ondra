/**
 * 审计层：把「观察到的包事实」与「期望」对一遍，报出残留与签名问题。
 *
 * ## 为什么审计吃数据，不自己读文件
 *
 * 读 `.app` 里的 Info.plist 要解析二进制/XML plist，读签名要跑 `codesign`——
 * 前者是另一种格式解析器，后者是**执行外部命令**，两件都不该发生在插件进程里
 * （本轮边界：不实装运行）。所以本包定义「事实表」，由壳侧或打包链填好喂进来。
 *
 * 好处是这一层是**纯函数**：同样的输入永远同样的输出，可以离线对拍，也不会因为
 * 磁盘上少一个文件就把「没查」说成「没问题」。
 *
 * ## 签名判定与上游的关系
 *
 * 上游 `verify-macos-signature.mjs` 的 `assertMacOSSignatureDetails` /
 * `assertMacOSRuntimeSignatureDetails` 是**抛异常**的守卫，给命令行用正合适；
 * 但界面需要「哪一条不过」而不是「崩了」。本文件只做这一层契约转换：
 * 判定的字段集与上游逐字一致（`Authority=` / `TeamIdentifier=` / `Timestamp=` / `flags=…(runtime)`），
 * 一条不多一条不少。
 *
 * **代价写在明处**：上游改了字段集，这里要同步。这是重复，但重复的是四条字符串，
 * 而不是整个签名流程——后者才是真正不该抄的东西。
 */

import { presignedRuleOf } from './spec.js'
import type {
  AuditIssue,
  BrandSample,
  BundleFacts,
  RebrandAudit,
  SignatureExpectation,
  SignatureVerdict,
  Verdict,
} from './types.js'

/** 审计用的期望值（来自配置）。 */
export interface AuditContext {
  readonly displayName: string
  readonly bundleId: string
  readonly scheme: string
  readonly artifactPrefix: string
  readonly signingIdentity: string
  readonly teamId: string
}

/** 严重度排序用。 */
const SEVERITY_RANK: Readonly<Record<AuditIssue['severity'], number>> = Object.freeze({
  error: 0,
  warn: 1,
  info: 2,
})

/**
 * 把 `codesign --display --verbose=4` 的输出切成去空行的字段集合。
 * @param details 原始输出（stdout 与 stderr 都可能在里面）。
 */
export function parseSignatureFields(details: string): readonly string[] {
  return details
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line !== '')
}

/**
 * 判一段签名输出。
 *
 * 与上游的差别只有一处：上游缺字段就抛，这里缺字段就记一条 `error` 并继续判下一条。
 * 一次把所有问题报全，比让人改一条跑一次强。
 * @param details `codesign --display --verbose=4` 原文。
 * @param expected 期望身份。
 */
export function judgeSignatureDetails(details: string, expected: SignatureExpectation): SignatureVerdict {
  const issues: AuditIssue[] = []
  const fields = parseSignatureFields(details)

  if (fields.length === 0) {
    return {
      verdict: 'unverifiable',
      issues: [
        {
          code: 'signature-empty',
          severity: 'warn',
          message: '没有签名输出，判不了。空不等于没签名——是没查。',
          evidence: 'codesign --display --verbose=4 输出为空',
        },
      ],
    }
  }

  const identity = expected.signingIdentity.trim()
  const team = expected.teamId.trim()

  if (identity === '') {
    issues.push({
      code: 'no-signing-identity',
      severity: 'warn',
      message: '没配 `signingIdentity`，身份这一项判不了。',
      evidence: 'config.signingIdentity 为空',
    })
  } else if (identity.startsWith('Developer ID Application:')) {
    // 上游 `resolveMacOSSigningEnvironment` 会直接拒绝带前缀的值：它自己拼前缀。
    // 这里提前拦一次，免得壳侧照抄配置去跑 codesign 时得到一个「找不到证书」的错。
    issues.push({
      code: 'signing-identity-has-prefix',
      severity: 'error',
      message: '`signingIdentity` 不能带 `Developer ID Application:` 前缀（上游会自己拼）。',
      evidence: `config.signingIdentity = ${identity}`,
    })
  } else {
    const authority = `Authority=Developer ID Application: ${identity}`
    if (!fields.includes(authority)) {
      // 把**实际的** Authority 行一起报出来。上游是整行严格相等，
      // 而真实证书的限定名通常带团队后缀（`Name (TEAMID)`）——只报「缺了某行」，
      // 人会以为自己证书选错了，其实是配置少写了括号那一段。
      const actual = fields.filter(line => line.startsWith('Authority='))
      issues.push({
        code: 'signature-wrong-identity',
        severity: 'error',
        message: '签名证书不是期望的那张（整行严格相等，限定名要含团队后缀）。',
        evidence: actual.length === 0 ? `缺少字段 ${authority}` : `期望 ${authority}，实际 ${actual.join(' / ')}`,
      })
    }
  }

  if (team === '') {
    issues.push({
      code: 'no-team-id',
      severity: 'warn',
      message: '没配 `teamId`，团队这一项判不了。',
      evidence: 'config.teamId 为空',
    })
  } else if (!fields.includes(`TeamIdentifier=${team}`)) {
    issues.push({
      code: 'signature-wrong-team',
      severity: 'error',
      message: '签名团队不是期望的那个。',
      evidence: `缺少字段 TeamIdentifier=${team}`,
    })
  }

  if (fields.includes('Signature=adhoc')) {
    // 开发包正常，发布包不行：ad-hoc 签名过不了 Gatekeeper，别人下载后会被拦。
    issues.push({
      code: 'signature-adhoc',
      severity: 'warn',
      message: '这是 ad-hoc 签名（开发包正常，发布包不行）。',
      evidence: 'Signature=adhoc',
    })
  }

  if (expected.runtime === true) {
    if (!fields.some(line => /^Timestamp=.+/u.test(line))) {
      issues.push({
        code: 'signature-no-timestamp',
        severity: 'error',
        message: '没有安全时间戳。',
        evidence: '缺少 Timestamp= 字段',
      })
    }
    if (!fields.some(line => /\bflags=0x[0-9a-f]+\(runtime\)(?:\s|$)/iu.test(line))) {
      issues.push({
        code: 'signature-no-runtime',
        severity: 'error',
        message: '没开 hardened runtime（`--options runtime`）。',
        evidence: '缺少 flags=0x…(runtime)',
      })
    }
  }

  // 身份或团队没配时，哪怕没有 error 也只能说「判不了」——
  // 把「没查」判成 pass，正是本仓反复拦的那件事。
  return { verdict: verdictOf(issues, identity === '' || team === ''), issues }
}

/**
 * 由问题清单推结论。
 * @param issues 问题清单。
 * @param incomplete 是否缺了判不了的关键输入。
 */
function verdictOf(issues: readonly AuditIssue[], incomplete = false): Verdict {
  if (issues.some(issue => issue.severity === 'error')) return 'fail'
  return incomplete ? 'unverifiable' : 'pass'
}

/**
 * 把品牌样本按「与允许词表不符」聚合成一条问题。
 *
 * 不逐条报：`locale.ts` 里 `Ondra` 出现 103 次，逐条报会淹掉真正要改的那几行。
 * @param samples 观察到的品牌词。
 * @param accepted 允许的词表。
 */
function staleBrandIssues(samples: readonly BrandSample[], accepted: readonly string[]): readonly AuditIssue[] {
  const buckets = new Map<string, string[]>()
  for (const sample of samples) {
    if (accepted.includes(sample.text)) continue
    const list = buckets.get(sample.text)
    if (list === undefined) buckets.set(sample.text, [sample.where])
    else list.push(sample.where)
  }

  const issues: AuditIssue[] = []
  for (const [text, wheres] of buckets) {
    const head = wheres.slice(0, 3).join('、')
    const more = wheres.length > 3 ? ` 等 ${String(wheres.length)} 处` : ''
    issues.push({
      code: 'stale-brand',
      severity: 'warn',
      message: `文案里还有不在词表里的品牌词「${text}」。`,
      evidence: `${head}${more}`,
    })
  }
  return issues
}

/**
 * 审计一份包事实。
 * @param facts 观察事实。
 * @param context 期望值。
 */
export function auditBundle(facts: BundleFacts, context: AuditContext): RebrandAudit {
  const issues: AuditIssue[] = []
  const name = context.displayName.trim()
  const plist = facts.plist

  if (name === '') {
    issues.push({
      code: 'name-undeclared',
      severity: 'warn',
      message: '没配 `displayName`：所有「名字对不对」的检查都判不了。',
      evidence: 'config.displayName 为空',
    })
  }

  if (plist !== undefined) {
    if (name !== '') {
      if (plist.CFBundleName !== undefined && plist.CFBundleName !== name) {
        issues.push({
          code: 'stale-plist-name',
          severity: 'warn',
          message: '`CFBundleName` 还是旧名。',
          evidence: `CFBundleName = ${plist.CFBundleName}，期望 ${name}`,
        })
      }
      if (plist.CFBundleDisplayName !== undefined && plist.CFBundleDisplayName !== name) {
        issues.push({
          code: 'stale-plist-display-name',
          severity: 'warn',
          message: '`CFBundleDisplayName` 还是旧名（Dock 与访达显示的就是它）。',
          evidence: `CFBundleDisplayName = ${plist.CFBundleDisplayName}，期望 ${name}`,
        })
      }
      if (plist.CFBundleExecutable !== undefined && plist.CFBundleExecutable !== name) {
        issues.push({
          code: 'stale-executable-name',
          severity: 'warn',
          message: '`CFBundleExecutable` 与显示名不一致：`Contents/MacOS/` 里那个文件名也得跟着改。',
          evidence: `CFBundleExecutable = ${plist.CFBundleExecutable}，期望 ${name}`,
        })
      }
    }

    const bundleId = context.bundleId.trim()
    if (bundleId !== '' && plist.CFBundleIdentifier !== undefined && plist.CFBundleIdentifier !== bundleId) {
      issues.push({
        code: 'bundle-id-changed',
        severity: 'error',
        message: 'bundle id 变了。老用户会收不到更新、已授的权限要重新点。',
        evidence: `CFBundleIdentifier = ${plist.CFBundleIdentifier}，期望 ${bundleId}`,
      })
    }

    const scheme = context.scheme.trim()
    if (scheme !== '' && plist.URLSchemes !== undefined && !plist.URLSchemes.includes(scheme)) {
      issues.push({
        code: 'scheme-changed',
        severity: 'error',
        message: '深链 scheme 变了：已发布的链接会 404，而且报错在别人的浏览器里。',
        evidence: `URLSchemes = ${plist.URLSchemes.join(',')}，期望含 ${scheme}`,
      })
    }

  }

  // 图标这两条**不依赖 plist**：bundle 里一个图标都没有是事实，
  // 放在 plist 分支里会让「只给了 iconFiles、没给 plist」的调用方得到零结论。
  if (facts.iconFiles !== undefined) {
    if (facts.iconFiles.length === 0) {
      issues.push({
        code: 'icon-missing',
        severity: 'error',
        message: 'bundle 里一个图标文件都没有，Dock 会显示空白或系统占位图。',
        evidence: 'Contents/Resources 下无 .icns / .png',
      })
    } else if (plist?.CFBundleIconFile !== undefined && !facts.iconFiles.includes(plist.CFBundleIconFile)) {
      issues.push({
        code: 'icon-not-referenced',
        severity: 'error',
        message: 'plist 指向的图标文件不在 bundle 里，系统会回退到默认图标且不报错。',
        evidence: `CFBundleIconFile = ${plist.CFBundleIconFile}，实际有 ${facts.iconFiles.join(',')}`,
      })
    }
  }

  if (facts.brands !== undefined && facts.acceptedBrands !== undefined) {
    issues.push(...staleBrandIssues(facts.brands, facts.acceptedBrands))
  }

  if (facts.microphoneUsage !== undefined && facts.acceptedBrands !== undefined && facts.acceptedBrands.length > 0) {
    const usage = facts.microphoneUsage
    if (!facts.acceptedBrands.some(brand => brand !== '' && usage.includes(brand))) {
      issues.push({
        code: 'usage-string-unbranded',
        severity: 'warn',
        message: '麦克风授权文案里没有任何当前品牌词，系统弹窗会显示一个不认识的名字。',
        evidence: usage,
      })
    }
  }

  if (facts.artifactName !== undefined && context.artifactPrefix !== '') {
    if (!facts.artifactName.startsWith(context.artifactPrefix)) {
      issues.push({
        code: 'stale-artifact-prefix',
        severity: 'warn',
        message: '产物文件名前缀与基线不符（发布记录与下载链接会跟着变）。',
        evidence: `${facts.artifactName} 不以 ${context.artifactPrefix} 开头`,
      })
    }
  }

  if (facts.userDataPath !== undefined && name !== '' && facts.userDataPath.includes(name)) {
    // 上游注释点名的历史事故：userData 跟着应用名走，每次改名孤立一次配置。
    issues.push({
      code: 'userdata-follows-name',
      severity: 'error',
      message: 'userData 路径里出现了产品名：改名会生成新目录，把上一个配置孤立掉。',
      evidence: facts.userDataPath,
    })
  }

  for (const path of facts.resignedPaths ?? []) {
    const rule = presignedRuleOf(path)
    if (rule !== null) {
      issues.push({
        code: 'presigned-layer-touched',
        severity: 'error',
        message: `重签碰到了预签子树（${rule}）：原有签名被换掉，校验会失败。`,
        evidence: path,
      })
    }
  }

  for (const path of facts.unsignedPaths ?? []) {
    const rule = presignedRuleOf(path)
    issues.push({
      code: 'unsigned-layer',
      severity: rule === null ? 'error' : 'info',
      message: rule === null ? '这一层没有签名。' : `这一层未签，但它在预签子树里（${rule}），本不该由这次重签负责。`,
      evidence: path,
    })
  }

  if (facts.signature !== undefined && facts.signature.trim() !== '') {
    const verdict = judgeSignatureDetails(facts.signature, {
      signingIdentity: context.signingIdentity,
      teamId: context.teamId,
      runtime: false,
    })
    issues.push(...verdict.issues)
  }

  const sorted = [...issues].sort((left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity])
  const hasError = sorted.some(issue => issue.severity === 'error')
  if (hasError) return { verdict: 'fail', issues: sorted }
  if (name === '' && plist === undefined && facts.signature === undefined) {
    return { verdict: 'unverifiable', issues: sorted }
  }
  return { verdict: 'pass', issues: sorted }
}
