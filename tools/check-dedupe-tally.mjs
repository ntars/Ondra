/**
 * 判重计数栏位：五个动作必须各对各的标签。
 *
 * ## 这个脚本要证明的一件事
 *
 * `ondra-memory-intake` 里那行「判重裁决：新建 N · 合并 N · 灰区未写库 N ·
 * 复述 N · 冲突 N」的五个数字，必须分别来自五个**不同的**动作：
 *
 * ```
 * 栏位          动作（judge.ts 的 action）
 * 新建          add     （含 conflict 的写入分支）
 * 合并          merge   （改写主条，旧正文进 oldText）
 * 灰区未写库    append  （只 reinforce，不写库）
 * 复述          drop    （只 reinforce，不写库）
 * 冲突          conflict
 * ```
 *
 * ## 为什么需要这个脚本（它测的是一个真缺陷）
 *
 * 改之前那行日志是「新建 · 合并 · **复述** · **丢弃** · 冲突」，参数依次传
 * `tally.append` / `tally.drop`。也就是说：
 *
 * - `append`（灰区、**不写库**）被印成「复述」；
 * - `drop`（真复述）被印成「丢弃」。
 *
 * 这不是措辞问题。实机取证（2026-11-13）：
 *
 * ```
 * 用户：记一下：我的备用钥匙放在玄关鞋柜最上层，编号 K-9
 * 日志：判重裁决：新建 0 · 合并 0 · 复述 1 · 丢弃 0 · 冲突 0
 * 日志：提炼返回：ok=true written=0
 * 库：  memory_fact 里仍只有「第二层」那一条
 * ```
 *
 * 排查者读到「复述 1」，结论必然是「已经记过了」——而用户的原话是纠正：
 * 第二层 → 最上层，还带了新编号 K-9。**一句话都没进去，日志却完全自洽。**
 *
 * 全库统计（同一时刻）：`append` 16 条、`written` 全为 0；其中还有
 * 「用户让玖玖记住暗号『青柚第七码』」这种**明确要求记住**的内容。
 *
 * ## 为什么判据是「栏位数 = 动作数」而不是「标签含某几个字」
 *
 * 标签会随措辞改。真正的约束是**一对一**：五个 `%d`，五个来源，
 * 来源必须覆盖 add/merge/append/drop/conflict 各一次。若有人加第六栏
 * 却复用同一个 tally 字段，一对一就断了。
 *
 * 用法：node tools/check-dedupe-tally.mjs
 * 退出码：全部通过为 0。
 */

import { readFileSync } from 'node:fs'

const SOURCE = new URL('../cordis-host/plugins/ondra-memory-intake/src/index.ts', import.meta.url).pathname

