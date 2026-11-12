/**
 * `check:filter` —— 删句链必须保住段落。
 *
 * ## 这条网锁的是什么
 *
 * `ondra-filter-chain` 的九步里有七步是「删整句」，它们的共同实现是
 * `splitSentences()` → 逐句判 → `joinSentences()` 拼回。而 `\n` 是这个
 * 文件认的句末标点之一：只要拼接时把换行丢掉，**模型写好的分段就会在
 * 删掉任意一句之后整段被压平**。
 *
 * 第 13 轮实测到的症状：三段回复（硬盘 / 雨 / 旁白）在界面上粘成一整行，
 * 读起来是「…出门只有屏幕。雨我看得见，听不见」这种半截话。原始流里
 * 明明有 `\n\n`，`done` 里没有——中间只差这一条链。
 *
 * ## 为什么判据是「逐字节相等」而不是「还看得出来是两段」
 *
 * 保段落的实现方式有很多种（补一个 `\n`、补两个、把段落拆成数组）。
 * 只要允许「差不多」，就总有一种实现能凑出绿，然后在某个边角（引号内、
 * 段首、连续删三句）上漏掉。所以这里钉两条硬判据：
 *
 * 1. **无删改时往返必须逐字节等于原文**（`split → join === 原文`）；
 * 2. **删句后，剩余段落之间的空行必须还在**，且不多不少正好两个换行。
 *
 * 反向验证做过：把 `splitSentences()` 的 `gap` 改成恒 `''`，本脚本红 8 条
 * （A 段 5、B 段 3），红出来的正是线上那个症状——「硬盘转得挺稳。好的，
 * 以下是三点说明。雨还在下。」三句粘成一行。
 *
 * 用法：node tools/check-filter.mjs
 * 退出码：全部通过为 0。
 */

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const SRC = join(ROOT, 'cordis-host', 'plugins', 'ondra-filter-chain', 'src', 'text.ts')
const LIB_TEXT = join(ROOT, 'cordis-host', 'plugins', 'ondra-filter-chain', 'lib', 'text.js')
const LIB_PASSES = join(ROOT, 'cordis-host', 'plugins', 'ondra-filter-chain', 'lib', 'passes.js')

const failures = []
function check(label, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : `（${detail}）`}`)
  if (!ok) failures.push(label)
}

/* ---------------------------------------------------------------- *
 * 前置闸门：产物必须新于源码
 * ---------------------------------------------------------------- */

console.log('=== 前置闸门 · 产物新鲜度 ===')
if (!existsSync(LIB_TEXT) || !existsSync(LIB_PASSES)) {
  console.log('  ✗ 产物不存在。先执行：pnpm run build:plugins')
  process.exit(1)
}
const lag = statSync(SRC).mtimeMs - statSync(LIB_TEXT).mtimeMs
check('产物新于源码', lag <= 2000, `源码超前 ${String(Math.round(lag))} ms`)
if (failures.length > 0) {
  console.log('\n产物过期，结论不可信。先执行：pnpm run build:plugins')
  process.exit(1)
}

const { splitSentences, joinSentences } = await import(LIB_TEXT)
const { PASSES } = await import(LIB_PASSES)

/* ---------------------------------------------------------------- *
 * A 段 · 不删改时往返逐字节一致
 * ---------------------------------------------------------------- */

console.log('\n=== A 段 · 分句再拼回必须与原文逐字节相同 ===')

const ROUND_TRIP = [
  ['三段正文', '硬盘转得挺稳。\n\n好的，以下是三点说明。\n\n雨还在下。'],
  ['单换行', '第一句。\n第二句。'],
  ['引号内含句号', '他说「先这样。明天再说」。\n\n然后走了。'],
  ['无句末标点的尾巴', '一段话。\n\n没有标点的尾巴'],
]

for (const [name, text] of ROUND_TRIP) {
  const sentences = splitSentences(text)
  const back = joinSentences(sentences.map(sentence => sentence.text + sentence.gap))
  check(`${name}：往返一致`, back === text, back === text ? `${String(sentences.length)} 句` : JSON.stringify(back))
}

/*
 * 整段**开头**的空白是有意裁掉的（旧行为，一直如此）：模型偶尔用缩进
 * 排版，那是 Markdown 的习惯，不是她要说的字。这一条不判「保住」，
 * 判「只裁开头、不裁段间」——真正会造成视觉事故的是后者。
 */
const indented = '  缩进开头的一句。\n\n第二段。'
const indentedBack = joinSentences(splitSentences(indented).map(sentence => sentence.text + sentence.gap))
check(
  '段首空白照旧裁掉，但段间空行保住',
  indentedBack === '缩进开头的一句。\n\n第二段。',
  JSON.stringify(indentedBack),
)

/* ---------------------------------------------------------------- *
 * B 段 · 删掉一句之后段落必须还在
 * ---------------------------------------------------------------- */

console.log('\n=== B 段 · 删句之后段落间隔必须保住 ===')

/** `strip-draft` 只认这一处规矩，env 只需能被读到的那几个字段。 */
const env = { settings: { repeatNgram: 4, repeatThreshold: 0.8, repeatRecentCount: 3 }, recent: [] }

const DELETIONS = [
  [
    '删掉整段唯一一句',
    '硬盘转得挺稳。\n\n好的，以下是三点说明。\n\n雨还在下。',
    '硬盘转得挺稳。\n\n雨还在下。',
  ],
  [
    '删掉同段中间那句',
    '硬盘转得挺稳。好的，以下是三点说明。\n\n雨还在下。',
    '硬盘转得挺稳。\n\n雨还在下。',
  ],
  [
    '删掉开头那一句',
    '好的，以下是三点说明。\n\n雨还在下。',
    '雨还在下。',
  ],
]

for (const [name, source, expected] of DELETIONS) {
  const out = PASSES['strip-draft'](source, env)
  check(`${name}：删了 1 句`, out.removed === 1, `removed=${String(out.removed)}`)
  check(`${name}：结果与预期逐字节相同`, out.text === expected, JSON.stringify(out.text))
}

/* 段数守恒单独再钉一条：两段进、两段出。 */
const twoParagraphs = PASSES['strip-draft'](DELETIONS[0][1], env).text
check(
  '两段进两段出（`\\n\\n` 恰好一处）',
  (twoParagraphs.match(/\n\n/g) ?? []).length === 1 && !/\n{3,}/.test(twoParagraphs),
  JSON.stringify(twoParagraphs),
)

console.log('')
if (failures.length === 0) {
  console.log('全部通过。')
} else {
  console.log(`${String(failures.length)} 条未通过：`)
  for (const item of failures) console.log(`  - ${item}`)
}
process.exit(failures.length === 0 ? 0 : 1)
