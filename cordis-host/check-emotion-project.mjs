/**
 * 情感投影的实物核对：她这一轮到底有没有拿到「今天该怎么开口」。
 *
 * ## 这个脚本要证明的唯一一件事
 *
 * ```
 * 情绪内核里 mood=0.9 / energy=90
 *   → ondra-emotion-express 判「雀跃」
 *   → ondra-emotion-project.project() 产出两段模板 + 约束句
 *   → 宿主 assembleSystemPrompt() 把它拼成**最后一段**
 *   → 那一整段过得了护栏（零数字、零维度名、零六态名）
 * ```
 *
 * ## 为什么必须验到「进了系统提示词」那一层
 *
 * `ondra-emotion-project` 的六态模板、四条护栏词表、四道拒绝闸、配置段、
 * 启动自检全都写完了，缺的是四样东西，而四样全都不报错：
 *
 * | 缺的 | 症状 | 只验前一层会漏什么 |
 * | --- | --- | --- |
 * | 不在默认启用名单 | 服务不注册 | 手动装一次就绿了 |
 * | `project()` 零调用方 | 模板写好了，没人问 | 插件自己的 `stats()` 说「我是好的」 |
 * | 投影文本没有消费者 | 系统提示词只有人格 + 片段 | **最隐蔽的一层**：取到了也能丢掉 |
 * | `constraint` 没有消费者 | §4.4 限定句从未进过提示词 | 同上 |
 *
 * 第三、四层正是本仓反复踩的形态（第九次）：A 写、B 读、中间少根线，
 * 而断掉时两头都给得出一个合法值。所以这里的断言**从装配结果倒着验**，
 * 而不是问插件「你产出了吗」。
 *
 * ## 为什么还要验「护栏扫成品」
 *
 * 模板自检只扫 `command + hint`，而真正进提示词的是
 * `command + hint + constraint`。若将来有人把一句带数字的限定句塞进
 * `CONSTRAINT_LINE`，插件自检照常全绿——它根本没扫那一段。
 * 这里扫的是**成品**，是唯一挡得住那种改动的口径。
 *
 * 用法：node cordis-host/check-emotion-project.mjs
 * 退出码：全部通过为 0。
 */

import { Context } from '@ntars/cordis'
import { rm } from 'node:fs/promises'
import { loadCore } from './plugins/ondra-core/lib/index.js'
import { assembleSystemPrompt } from './lib/src/system-prompt.js'
import { assembleEmotionBlock, projectionProbe } from './lib/src/emotion.js'

/*
 * 只装这条链需要的成员。
 *
 * `ondra-path-layout` 不能漏（本仓第七次记这一条）：`ondra-store-sqlite`
 * 的 `path` 默认为空，空时必须向路径服务要位置；拿不到就**直接不注册服务**，
 * 情绪内核静默退回内存态，`emotion_state` 表根本不存在，而 `available`
 * 仍是 true。
 *
 * 刻意不装人格链：本脚本验的是「情绪 → 提示词」这一条边。人格链缺席会
 * 让 `assembleSystemPrompt()` 的 `missing` 多一条，但**不影响**情绪段
 * ——那正是要顺带证明的事：情绪块不依赖人格链，附录的顺序也不依赖。
 */
const NEEDED = [
  'ondra-path-layout',
  'ondra-store-sqlite',
  'ondra-emotion-core',
  'ondra-emotion-express',
  'ondra-emotion-project',
]

/*
 * 每次跑之前清空。判据全是「从基线变到偏离」，库若沿用上一次的，
 * 起点就不是基线了——一个只在第一次能过的检查脚本等于没有检查脚本。
 */
const dataDir = new URL('../.shots/emotion-project-check/', import.meta.url).pathname
await rm(dataDir, { recursive: true, force: true })

const ctx = new Context()
ctx.baseUrl = new URL('./', import.meta.url).href
const result = await loadCore(ctx, {
  enable: NEEDED,
  configs: { 'ondra-path-layout': { root: dataDir } },
})