const failures = []
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${label}${detail === undefined ? '' : `（${detail}）`}`)
  } else {
    console.log(`  ✗ ${label}${detail === undefined ? '' : `（${detail}）`}`)
    failures.push(label)
  }
}

console.log('=== 判重计数栏位 · 五个动作各对各的标签 ===')

const source = readFileSync(SOURCE, 'utf8')

/*
 * 切出那条日志语句本身。
 *
 * 用「判重裁决：」定位到 `log.info?.(` 开头，再取到配对的 `)`。
 * 不做通用括号解析：这段代码形态固定，多写一堆状态机只会让脚本更难读。
 */
const marker = '判重裁决：'
const at = source.indexOf(marker)
check('源码里有「判重裁决」这行日志', at > 0)

if (at > 0) {
  // 往前找到这次调用的起点
  const callStart = source.lastIndexOf('log.info?.(', at)
  check('这行日志走的是 log.info?.()', callStart > 0)

  // 从起点取到这次调用的结束括号（格式稳定：多行调用，末行是 `)`）
  const tail = source.slice(callStart, at + 400)
  const callEnd = tail.indexOf('\n      )')
  const call = callEnd > 0 ? tail.slice(0, callEnd) : tail
  check('取到了完整的调用片段', call.includes('判重裁决：'))

  // 1. 格式串里有五个 %d
  const formatMatch = call.match(/判重裁决：([^']*)'/)
  const format = formatMatch?.[1] ?? ''
  const placeholders = (format.match(/%d/gu) ?? []).length
  check('格式串里有 5 个 %d', placeholders === 5, `查到 ${String(placeholders)} 个`)

  // 2. 栏位名不能把「灰区未写库」与「复述」搅在一起
  /* 先剥掉 `%d` 再切 `·`：格式串是「新建 %d · 合并 %d · …」，
   * `%d` 属于占位符而不是栏名的一部分。 */
  const labels = format.replace(/%d/gu, '').split('·').map(part => part.trim()).filter(part => part !== '')
  check('栏位数是 5', labels.length === 5, labels.join(' | '))
  check('有一栏明说「未写库」（灰区 append 的真实后果）',
    labels.some(label => label.includes('未写库')),
    labels.join(' | '))
  check('有一栏叫「复述」', labels.some(label => label === '复述'), labels.join(' | '))
  check('不存在「丢弃」这一栏（没有对应动作，drop 就是复述）',
    !labels.some(label => label.includes('丢弃')),
    labels.join(' | '))

  /* 3. 五个实参必须覆盖五个不同的动作。
   *
   * 只从**格式串之后**取，否则会把 `tally` 的初始化或上一行的取值带进来。
   * 第一栏是 `tally.add + tally.conflict`（冲突策略下也会新建一条），
   * 故它是唯一允许出现两个字段的一栏——按「每个实参行」切，不按字段数切。 */
  const argsPart = call.slice(call.indexOf('判重裁决'))
  const argLines = argsPart.split('\n').slice(1).join('\n')
  const argRows = argLines
    .split('\n')
    .map(line => line.trim().replace(/,$/u, ''))
    .filter(line => line.startsWith('tally.'))
  check('实参是 5 行', argRows.length === 5, argRows.join(' | '))

  /* 把每行归一成「它读了哪些 tally 字段」。 */
  const argFields = argRows.map(row => [...row.matchAll(/tally\.(\w+)/gu)].map(match => match[1]))
  const flatFields = argFields.flat()
  check('实参覆盖 add / merge / append / drop / conflict 全部五种',
    ['add', 'merge', 'append', 'drop', 'conflict'].every(action => flatFields.includes(action)),
    flatFields.join(', '))

  /*
   * 4. 「灰区未写库」这一栏必须由 `append` 供数（顺序对位，不是靠名字猜）。
   *
   * 这是本脚本的核心：标签写对了、动作也在，但**串了位**照样是错——
   * 改之前正是「复述」那一栏收了 `append` 的数。
   */
  const labelsToArgs = labels.map((label, index) => ({ label, fields: argFields[index] ?? [] }))
  const greySlot = labelsToArgs.find(item => item.label.includes('未写库'))
  const repeatSlot = labelsToArgs.find(item => item.label === '复述')
  check('「灰区未写库」那一栏收的是 append', greySlot?.fields.includes('append') === true, (greySlot?.fields ?? []).join(', '))
  check('「复述」那一栏收的是 drop', repeatSlot?.fields.includes('drop') === true, (repeatSlot?.fields ?? []).join(', '))
  /* 反向：这两栏不能互相串位。 */
  check('「灰区未写库」那一栏不读 drop', greySlot?.fields.includes('drop') !== true, (greySlot?.fields ?? []).join(', '))
  check('「复述」那一栏不读 append', repeatSlot?.fields.includes('append') !== true, (repeatSlot?.fields ?? []).join(', '))
}

/*
 * 5. 动作语义的另一半：`append` 在落库层确实「只加固、不写库」。
 *
 * 上面几条只保证日志说了真话。这一条保证「真话本身是什么」——
 * 否则哪天 `append` 改成写库了，日志会从「说错」变成「说过时」。
 */
const SERVICE = new URL('../cordis-host/plugins/ondra-memory-dedupe/src/service.ts', import.meta.url).pathname
const service = readFileSync(SERVICE, 'utf8')
const appendCase = service.match(/case 'append': \{([\s\S]*?)break\n\s*\}/u)?.[1] ?? ''
check('落库层取到了 append 分支', appendCase !== '')
check('append 只调 reinforce（不写库）',
  appendCase.includes('reinforce') && !appendCase.includes('this.write('),
  appendCase.replace(/\s+/gu, ' ').trim().slice(0, 70))

console.log('')
if (failures.length === 0) {
  console.log('全部通过。')
  process.exit(0)
}
console.log(`失败 ${String(failures.length)} 条：`)
for (const item of failures) console.log(`  - ${item}`)
process.exit(1)
