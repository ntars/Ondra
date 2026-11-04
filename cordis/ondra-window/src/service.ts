/**
 * 服务实现：把规格、分支、守卫三件事拼起来。**不创建窗口、不打补丁**。
 *
 * ## 为什么 `plan().applied` 的类型是字面量 `false`
 *
 * 一个 `boolean` 字段迟早会有人写成 `true`，然后界面显示「已应用」，而实际什么都没发生。
 * 写成 `false` 之后，任何想赋 `true` 的代码都过不了类型检查——**用类型把谎话钉死**，
 * 比在注释里写「请注意这里不要改」靠得住。
 *
 * ## 为什么 `spec()` 与 `verify()` 分开计数
 *
 * `spec()` 会被界面每帧调、被 `issues()` 调、被 `plan()` 调；`verify()` 要读文件。
 * 合成一个计数器后，「读了几次文件」这个数字就没有意义了，而这个数字正是
 * 「有没有人在热路径上读文件」的唯一证据。
 */

import { BRANCH_A } from './branch-a.js'
import { BRANCH_B } from './branch-b.js'
import { judgePatch, PATCH_MARKER } from './guard.js'
import { baseSpecOf, branchOf, hasBlockingIssue, platformOf, specIssues } from './spec.js'
import type { Config } from './settings.js'
import type {
  LogLike,
  PatchPlan,
  PatchVerdict,
  SpecIssue,
  TextReader,
  WindowBranchId,
  WindowReason,
  WindowService,
  WindowSpec,
  WindowStats,
} from './types.js'

/** 依赖。 */
export interface WindowDeps {
  settings: () => Config
  log: LogLike
  /** `process.platform` 的取值（注入以便对拍）。 */
  platform: () => string
  /** 读文本（默认本地文件）。 */
  reader: TextReader
}

/** 服务实现。 */
export class WindowVault implements WindowService {
  readonly #deps: WindowDeps
  readonly #counts = { specs: 0, plans: 0, verifies: 0 }
  #disposed = false
  #warnedUnsupported = false

  /**
   * @param deps 依赖。
   */
  constructor(deps: WindowDeps) {
    this.#deps = deps
  }

  /** 只要没卸载，规格就能给（窗口能不能真开，是壳侧的事）。 */
  get available(): boolean {
    return !this.#disposed
  }

  /** 不可用的原因。 */
  get reason(): WindowReason | undefined {
    if (this.#disposed) return 'disposed'
    if (!this.#deps.settings().enable) return 'disabled'
    return undefined
  }

  /**
   * 当前生效的窗口规格。
   *
   * 分支 B 在非 macOS 上**明确拒绝**并退回 A：自绘红绿灯是 macOS 概念，
   * 在别的平台上跑它只会得到「没有按钮的窗口」。
   */
  spec(): WindowSpec {
    this.#counts.specs += 1
    return this.#build().spec
  }

  /** 规格自洽检查。 */
  issues(): readonly SpecIssue[] {
    return specIssues(this.#build().spec)
  }

  /** 全部分支 id（固定 A、B 两支，不动态注册）。 */
  branches(): readonly WindowBranchId[] {
    return Object.freeze(['a', 'b'] as const)
  }

  /**
   * 补丁计划：壳侧照着做的那一份。
   *
   * `detail` 里会带上守卫结论——因为「计划」与「能不能生效」是同一个问题的两面，
   * 分两处看一定会有人只看其中一处。
   */
  plan(): PatchPlan {
    this.#counts.plans += 1
    const settings = this.#deps.settings()
    const expected = parseVersions(settings.expectedVersions)
    const verdict = this.#judge()
    const reason: WindowReason = settings.enable ? verdict.reason : 'disabled'
    const detail = settings.enable
      ? verdict.findings.join('；')
      : '窗口规格关着（`enable=false`）：只出规格，不出计划'

    return Object.freeze({
      target: settings.patchTarget,
      marker: PATCH_MARKER,
      expected,
      applied: false,
      reason,
      detail,
    })
  }

  /** 版本边界判定。 */
  verify(): PatchVerdict {
    this.#counts.verifies += 1
    return this.#judge()
  }

  /** 计数快照。 */
  stats(): WindowStats {
    return Object.freeze({ ...this.#counts })
  }

  /** 卸载：只清引用，没有句柄、没有定时器。 */
  dispose(): void {
    this.#disposed = true
  }

  /**
   * 造规格（不计数）。
   */
  #build(): { readonly spec: WindowSpec; readonly reason?: WindowReason } {
    const settings = this.#deps.settings()
    const platform = platformOf(settings.platform, this.#deps.platform())
    let branch = branchOf(settings.branch)
    let reason: WindowReason | undefined

    if (branch === 'b' && platform !== 'macos') {
      if (!this.#warnedUnsupported) {
        this.#warnedUnsupported = true
        this.#deps.log.warn(
          '方案 B（自绘红绿灯）只在 macOS 有意义，本机是 %s：已退回方案 A，不改你的配置',
          platform,
        )
      }
      branch = 'a'
      reason = 'unsupported-platform'
    }

    const base = baseSpecOf(platform)
    const spec = (branch === 'b' ? BRANCH_B : BRANCH_A).specOf(base)
    const issues = specIssues(spec)
    if (hasBlockingIssue(issues)) {
      // 算错了（拖动区比标题区高、栏宽之和对不上）：如实报，但**不抛**——
      // 抛出去会让整个窗口插件在 `apply()` 阶段就挂掉，界面连「哪里算错了」都看不到。
      this.#deps.log.error(
        '窗口规格自洽检查不过：%s',
        issues.filter(issue => issue.severity === 'error').map(issue => issue.message).join('；'),
      )
    }
    return reason === undefined ? { spec } : { spec, reason }
  }

  /**
   * 判定补丁（不计数）。
   */
  #judge(): PatchVerdict {
    const settings = this.#deps.settings()
    const target = settings.patchTarget
    const text = target === '' ? null : this.#deps.reader.read(target)
    return judgePatch({
      targetGiven: target !== '',
      readable: text !== null,
      text: text ?? '',
      expected: parseVersions(settings.expectedVersions),
    })
  }
}

/**
 * 把配置里的版本串拆成清单。
 *
 * 认逗号、空格、分号三种分隔：人在不同场合写法不一样，而这里多认一种分隔的成本是 0。
 * @param text 配置值。
 */
export function parseVersions(text: string): readonly string[] {
  return Object.freeze(
    text
      .split(/[\s,;]+/)
      .map(item => item.trim())
      .filter(item => item !== ''),
  )
}