const failures = []
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${label}${detail === undefined ? '' : `（${detail}）`}`)
  } else {
    console.log(`  ✗ ${label}${detail === undefined ? '' : `（${detail}）`}`)
    failures.push(label)
  }
}

console.log('=== 情感投影 · 端到端核对 ===')
console.log(`装载 ${String(result.loaded.length)} 项，跳过 ${String(result.skipped.length)} 项`)
for (const item of result.skipped) {
  if (!NEEDED.includes(item.id)) continue
  console.log(`  ! 本链成员被跳过 ${item.id}：${item.reason}`)
}

const emotion = ctx.get('ondra-emotion-core')
const express = ctx.get('ondra-emotion-express')
const project = ctx.get('ondra-emotion-project')

console.log('\n--- 1. 四个服务是否都在 ---')
check('ondra-emotion-core 已注册', emotion !== undefined)
check('ondra-emotion-express 已注册', express !== undefined)
check('ondra-emotion-project 已注册', project !== undefined)

if (emotion === undefined || express === undefined || project === undefined) {
  console.log('\n服务缺席，无法继续。跳过明细见上。')
  await ctx.fiber.dispose()
  process.exit(1)
}

check('投影服务可用（不是 disabled）', project.available === true, String(project.reason))
check('投影看得见六态服务', project.stats().hasExpress === true)

console.log('\n--- 2. 六态 → 投影：六条模板逐条自证 ---')
/*
 * 六态各来一次，用 `state` 显式指定而不是改读数。
 *
 * 为什么不用 `setAxis` 走真实判据：那要处理「炸毛压过蔫」这一类优先级冲突，
 * 而那考的是 O-031 的判据（`check:emotion` 已覆盖），不是本文件要验的
 * 「模板 → 提示词」这一段。显式给状态时插件按 `matched: true` 算置信度 0.9，
 * 正好也验到那条分支。
 */
const STATES = ['joyful', 'soft', 'calm', 'wilted', 'bristled', 'sleepy']
let templateOk = 0
for (const state of STATES) {
  const projection = project.project({ state, askedForNumbers: false })
  const ok = projection.allowed === true && projection.text !== '' && projection.fragment?.order === 800
  if (ok) templateOk += 1
  else console.log(`    ! ${state}：allowed=${String(projection.allowed)} refusal=${String(projection.refusal)}`)
}
check('六态模板全部产出且排序 800（尾部）', templateOk === STATES.length, `${String(templateOk)}/6`)

console.log('\n--- 3. 唯一例外：用户问了数值 → 不出投影 ---')
/*
 * §4.3 的唯一例外。**这一条必须验**：如果 `askedForNumbers` 被忽略了，
 * 表现是「用户问『你现在心情多少』，她先报了一大段语气建议」——
 * 两个方向都没报错，只是行为错。
 */
const asked = project.project({ state: 'joyful', askedForNumbers: true })
check('askedForNumbers=true 时拒绝产出', asked.allowed === false && asked.text === '', String(asked.refusal))
check('拒绝原因码是 numbers-requested', asked.refusal === 'numbers-requested', String(asked.refusal))

console.log('\n--- 4. 宿主装配：情绪块真的进了系统提示词 ---')
/*
 * 这一组是本轮最要紧的部分。
 *
 * 前三组全绿也可能「什么都没接上」：插件产得出、六态判得准，而
 * `assembleSystemPrompt()` 一个字都没取。所以这里读的是**装配结果**，
 * 不是插件自己的视图。
 */
emotion.setAxis('mood', 0.9)
emotion.setAxis('energy', 90)
emotion.setAxis('tension', 0.1)

const prompt = assembleSystemPrompt(ctx)
const emotionPart = prompt.parts.find(part => part.id === 'emotion')

check('系统提示词里有情绪段', emotionPart !== undefined)
check('情绪段正文非空', (emotionPart?.chars ?? 0) > 0, `${String(emotionPart?.chars ?? 0)} 字`)

if (emotionPart !== undefined) {
  /*
   * 情绪段必须是**最后一段**。手册 §8.5：稳定段在头、易变段追加尾部。
   * 排在前面等于每轮把几千字的稳定前缀搅掉一遍，而收益为零——
   * 投影那句话本身就是「这一轮」的，放哪儿都不增加稳定性。
   */
  check('情绪段是最后一段', prompt.parts[prompt.parts.length - 1]?.id === 'emotion',
    prompt.parts.map(part => part.id).join(' → '))

  check('情绪段进了最终正文', prompt.text.includes(emotionPart.text))

  console.log('\n--- 5. 护栏扫成品（不只是模板） ---')
  /*
   * 扫的是**真正进提示词的那段文本**，不是插件的 `command + hint`。
   * 差别在约束句：插件自检只扫前两段，限定句从未被扫过。
   * 这一条挡的是「有人往 `CONSTRAINT_LINE` 里塞了数字」——
   * 那种改动会让插件自检全绿，而提示词里出现报数。
   */
  const guard = project.guard(emotionPart.text)
  check('成品过得了护栏（零数字 / 零维度名 / 零六态名）', guard.pass === true,
    guard.pass ? undefined : guard.hits.map(hit => `${hit.kind}:${hit.text}`).join('、'))

  /*
   * §4.4 的限定句必须在成品里。**独立验**而不是靠「正文非空」携带：
   * 少了它，模型会把「你今天话可以多一点」当成行为授权。
   */
  check('成品带 §4.4 约束句', emotionPart.text.includes('情绪只影响语气'))

  /*
   * 六态名是**面板用**的，不许进正文。这一条对「平静」尤其要紧：
   * 「按平常的节奏说就行」那段正文里没有「平静」二字，但模板的 `zh`
   * 就在旁边，一次手滑 `command: \`${zh}：…\`` 就会漏进去。
   */
  const stateNames = ['雀跃', '软和', '平静', '炸毛', '困意']
  const leaked = stateNames.filter(name => emotionPart.text.includes(name))
  check('正文不含六态名', leaked.length === 0, leaked.length === 0 ? undefined : leaked.join('、'))
}

