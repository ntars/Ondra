/**
 * 数字出处口径的一致性核对。
 *
 * ## 这个脚本要证明的唯一一件事
 *
 * ```
 * 用户亲口说「我车牌尾号 3721」
 *   → 提炼阶段认这是「有出处的数字」        ← 此前被整条拒
 *   → 候选能走到判重与入库
 *   → 证据门控的 tool-or-user 口径才真的被执行到
 * ```
 *
 * ## 为什么这是缺陷而不是「严格一点更安全」
 *
 * 同一个产品里有两处管「数字要不要出处」：
 *
 * | 位置 | 开关 | 旧口径 | 后果 |
 * | --- | --- | --- | --- |
 * | 提炼（本脚本验的这一处） | `require-tool-for-digits` | 只认 `TOOL` | **在提炼阶段整条拒掉** |
 * | 入库（`ondra-evidence-gate`） | `digit-source` | `tool-or-user` | 永远等不到这些候选 |
 *
 * 下游已经用一整段论证写了「伴侣产品必须让 USER 引文覆盖数字」——
 * 「我今年 28 岁」「周五考试」「我住 3 号楼」都只有 USER 引文。可上游把它提前删了，
 * 于是那段论证执行不到。实测症状：
 *
 * ```
 * 用户：我叫小玖，车牌尾号是 3721
 * 她  ：车牌尾号 3721，也写上了     ← 口头承诺
 * 用户：我车牌尾号多少？
 * 她  ：车牌尾号我没记下            ← 实际 written=0
 * ```
 *
 * 承诺与事实相反，比「没记住」更伤——用户以为记住了，从此不再提。
 *
 * ## 为什么用纯函数而不是起宿主
 *
 * 这条口径是 `verifyCandidate()` 里的一段纯判定，起宿主只会引入
 * 「哪个插件先装载」「库在哪」这些与本判据无关的变量。起宿主的那份
 * 端到端核对在 `check-e2e-memory.mjs`，两者分工不同：
 * 这里钉**口径**，那里钉**链路**。
 *
 * 用法：node cordis-host/check-memory-digits.mjs
 * 退出码：全部通过为 0。
 */

import { verifyCandidate, digitRuns } from './plugins/ondra-memory-extract/lib/verify.js'
import { SYSTEM_PROMPT } from './plugins/ondra-memory-extract/lib/prompt.js'

