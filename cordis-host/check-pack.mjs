/**
 * 人格装箱（`pack()`）的纯函数核对。
 *
 * ## 为什么要有这个脚本
 *
 * `pack()` 是全仓唯一一处决定「哪几段人格进得去提示词」的代码，而它**没有任何
 * 检查覆盖**——`check-system-prompt` 只看最终产出非空，`check-host-persona` 只看
 * 送到了供应商。两者都抓不到「少了一整段人格但产出仍非空」这种退化。
 *
 * 这正是 2026-11-08 第二十段发现的那个形态：默认预算 2600 下「说话」段整段掉，
 * 而三处装配代码全都不报错，只有一行 stderr。
 *
 * ## 这个脚本钉住哪四件事
 *
 * | 断言组 | 防的是什么 |
 * | --- | --- |
 * | 边界层豁免 | 「保护红线」被误改成「优先级最高」，从而把内核挤空 |
 * | 不切字 | 有人为了塞更多内容去 `slice()` 正文（切半句仍通顺，最难发现） |
 * | 段级倒置 | 修饰内核的关系段在内核不在时单独留着（那句话没有指代对象） |
 * | 账目自洽 | 报了超预算却算不对账、或没超却报超 |
 *
 * 另有一条**针对默认值**的断言：默认预算下必须零丢弃，且「说话」段在场。
 * 它钉的是本轮真正修掉的那个产品残缺（默认 2600 → 12000）。
 *
 * ## 为什么不钉「预算变大时保留件数单调」
 *
 * 「装不下就跳过继续试」这条规则的**固有性质**就是件数非单调：三个假单元
 * {140, 60, 60} 在预算 120 下装两件小的（120 字），在预算 150 下只装那件大的
 * （140 字）——件数从 2 掉到 1，而占用字符数仍然增加。手册 §2.6 明确要这条规则
 * （「短而关键的段落不该被长段落挤掉」），所以**件数非单调是设计，不是缺陷**。
 *
 * 这一点踩过坑：第一版这里钉了「预算每加 100 字，件数掉不超过 2 个」，一跑就红
 * （3600 → 3650 掉 4 件）。查清后确认红的是断言。后来还顺着这个红去改过 `pack()`
 * 的实现（试过「取最好的一轮」「固定预留标题额度」两版），全区间逐档对比的结论是
 * **净效果为负**（197 档里 12 档更差、3 档更优），已整段撤销——那段改动没有证据
 * 支撑，留着就是给下一个读代码的人埋一个假的「这里修过 bug」。
 *
 * 所以这里只钉**数学上必然成立**的那条：占用字符数不减。
 *
 * 用法：node cordis-host/check-pack.mjs
 * 退出码：全部通过为 0。
 */

import { Context } from '@ntars/cordis'
import { rm } from 'node:fs/promises'
import { loadCore } from './plugins/ondra-core/lib/index.js'
import { pack } from './plugins/ondra-persona-assemble/lib/sections.js'