console.log('\n--- 6. 换一个状态，提示词真的跟着换 ---')
/*
 * 「情绪块在里面」与「情绪块真的随状态变」是两件事。前者一个写死的
 * 常量块也能满足。所以这里换到「炸毛」（tension > 0.5），
 * 比对新旧两段 => 必须不同，且旧的正文不再出现。
 */
const before = assembleSystemPrompt(ctx).parts.find(part => part.id === 'emotion')?.text ?? ''
emotion.setAxis('mood', 0.6)
emotion.setAxis('energy', 60)
emotion.setAxis('tension', 0.9)
const after = assembleSystemPrompt(ctx).parts.find(part => part.id === 'emotion')?.text ?? ''
check('两次装配的情绪段不同（真的跟着状态换）', before !== '' && after !== '' && before !== after,
  `${before.slice(0, 12)}… / ${after.slice(0, 12)}…`)

console.log('\n--- 7. 六态缺席时：无情绪块，但不影响其他段 ---')
/*
 * 这条验的是**降级边界**。投影拿不到六态时返回 `no-state`，装配应跳过
 * 这一整段而不是拼一句兜底文案——补出来的「你今天心情一般」是替别人
 * 编状态，比没有情绪块更坏。
 *
 * 判据用 `projectionProbe()` 的 `counters.projects` 与 `refusals` 两个数：
 * 它们分开涨，才说明「调用到了、判据在拦」，而不是「根本没调用」。
 */
const probe = projectionProbe(ctx)
check('诊断报服务在位', probe.present === true)
check('诊断报得出六态在位', probe.hasExpress === true)
check('诊断如实报「例外出口未接」', probe.askedForNumbersWired === false)
check('投影计数器在涨（真的产出过）', Number(probe.counters?.projects ?? 0) > 0,
  `projects=${String(probe.counters?.projects ?? 0)}`)
check('拒绝计数器在涨（例外闸真的拦了）', Number(probe.counters?.refusals ?? 0) > 0,
  `refusals=${String(probe.counters?.refusals ?? 0)}`)

console.log('\n--- 8. 幂等（同一状态连装两次，正文一致） ---')
/*
 * 只比情绪段本身，不比整段提示词：人格段可能含当前时刻（浓度 / 时间感），
 * 那是设计如此。情绪段是纯函数（状态 → 文案），同一时刻必须逐字相同，
 * 否则「她这一轮的语气」会在两次装配之间抖动。
 */
const again = assembleSystemPrompt(ctx).parts.find(part => part.id === 'emotion')?.text ?? ''
/*
 * 必须连**非空**一起断。第一版只写 `after === again`，做反向验证时
 * 把 `parts.push(...)` 整行删掉，两段都成了空串、这条**照常报绿**——
 * 与 `0 === 0` 是同一类假绿。判定条件里加一个 `!== ''` 才关得住。
 */
