/**
 * 版本边界守卫：**纯判定，不碰文件、不碰进程**。
 *
 * ## 为什么这条是手册点名的病
 *
 * 手册 §4.3 原文：「APK 做法是 monkey-patch 前做**版本白名单**，上游升级则补丁
 * **不生效**而非**错生效**；新项目 `patch-host.sh` 存在但**没有任何
 * `PATCH_EXPECT_DSH_VERSIONS`**。」——并直接点了 `ondra-window` 的名。
 *
 * 这条要求的技术含义很具体：
 *
 * - **白名单**：不是「版本 ≥ 33 就行」，而是「我验证过的版本清单」；
 * - **不生效**：版本不在清单里，补丁**跳过**，壳照常启动、只是没有自定义标题栏；
 * - **错生效**：补丁照打，但内部假设已经变了——表现是标题栏错位、红绿灯叠在
 *   内容上、或者拖动区盖住按钮，**而且不会报错**。
 *
 * 「不生效」与「错生效」的差别，就是「少一个功能」与「界面坏掉且查不出来」的差别。
 *
 * ## 为什么「没写期望版本」判 `unverifiable` 而不是 `pass`
 *
 * 配置没给白名单 = 我不知道你验证过哪些版本。这时候判过，等于把「没声明」当成
 * 「全版本都验证过」——那正是这条守卫要防的事。判不了就说判不了，
 * 与 O-077 / O-079 的四值判定同一条纪律。
 */

import type { PatchVerdict, WindowReason } from './types.js'

/**
 * 白名单环境变量名。
 *
 * 沿用旧项目的命名习惯（`PATCH_EXPECT_*`），只把对象换成 Electron：
 * 本包要 guard 的是壳侧补丁，不是 DSH 内核补丁。
 */
export const PATCH_MARKER = 'PATCH_EXPECT_ELECTRON'

/** 抓 `PATCH_EXPECT_ELECTRON = "33 34"` 三种引号形态。 */
const MARKER_RE = /PATCH_EXPECT_ELECTRON\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s#;]+))/

/**
 * 从补丁文件正文里抽出白名单。
 *
 * 三种写法都认（双引号 / 单引号 / 裸值），因为壳侧脚本可能是 sh、可能是 PowerShell，
 * 引号习惯不同。抽不到就返回空数组——**空数组不是「全版本」**，`judgePatch` 会判不过。
 * @param text 文件正文。
 */
export function parseExpectations(text: string): readonly string[] {
  const matched = MARKER_RE.exec(text)
  if (matched === null) return []
  const raw = matched[1] ?? matched[2] ?? matched[3] ?? ''
  return Object.freeze(
    raw
      .split(/[\s,]+/)
      .map(item => item.trim())
      .filter(item => item !== ''),
  )
}

/**
 * 版本是否匹配（宽松匹配：按点分段的前缀）。
 *
 * 为什么不做完整 SemVer：Electron 的版本是 `33.4.11`，而人写白名单时习惯写
 * `33` 或 `33.4`。要求写全三位，实际结果是没人写，白名单永远是空的。
 * 反过来只比第一段又太松（`33` 会匹配 `33.9` 与 `33.0`，两个大版本的 ABI 可能不同）——
 * 所以按「写了多长就比多长」：`33` 只比第一段，`33.4` 比前两段。
 * @param got 实际版本。
 * @param want 白名单里的一项。
 */
export function matchesVersion(got: string, want: string): boolean {
  const left = got.trim().split('.')
  const right = want.trim().split('.')
  if (right.length > left.length) return false
  for (let index = 0; index < right.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/** 判定输入。 */
export interface PatchInput {
  /** 配置里给没给补丁路径。 */
  readonly targetGiven: boolean
  /** 读到的正文；读不到为空串。 */
  readonly text: string
  /** 读成功没有。 */
  readonly readable: boolean
  /** 配置里的白名单。 */
  readonly expected: readonly string[]
}

/**
 * 判定补丁能不能生效。
 *
 * 顺序刻意是「先看有没有文件 → 再看有没有白名单标记 → 再看版本对不对」：
 * 反过来的坏处是，一个不存在的文件会先被报成「版本不匹配」，人就去改版本号了。
 * @param input 判定输入。
 */
export function judgePatch(input: PatchInput): PatchVerdict {
  if (!input.targetGiven) {
    return freeze('unverifiable', 'no-patch-target', [
      '配置里 `patchTarget` 为空：不知道壳侧补丁在哪，判不了',
    ])
  }
  if (!input.readable) {
    return freeze('fail', 'patch-unreadable', [`补丁文件读不到：${PATCH_MARKER} 无从检查`])
  }

  const found = parseExpectations(input.text)
  if (found.length === 0) {
    return freeze('fail', 'patch-marker-missing', [
      `补丁里没有 \`${PATCH_MARKER}=\`：这正是手册 §4.3 点名的旧病`,
      '加上一行（例：`PATCH_EXPECT_ELECTRON="33 34"`），否则上游升级后补丁会「错生效」',
    ])
  }

  if (input.expected.length === 0) {
    return freeze('unverifiable', 'no-expected-version', [
      `补丁里声明了 ${found.join(' / ')}，但配置没给期望版本：不知道你验证过哪些，判不了`,
      '在 `expectedVersions` 里写明验证过的版本（例：`33,34`）',
    ])
  }

  const matched = found.filter(version => input.expected.some(want => matchesVersion(version, want)))
  if (matched.length === 0) {
    return freeze('fail', 'version-unexpected', [
      `补丁声明的版本 ${found.join(' / ')} 与期望的 ${input.expected.join(' / ')} 对不上`,
      '补丁**不生效**（壳照常启动、只是没有自定义标题栏），这是刻意的：错生效比不生效坏得多',
    ])
  }

  return freeze('pass', 'ok', [`版本对得上：${matched.join(' / ')}`])
}

/**
 * 冻结一份结论。
 * @param verdict 总判。
 * @param reason 原因码。
 * @param findings 逐条发现。
 */
function freeze(verdict: 'pass' | 'fail' | 'unverifiable', reason: WindowReason, findings: readonly string[]): PatchVerdict {
  return Object.freeze({ verdict, reason, findings: Object.freeze([...findings]) })
}