const failures = []
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${label}${detail === undefined ? '' : `（${detail}）`}`)
  } else {
    console.log(`  ✗ ${label}${detail === undefined ? '' : `（${detail}）`}`)
    failures.push(label)
  }
}

/** 与插件 `DEFAULT_CONFIG` 对齐的基线设置；逐段覆盖只改被测那一项。 */
const BASE = Object.freeze({
  maxTextChars: 200,
  maxSummaryChars: 80,
  minQuoteChars: 2,
  // 出厂默认。**这一行是被测对象**：它若被改回 true，下面「用户口述数字入库」会红。
  requireToolForDigits: false,
})

/** 一轮对话：用户说一句，她答一句。`source` 标注每条消息的出处类型。 */
function turn(userText, selfText) {
  return [
    { role: 'user', text: userText, source: 'USER' },
    { role: 'assistant', text: selfText, source: 'SELF' },
  ]
}

/** 造一条候选。`text` 是要入库的正文，`quotes` 是它声称的逐字引文。 */
function candidate(text, quotes) {
  return {
    text,
    category: 'person',
    kind: 'fact',
    evidence: quotes.map(quote => ({ source: quote.source, quote: quote.quote, messageIndex: 0 })),
  }
}

console.log('=== 数字出处口径一致性核对 ===')

/* ------------------------------------------------------------------ *
 * 1. 出厂默认必须让「用户亲口说的数字」过
 * ------------------------------------------------------------------ */
console.log('\n--- 1. 用户口述的数字（本脚本的主判据）---')

const spoken = turn('我叫小玖，车牌尾号是 3721', '车牌尾号 3721，我记着了。')
const userOnly = verifyCandidate(
  candidate('用户车牌尾号是 3721', [{ source: 'USER', quote: '车牌尾号是 3721' }]),
  spoken,
  BASE,
)
check('只有 USER 引文的数字能入库（不再被提炼阶段拒掉）',
  userOnly.rejection === undefined,
  userOnly.rejection === undefined ? '放行' : `被拒：${userOnly.rejection.code}`)

/*
 * 反向：把开关打开，同一条必须被拒。
 *
 * 这一条是整个脚本的**校准锚**。少了它，上面那条通过可能只是
 * 「数字校验整段没执行」（比如 `digitRuns` 返回空、或那段 `if` 被删），
 * 那是假绿。「打开就拒」证明这段校验确实在跑、确实看得到这个数。
 */
const strict = verifyCandidate(
  candidate('用户车牌尾号是 3721', [{ source: 'USER', quote: '车牌尾号是 3721' }]),
  spoken,
  { ...BASE, requireToolForDigits: true },
)
check('打开严格口径后同一条被拒（证明校验真的在跑）',
  strict.rejection !== undefined && strict.rejection.code === 'digit-without-tool',
  strict.rejection === undefined ? '竟然放行了' : strict.rejection.code)

/* ------------------------------------------------------------------ *
 * 2. 没有出处的数字仍然必须被拒
 * ------------------------------------------------------------------ */
console.log('\n--- 2. 编造的数字仍然进不来 ---')

/*
 * 这条防的是「修一处、漏一处」：把 USER 加进白名单时，很容易顺手把
 * 「必须有逐字出处」也一起放松。候选里写了 3721，引文里却没有这个数
 * （引文只说「车的事」），那就是她凭印象写下的数字——手册要防的正是这个。
 *
 * 引文本身仍要逐字存在于本轮（否则会先被 `quote-not-verbatim` 拦下，
 * 测不到数字闸），所以引文用原文里真实出现的短句「我车的事」——
 * 它在用户那句话里逐字存在，但**不含数字**。
 */
const fabricatedTurn = turn('我车的事你别管，反正停楼下了', '好，我不问。')
const fabricated = verifyCandidate(
  candidate('用户车牌尾号是 3721', [{ source: 'USER', quote: '我车的事' }]),
  fabricatedTurn,
  BASE,
)
check('正文有数字但引文没有逐字覆盖 → 拒',
  fabricated.rejection !== undefined && fabricated.rejection.code === 'digit-without-tool',
  fabricated.rejection === undefined ? '竟然放行了' : fabricated.rejection.code)

/*
 * SELF 与 ACT 不算出处。
 *
 * 这两类不是「有人说过这个数」：SELF 是她自己说的话（自证循环），
 * ACT 是她做过的动作。若它们能覆盖数字，她可以自己编一个数、再引用
 * 自己那句话当证据——那是本仓明令禁止的「用自己的 stats 自证」。
 *
 * 这里给一条 USER 引文（为了让归功检查先过），但那条引文**不含数字**；
 * 数字只在 SELF 引文里。若 SELF 被误算成出处，这条会漏过去。
 */
const selfTurn = turn('我车停在楼下了', '车牌尾号 3721，我记着了。')
const selfBacked = verifyCandidate(
  candidate('用户车牌尾号是 3721', [
    { source: 'USER', quote: '我车停在楼下了' },
    { source: 'SELF', quote: '车牌尾号 3721' },
  ]),
  selfTurn,
  BASE,
)
check('只有 SELF 引文覆盖数字 → 拒（不许自证）',
  selfBacked.rejection !== undefined && selfBacked.rejection.code === 'digit-without-tool',
  selfBacked.rejection === undefined ? '竟然放行了' : selfBacked.rejection.code)

/* ------------------------------------------------------------------ *
 * 3. TOOL 口径没被弄坏
 * ------------------------------------------------------------------ */
console.log('\n--- 3. TOOL 引文照旧算出处 ---')

const toolTurn = [
  { role: 'user', text: '查一下我的订单', source: 'USER' },
  { role: 'assistant', text: '订单 20261112 已发货。', source: 'TOOL' },
]
const toolBacked = verifyCandidate(
  candidate('用户的订单号是 20261112', [{ source: 'TOOL', quote: '订单 20261112 已发货' }]),
  toolTurn,
  BASE,
)
check('TOOL 引文覆盖数字 → 放行',
  toolBacked.rejection === undefined,
  toolBacked.rejection === undefined ? '放行' : `被拒：${toolBacked.rejection.code}`)

/* ------------------------------------------------------------------ *
 * 4. 没有数字的正文不受影响
 * ------------------------------------------------------------------ */
console.log('\n--- 4. 无关正文不受影响 ---')

const noDigits = verifyCandidate(
  candidate('用户的车停在楼下', [{ source: 'USER', quote: '我车停在楼下' }]),
  turn('我车停在楼下', '嗯，知道了。'),
  BASE,
)
check('正文无数字 → 放行（数字闸不该拦无关事实）',
  noDigits.rejection === undefined,
  noDigits.rejection === undefined ? '放行' : `被拒：${noDigits.rejection.code}`)

/* ------------------------------------------------------------------ *
 * 5. 数字游程识别本身
 * ------------------------------------------------------------------ */
console.log('\n--- 5. 数字识别（全角与小数）---')

/*
 * 全角数字必须归一：用户用中文输入法打「３７２１」是常事，
 * 若识别不到，那条会绕过整道数字闸——它不是被放行，是**没被看**。
 */
check('全角数字也认（３７２１）', digitRuns('尾号３７２１').length === 1,
  digitRuns('尾号３７２１').join(','))
check('小数算一个游程（3.14 不是 3 和 14）', digitRuns('圆周率 3.14').length === 1,
  digitRuns('圆周率 3.14').join(','))
check('无数字时返回空', digitRuns('今天风不大').length === 0,
  String(digitRuns('今天风不大').length))

/* ------------------------------------------------------------------ *
 * 6. 提示词与代码同口径（本轮补的最后一环）
 * ------------------------------------------------------------------ */
console.log('\n--- 6. 提示词规则 4 与代码同口径 ---')

/*
 * ## 为什么纯代码全绿、记忆里却还是没有数字
 *
 * 上面 1–5 段验的全部是 `verifyCandidate()`——**入库前的闸门**。
 * 闸门只是「不拦」，它不会让数字**出现在正文里**。正文是模型写的，
 * 模型照着 `SYSTEM_PROMPT` 写。旧规则 4 原文是：
 *
 *   任何数字（日期、年龄、价格、数量、次数）必须来自 TOOL 引文。
 *   用户口述的数字不要写进 text。
 *
 * 第二句是**主动指令**：模型乖乖把「7 楼 712 室，密码 8848」抽象成
 * 「楼层和房间号，以及密码」。实测入库文本：
 *
 *   用户告诉她自己工位所在的楼层和房间号，以及工位密码，要她记住。
 *
 * 代码层放行 `USER` 引文（第 1 段已证明），可上游把数字提前删了——
 * **下游要保的东西在执行之前就不存在了**。这是「两处口径不一致」的
 * 第二种形态：不是互相矛盾地拒，而是一处放宽、另一处仍在禁止。
 *
 * ## 判据为什么是「断言不出现某文案」而不是「断言出现某文案」
 *
 * 断言具体措辞会把测试和文案绑死，改一个字就红，于是没人敢改文案。
 * 这里只钉两件**语义上必须为假**的事：
 * 1. 不能出现「用户口述的数字不要写进 text」这类禁止口述数字的指令；
 * 2. 不能出现「必须来自 TOOL」这种把 TOOL 设成唯一出处的绝对口径。
 * 正向要求（数字要照抄原文）由第 1 段的实机链路背书。
 */
const forbidden = [
  ['用户口述的数字不要写进', '主动指令模型丢弃口述数字'],
  ['必须来自 TOOL 引文', '把 TOOL 设成数字的唯一出处'],
]
for (const [phrase, why] of forbidden) {
  check(`提示词不含「${phrase}」`, !SYSTEM_PROMPT.includes(phrase), why)
}

/*
 * 正向：规则 4 必须仍然**要求数字有逐字出处**，否则等于把闸门拆了。
 * 「逐字」二字是关键——它对应 `verify.ts` 的子串比对，缺了它，
 * 提示词就只剩「照抄原文」，而模型会理解成「照抄我记忆里的原文」。
 */
const rule4 = SYSTEM_PROMPT.split('\n').find(line => line.startsWith('4. ')) ?? ''
check('规则 4 仍要求数字被引文逐字覆盖', rule4.includes('逐字'),
  rule4 === '' ? '找不到规则 4' : rule4.slice(0, 60) + '…')
check('规则 4 明确 USER 口述也算出处', rule4.includes('USER'),
  rule4.includes('USER') ? '已写明' : '未写明 USER；模型会以为只认 TOOL')

console.log('')
if (failures.length === 0) {
  console.log('全部通过。')
  process.exit(0)
}
console.log(`失败 ${String(failures.length)} 条：`)
for (const item of failures) console.log(`  - ${item}`)
process.exit(1)
