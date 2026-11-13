/**
 * 手机端与桌面版的算法一致性检查。
 *
 * ## 为什么需要这条检查
 *
 * 手机端跑不了 Node 宿主，所以情绪与记忆的**纯算法**是逐字复制过来的
 * （`src/lib/local/emotionPad.ts` ← `ondra-emotion-core/src/pad.ts`，
 * `src/lib/local/memoryStability.ts` ← `ondra-memory-core/src/stability.ts`）。
 *
 * 复制之后两份会各自演化：有人在桌面版调了半衰期，忘了同步手机端，
 * 于是同一条「明天要交房租」在两台设备上活得不一样久。用户遇到的
 * 不是"略有差异"，而是「她的记忆在手机上不准」。
 *
 * 所以这里逐行比对：**去掉 import 行与文件头注释后，两份必须完全相同**。
 *
 * ## 为什么允许 import 行不同
 *
 * 手机端的类型定义是精简版（`emotionTypes.ts` 只有算法用到的三个声明），
 * 路径自然不同。除此之外的任何差异都是漂移。
 *
 * ## 运行
 *
 * ```
 * node tools/check-local-parity.mjs
 * ```
 *
 * 退出码 0 表示一致，1 表示有漂移（并打印第一处不同的行号与内容）。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

/** 一对需要比对的文件。 */
const PAIRS = [
  {
    name: '情绪 PAD 算法',
    desktop: 'cordis-host/plugins/ondra-emotion-core/src/pad.ts',
    mobile: 'src/lib/local/emotionPad.ts',
  },
  {
    name: '记忆稳定性算法',
    desktop: 'cordis-host/plugins/ondra-memory-core/src/stability.ts',
    mobile: 'src/lib/local/memoryStability.ts',
  },
]

/**
 * 把源码压成可比较的行序列。
 *
 * 去掉四类东西：
 * 1. **文件头注释块**（`/**` 到 `*\/` 的第一段）——手机端在这里加了一段
 *    「这份文件是从桌面版复制的」说明，那是刻意的元信息，不是算法；
 * 2. `import` 行（路径必然不同）；
 * 3. 空行（格式化差异没有意义）；
 * 4. 行尾空白。
 *
 * **其余注释保留**——函数上的注释写着公式的推导与取舍理由，两边不一致
 * 说明有人只改了一边的文档，那同样是漂移的信号。
 */
function normalize(source) {
  const lines = source.split('\n')

  /* 跳过文件头注释块：从第一个 `/**` 开始，到它对应的 `*\/` 结束。 */
  let start = 0
  const headerStart = lines.findIndex((line) => line.trim().startsWith('/**'))
  if (headerStart !== -1) {
    const headerEnd = lines.findIndex((line, index) => index > headerStart && line.trim().endsWith('*/'))
    if (headerEnd !== -1) start = headerEnd + 1
  }

  return lines
    .slice(start)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .filter((line) => !/^import\b/.test(line.trim()))
}

/**
 * 找第一处不同。
 *
 * @returns 相同返回 undefined；不同返回 `{ index, desktop, mobile }`。
 */
function firstDiff(desktopLines, mobileLines) {
  const limit = Math.max(desktopLines.length, mobileLines.length)
  for (let i = 0; i < limit; i += 1) {
    const left = desktopLines[i]
    const right = mobileLines[i]
    if (left !== right) {
      return { index: i, desktop: left ?? '(文件结束)', mobile: right ?? '(文件结束)' }
    }
  }
  return undefined
}

let failed = 0

for (const pair of PAIRS) {
  const desktopLines = normalize(readFileSync(join(repoRoot, pair.desktop), 'utf8'))
  const mobileLines = normalize(readFileSync(join(repoRoot, pair.mobile), 'utf8'))
  const diff = firstDiff(desktopLines, mobileLines)

  if (diff === undefined) {
    console.log(`✓ ${pair.name}：两份完全一致（${String(desktopLines.length)} 行）`)
    continue
  }

  failed += 1
  console.log(`✗ ${pair.name}：第 ${String(diff.index + 1)} 行起不一致`)
  console.log(`    桌面版：${diff.desktop.slice(0, 100)}`)
  console.log(`    手机端：${diff.mobile.slice(0, 100)}`)
  console.log(`    → 改一处必须同步另一处：${pair.desktop} ↔ ${pair.mobile}`)
}

if (failed > 0) {
  console.log(`\n${String(failed)} 组算法已漂移。手机端与桌面版必须算出同一个数。`)
  process.exitCode = 1
} else {
  console.log('\n全部一致。')
}