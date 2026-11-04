/**
 * 服务实现：把规格、计划、审计、签名判定收成一个对象。
 *
 * ## 为什么它没有文件句柄、没有定时器、没有写入
 *
 * 这一层全是纯函数的外壳。持有句柄的插件（进程、窗口、存储）需要 `dispose()` 做真清理；
 * 本包 `dispose()` 只清引用并翻一个标志位，所以它**不可能**在卸载后还留下副作用。
 * 这是「关掉我，只有我自己受影响」这条隔离要求的实现方式：不是靠自觉，是靠没有东西可留。
 */

import { auditBundle, judgeSignatureDetails } from './audit.js'
import { planBuilder } from './branch-builder.js'
import { planManual } from './branch-manual.js'
import { isReverseDns } from './settings.js'
import type { Config } from './settings.js'
import { rebrandSpec } from './spec.js'
import type {
  BundleFacts,
  LogLike,
  RebrandAudit,
  RebrandPlan,
  RebrandReason,
  RebrandService,
  RebrandSpec,
  RebrandStats,
  SignatureExpectation,
  SignatureVerdict,
} from './types.js'

/** 服务依赖。全部注入，便于离线对拍。 */
export interface RebrandDeps {
  /** 取当前生效配置。 */
  readonly settings: () => Config
  /** 日志。 */
  readonly log: LogLike
}

/** 计划为空时的原因说明。 */
const REASON_TEXT: Readonly<Record<RebrandReason, string>> = Object.freeze({
  ok: '没有缺口，照步骤做即可。',
  disabled: '开关关着：`plan()` 不产步骤，`spec()` / `audit()` 仍可用。',
  disposed: '插件已卸载。',
  'no-brand-name': '没声明新显示名。先给 `displayName`，本包不替你编名字。',
  'no-bundle-id': '没声明 bundle id：改名时无法核对「有没有顺手把 bundle id 改了」。',
  'bad-bundle-id': 'bundle id 不是 reverse-DNS 形状（上游 `resolveDesktopAppId` 同一条规则）。',
  'no-app-path': '`manual` 分支需要目标 `.app` 的绝对路径，否则命令里只有占位符。',
  'no-signing-identity': '没配证书限定名，签名身份判不了。',
  'no-team-id': '没配 Team ID，签名团队判不了。',
})

/** 品牌与重签服务。 */
export class RebrandVault implements RebrandService {
  readonly #settings: () => Config
  readonly #log: LogLike
  #disposed = false
  #specs = 0
  #plans = 0
  #audits = 0

  /**
   * @param deps 配置与日志。
   */
  constructor(deps: RebrandDeps) {
    this.#settings = deps.settings
    this.#log = deps.log
  }

  /** 是否可用（卸载后为 false）。 */
  get available(): boolean {
    return !this.#disposed
  }

  /** 不可用的原因。 */
  get reason(): RebrandReason | undefined {
    return this.#disposed ? 'disposed' : undefined
  }

  /**
   * 品牌规格全图（点位、层、不变量）。
   * @returns 只读快照。
   */
  spec(): RebrandSpec {
    this.#specs += 1
    return rebrandSpec()
  }

  /**
   * 编改名计划。
   * @returns 步骤与原因码；`applied` 恒 `false`。
   */
  plan(): RebrandPlan {
    this.#plans += 1
    const settings = this.#settings()
    const branch = settings.branch

    if (this.#disposed) {
      return { branch, steps: [], applied: false, reason: 'disposed', detail: REASON_TEXT.disposed }
    }
    if (!settings.enable) {
      return { branch, steps: [], applied: false, reason: 'disabled', detail: REASON_TEXT.disabled }
    }
    if (settings.displayName === '') {
      return {
        branch,
        steps: [
          {
            index: 1,
            kind: 'rename',
            title: '先声明新显示名',
            detail: '配置 `display-name`。本包不知道要改成什么，所以只给这一步——编一个名字写进代码，就是第二份产品名真源。',
            source: '手册',
          },
        ],
        applied: false,
        reason: 'no-brand-name',
        detail: REASON_TEXT['no-brand-name'],
      }
    }

    const steps = branch === 'manual' ? planManual(settings) : planBuilder(settings)
    const reason = this.#gapOf(settings)
    if (settings.verbose) {
      this.#log.info('改名计划：分支 %s，%d 步，原因码 %s', branch, steps.length, reason)
    }
    return { branch, steps, applied: false, reason, detail: REASON_TEXT[reason] }
  }

  /**
   * 审计一份包事实。
   * @param facts 观察事实。
   */
  audit(facts: BundleFacts): RebrandAudit {
    this.#audits += 1
    const settings = this.#settings()
    const result = auditBundle(facts, {
      displayName: settings.displayName,
      bundleId: settings.bundleId,
      scheme: settings.scheme,
      artifactPrefix: settings.artifactPrefix,
      signingIdentity: settings.signingIdentity,
      teamId: settings.teamId,
    })
    if (settings.verbose) {
      this.#log.info('改名审计：%s，%d 条问题', result.verdict, result.issues.length)
    }
    return result
  }

  /**
   * 判一段签名输出。不传 `expected` 时用配置里的身份。
   * @param details `codesign --display --verbose=4` 原文。
   * @param expected 期望身份（可覆盖配置）。
   */
  judgeSignature(details: string, expected?: SignatureExpectation): SignatureVerdict {
    const settings = this.#settings()
    return judgeSignatureDetails(
      details,
      expected ?? {
        signingIdentity: settings.signingIdentity,
        teamId: settings.teamId,
        runtime: true,
      },
    )
  }

  /** 计数。 */
  stats(): RebrandStats {
    return { specs: this.#specs, plans: this.#plans, audits: this.#audits }
  }

  /** 卸载：只翻标志位。 */
  dispose(): void {
    this.#disposed = true
  }

  /**
   * 找出计划里第一个缺口。
   *
   * 只报第一个：一次列五条缺口，人会挑最容易的那条改，然后以为改完了。
   * @param settings 生效配置。
   */
  #gapOf(settings: Config): RebrandReason {
    if (settings.bundleId !== '' && !isReverseDns(settings.bundleId)) return 'bad-bundle-id'
    if (settings.bundleId === '') return 'no-bundle-id'
    if (settings.branch === 'manual' && settings.appPath === '') return 'no-app-path'
    if (settings.signingIdentity === '') return 'no-signing-identity'
    if (settings.teamId === '') return 'no-team-id'
    return 'ok'
  }
}