check('同一状态连装两次，情绪段逐字相同且非空', after !== '' && after === again,
  `${String(after.length)} / ${String(again.length)} 字`)

console.log('\n--- 9. 异常路径：四种「不该拼进提示词」的情形 ---')
/*
 * ## 为什么要专门造一个假上下文
 *
 * 前八组走的都是正常路径。做反向验证时把「约束句缺失就不注入」那道闸
 * 改成恒假（`if (false && ...)`），**这一整套断言一条都没红**——因为真实的
 * 插件永远带着约束句，异常路径从来没被走到。上一轮记忆里记过同一类坑：
 * 「只断言正常路径的值，会漏掉异常路径的信号灯」。
 *
 * 所以这里另起一个空上下文，塞一个替身服务，专门把四种边界各走一遍。
 * 替身只实现 `assembleEmotionBlock()` 真正用到的那几个成员，
 * 不去碰真实插件——真实插件产不出这四种输入，正是问题所在。
 */
/** 造一个投影替身。 */
function stubProjection(overrides) {
  return {
    available: true,
    project: () => ({
      text: '按平常的节奏说就行。',
      constraint: '情绪只影响语气，不影响判断；不能拿情绪拿捏对方。',
      state: 'calm',
      allowed: true,
      ...overrides,
    }),
    guard: () => ({ pass: true, hits: [] }),
    stats: () => ({ counters: {}, hasExpress: true }),
  }
}

/**
 * 在**独立上下文**里装一个替身，跑一次装配。
 *
 * 每次都要新建上下文：`provide()` 对同一服务键只能注册一次，
 * 复用会让第二次装的时候撞「键已注册」。
 * @param {unknown} service 替身；传 `undefined` 表示不装。
 */
function assembleWith(service) {
  const context = new Context()
  context.baseUrl = new URL('./', import.meta.url).href
  if (service !== undefined) context.provide('ondra-emotion-project', service)
  return assembleEmotionBlock(context)
}

const noService = assembleWith(undefined)
check('服务没装载 → 不拼，原因码 not-loaded',
  noService.applied === false && noService.refusal === 'not-loaded', String(noService.refusal))

const disabled = assembleWith({ ...stubProjection({}), available: false, reason: 'disabled' })
check('配置关掉 → 不拼，原因码 disabled',
  disabled.applied === false && disabled.refusal === 'disabled', String(disabled.refusal))

const noConstraint = assembleWith(stubProjection({ constraint: '  ' }))
check('约束句为空 → 不注入（宁可没情绪块，也不给无限定的语气建议）',
  noConstraint.applied === false && noConstraint.refusal === 'no-constraint', String(noConstraint.refusal))

const emptyText = assembleWith(stubProjection({ text: '' }))
check('允许输出但正文为空 → 不拼，原因码 empty-text',
  emptyText.applied === false && emptyText.refusal === 'empty-text', String(emptyText.refusal))

const threw = assembleWith({
  ...stubProjection({}),
  project: () => { throw new Error('模拟器官抛错') },
})
check('投影抛错 → 吞掉，原因码 threw（不让整轮对话发不出去）',
  threw.applied === false && threw.refusal === 'threw', String(threw.refusal))

const refused = assembleWith(stubProjection({ allowed: false, refusal: 'no-state', text: '' }))
check('插件拒绝（no-state）→ 原样转出原因码',
  refused.applied === false && refused.refusal === 'no-state', String(refused.refusal))

/*
 * 正路也要在替身上走一遍：否则上面六条可以靠「永远不拼」全绿。
 * 这是同一类假绿的镜像——只验异常路径会漏掉「根本不会工作」。
 */
const okPath = assembleWith(stubProjection({}))
check('替身的正常路径确实拼得出（否则上面六条是假绿）',
  okPath.applied === true && okPath.part?.id === 'emotion', String(okPath.part?.chars))

console.log('')
if (failures.length === 0) {
  console.log('全部通过。')
} else {
  console.log(`${String(failures.length)} 条未通过：`)
  for (const item of failures) console.log(`  - ${item}`)
}

await ctx.fiber.dispose()
process.exit(failures.length === 0 ? 0 : 1)