const failures = []
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${label}${detail === undefined ? '' : `（${detail}）`}`)
  } else {
    console.log(`  ✗ ${label}${detail === undefined ? '' : `（${detail}）`}`)
    failures.push(label)
  }
}

/** 造一个非豁免单元。 */
function unit(id, chars, priority, section = 'kernel', order = 0) {
  return { id, section, label: id, priority, order, text: '字'.repeat(chars), chars, exempt: false }
}

/** 取一轮结果里全部单元的 id（按段顺序展开）。 */
function keptIds(result) {
  return [...result.kept.values()].flat().map(item => item.id)
}

console.log('=== 人格装箱 · 纯函数核对 ===')

/* ---------------------------------------------------------------- *
 * 1. 边界层整层豁免
 * ---------------------------------------------------------------- */

console.log('\n--- 1. 边界层整层豁免 ---')
/*
 * 这是本插件最容易被人「顺手优化掉」的一条。把边界层当成「优先级最高的候选」
 * 听起来很合理（红线最重要嘛），后果却是 1481 字的红线先扣掉额度，
 * 5873 字的内核只剩一千多字——**用保护红线的方式毁掉人格**。
 *
 * 判据：预算远小于边界层时，边界层仍然一条不少，而内核装不下的单元被丢。
 */
const boundaryUnits = Array.from({ length: 20 }, (_, index) => ({
  id: `boundary:${String(index)}`,
  section: 'boundaries',
  label: '红线',
  priority: 1000,
  order: index,
  text: '线'.repeat(100),
  chars: 100,
  exempt: true,
}))
const kernelUnits = [unit('slot:identity', 300, 100), unit('slot:voice', 300, 90)]
const tiny = pack([...kernelUnits, ...boundaryUnits], 400, false)
check('预算 400（小于边界层 2000 字）时边界仍全在', boundaryUnits.every(item => keptIds(tiny).includes(item.id)),
  `${String(keptIds(tiny).filter(id => id.startsWith('boundary:')).length)}/20 条`)
check('豁免单元不占候选额度（内核仍装得下）', keptIds(tiny).includes('slot:identity'), keptIds(tiny).join(','))

/* ---------------------------------------------------------------- *
 * 2. 绝不切字
 * ---------------------------------------------------------------- */

console.log('\n--- 2. 绝不切字 ---')
/*
 * 「带前 200 字」是本仓明令禁止的做法（`sections.ts` 文件头第 4 条）：
 * 被切掉半句的红线读起来仍然通顺，只是意思变了。
 *
 * 判据：每个留下的单元，正文长度必须**等于**原长。这一条比「没有 slice 调用」
 * 强——它连「上游先把 text 截短了再传进来」也能抓到。
 */
const long = unit('slot:drive', 2000, 45)
const tight = pack([long, unit('slot:identity', 500, 100)], 1000, false)
const keptLong = [...tight.kept.values()].flat().find(item => item.id === 'slot:drive')
check('装不下的长单元被整段丢弃，不是截半', keptLong === undefined, keptLong === undefined ? '已整段丢弃' : `留下了 ${String(keptLong.chars)} 字`)
const allKept = [...tight.kept.values()].flat()
check('留下的单元正文长度与原长一致', allKept.every(item => item.text.length === item.chars),
  allKept.map(item => `${item.id}:${String(item.chars)}`).join(' '))

/* ---------------------------------------------------------------- *
 * 3. 段级倒置：前面空了，后面不许单独留
 * ---------------------------------------------------------------- */

console.log('\n--- 3. 段级倒置 ---')
/*
 * 关系段写的是「这一段只改你和他之间的关系」——它修饰的内核不在时，
 * 这句话没有指代对象。所以内核一段都没留下时，关系与浓度都必须一起走。
 */
const sections = [
  unit('slot:identity', 2000, 100, 'kernel'),
  unit('relation:0', 200, 60, 'relation'),
  unit('tone:0', 80, 10, 'tone'),
]
const inverted = pack(sections, 300, false)
const ids = keptIds(inverted)
check('内核装不下时关系段被一并清掉', !ids.includes('relation:0'), ids.join(',') || '（全空）')
check('内核装不下时浓度段被一并清掉', !ids.includes('tone:0'), ids.join(',') || '（全空）')

/* ---------------------------------------------------------------- *
 * 4. 不变量：预算变大不许显著变差
 * ---------------------------------------------------------------- */

console.log('\n--- 4. 预算变大不许显著变差 ---')
/*
 * 这一组是第二十段那次修复的**回归网**。
 *
 * 真实的失效形态：段标题字数与预算形成循环，三轮迭代收敛到「丢 6 段」的差定点，
 * 而预算 3600 时收敛到「丢 2 段」。多给 50 字反而多丢 4 段。
 *
 * 修复是「标题额度按最坏情况固定预留」，切断循环。
 *
 * 用真实人设包跑，因为标题字数、槽位大小都来自真实数据——造几个假单元测不出
 * 「标题把最后一个单元挤掉」这种边界。
 */
const dataDir = new URL('../.shots/pack-check/', import.meta.url).pathname
await rm(dataDir, { recursive: true, force: true })
const ctx = new Context()
ctx.baseUrl = new URL('./', import.meta.url).href
const loaded = await loadCore(ctx, {
  enable: ['ondra-path-layout', 'ondra-store-sqlite', 'ondra-persona-loader', 'ondra-persona-core', 'ondra-persona-vars', 'ondra-persona-assemble'],
  configs: { 'ondra-path-layout': { root: dataDir } },
})
const assemble = ctx.get('ondra-persona-assemble')
check('人格装配可用', assemble !== undefined && assemble.available === true,
  loaded.skipped.map(item => item.id).join(',') || undefined)

if (assemble !== undefined && assemble.available) {
  /*
   * 泛扫全预算区间，钉**占用字符数单调不减**。
   *
   * ## 为什么不钉「保留单元数单调」
   *
   * 第一版钉的是「预算每加 100 字，保留单元数掉不超过 2 个」，跑了就红：
   * 1300 → 1400 掉了 4 件。查清后确认**红的是断言，不是产品**——
   * 那是「装不下就跳过继续试」这条规则的固有性质：
   *
   * | 预算 | 装下的东西 |
   * | --- | --- |
   * | 1300 | 身份锚定（1263）装不下 → 三件小单元共 847 字 |
   * | 1400 | 身份锚定装得下了 → 一大件挤掉三件小件，件数少 2 |
   *
   * 用三个假单元就能最小复现：{140, 60, 60} 在预算 120 下装两件（120 字），
   * 在预算 150 下只装一件（140 字）。手册 §2.6 要的正是这条规则
   * （「短而关键的段落不该被长段落挤掉」），所以件数非单调是**设计**。
   *
   * ## 该钉什么：占用字符数单调不减
   *
   * 这一条是**数学上必然成立**的：试装顺序由优先级决定、与预算无关，
   * 归纳可证「预算更大时每一步的已用字符都不会更多」，于是装下的集合是超集，
   * 字符数不减。它一旦不成立，只可能是算法被改坏了。
   *
   * 反向验证过：把边界层改成不豁免（`exempt: false`），这条立刻报红
   * （2300→2400：2301→847 字）。
   */
  const at = (budget) => {
    const result = assemble.assemble({ budgetChars: budget })
    const used = result.sections.reduce((sum, section) => sum + section.chars, 0)
    return { budget, used, units: result.sections.reduce((sum, section) => sum + section.units, 0), result }
  }
  const violations = []
  let previous = null
  for (let budget = 1200; budget <= 11000; budget += 100) {
    const current = at(budget)
    if (previous !== null && current.used < previous.used) {
      violations.push(`${String(previous.budget)}→${String(current.budget)}：${String(previous.used)}→${String(current.used)} 字`)
    }
    previous = current
  }
  check('预算变大时占用字符数不减（数学不变量）', violations.length === 0,
    violations.length === 0 ? '全区间 1200–11000 无一违例' : violations.slice(0, 3).join('；'))

  /*
   * 默认预算必须装得完整。这是用户能直接感知的那一条：默认值下她该是完整的，
   * 而不是「要先去设置里调一下」。
   */
  const byDefault = assemble.assemble()
  check('默认预算下零丢弃', byDefault.report.droppedCount === 0,
    `预算 ${String(byDefault.report.budgetChars)}，丢 ${String(byDefault.report.droppedCount)} 段`)
  check('默认预算下「说话」段在（决定像不像的 80%）',
    !byDefault.report.dropped.some(item => item.unitId === 'slot:voice'),
    byDefault.report.dropped.map(item => item.label).join('/') || '无丢弃')
  check('默认预算下不超预算', byDefault.report.overBudget === false,
    `${String(byDefault.report.usedChars)} / ${String(byDefault.report.budgetChars)}`)

  /* -------------------------------------------------------------- *
   * 4.1 预算账目必须自洽（实现中立）
   * -------------------------------------------------------------- */

  /*
   * ## 账目自洽：对实现中立的那条不变量
   *
   * 不管用什么算法，账都得对得上：`usedChars` 超了 `budgetChars` 就必须
   * `overBudget: true`，没超就不许报超。它跟「件数」无关，所以不会像上面
   * 那条一样被规则的固有性质搞成假红。
   *
   * ## 「零丢弃却超预算」是正常的，别把它当矛盾（我第一版就写错了）
   *
   * 第一版加了一条「零丢弃时不许超预算」，跑出来红在预算 6300：
   * 零丢弃、却用了 7725 字、超 1425 字。那是**边界层豁免**的必然结果——
   * 1481 字的红线不占候选额度，所以「候选全装下」与「正文不超预算」
   * 可以同时不成立。`overBudget: true` 正是如实上报这件事，报得没错。
   *
   * 所以判据只剩两条真正的不变量：超了必须报、没超不许乱报；
   * 再加一条「超支要有成因」（豁免字数或降级说明），否则就是闷声多算。
   */
  const accounting = []
  for (let budget = 1200; budget <= 11000; budget += 100) {
    const report = assemble.assemble({ budgetChars: budget }).report
    if (report.usedChars > report.budgetChars && report.overBudget !== true) {
      accounting.push(`${String(budget)}：用 ${String(report.usedChars)} 却未报超预算`)
    }
    if (report.usedChars <= report.budgetChars && report.overBudget === true) {
      accounting.push(`${String(budget)}：没超却报了超预算`)
    }
    /*
     * 超预算时成因必须写清。`exemptChars` 是边界层占的字数——它不占候选额度，
     * 所以「超支」几乎总由它解释。若某天超支而 exemptChars 为 0，说明有另一处
     * 在偷偷多算，那时 `degradations` 里该有条目说明。
     */
    if (report.overBudget === true && report.exemptChars === 0 && report.degradations.length === 0) {
      accounting.push(`${String(budget)}：超预算但既无豁免字数也无降级说明`)
    }
  }
  check('预算账目自洽（全区间 1200–11000）', accounting.length === 0,
    accounting.length === 0 ? '无一违例' : accounting.slice(0, 3).join('；'))
  const first = assemble.assemble({ budgetChars: 5000 })
  const second = assemble.assemble({ budgetChars: 5000 })
  check('同一预算连调两次结果一致', first.chars === second.chars && first.report.droppedCount === second.report.droppedCount,
    `${String(first.chars)}/${String(second.chars)} 字`)
}

await ctx.fiber.dispose()
await rm(dataDir, { recursive: true, force: true })

console.log('')
if (failures.length === 0) {
  console.log('全部通过。')
} else {
  console.log(`${String(failures.length)} 条未通过：`)
  for (const item of failures) console.log(`  - ${item}`)
}
process.exit(failures.length === 0 ? 0 : 1)
