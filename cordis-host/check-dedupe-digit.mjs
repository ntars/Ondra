/**
 * 灰区「只加固不写库」会不会吞掉新事实的取值 —— 判重纯逻辑核对。
 *
 * ## 这个脚本要钉的唯一一件事
 *
 * ```
 * 旧条：用户有一把自行车锁，并问密码是多少     ← 提到锁，但没有值
 * 新条：用户的自行车锁密码是 4712             ← 第一次给出值
 *   → 必须 add（新建），不许 append（只加固旧条、不写库）
 * ```
 *
 * ## 为什么这是缺陷而不是「保守一点更安全」
 *
 * `append` 的落库语义写死在 `service.ts:219-225`：它只调 `core.reinforce()`，
 * **不写新条**。所以一旦判成 `append`，用户说的那句话在库里根本没有对应行。
 * 而对话层照常回「记下了」——承诺与事实相反，用户从此不再提。
 *
 * 实测丢失（2026-11-13 14:45）：
 *
 * ```
 * 判重日志  append  用户的自行车锁密码是 4712。  containment=0.46  target=m-121e17e680
 * 库        select count(*) from memory_fact where text like '%4712%'  →  0
 * ```
 *
 * 旧条正文是「用户有一把自行车锁，并问SELF密码是多少…」，一个数字都没有。
 * 包含度 0.46 落在灰区 [0.40, 0.95)，槽位替换不匹配 → 走第 7 步 `append`。
 * 数字差异这条信号当时**只在 conflict 分支用，灰区分支没用**。
 *
 * ## 为什么用纯函数而不是起宿主
 *
 * `judge()` 是纯逻辑（文件头原话：「不碰 ctx、不碰库、不调模型」）。起宿主会引入
 * 「哪个插件先装载」「库在哪」「模型通不通」这些与被测判据无关的变量。
 * 起宿主的那份端到端核对在 `check-e2e-memory.mjs`，两者分工不同：
 * 这里钉**分类口径**，那里钉**链路通不通**。
 *
 * 用法：node cordis-host/check-dedupe-digit.mjs
 * 退出码：全部通过为 0。
 */

import { judge } from './plugins/ondra-memory-dedupe/lib/judge.js'

const failures = []
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${label}${detail === undefined ? '' : `（${detail}）`}`)
  } else {
    console.log(`  ✗ ${label}${detail === undefined ? '' : `（${detail}）`}`)
    failures.push(label)
  }
}

/** 与插件 `DEFAULT_CONFIG` 对齐的基线阈值，只覆盖被测相关项。 */
const BASE = Object.freeze({
  minCompareChars: 4,
  mergeThreshold: 0.4,
  duplicateThreshold: 0.95,
  appendNovelty: 0.25,
  appendNoveltyGrams: 2,
  slotCoverage: 0.45,
  maxSlotChars: 40,
  maxCandidates: 5,
})

/** 造一条候选。`containment` 由调用方给定，模拟 service 算完的结果。 */
function candidate(id, text, containment, extra = {}) {
  return { id, text, containment, novelty: 0.5, freshGrams: 6, slotMatch: false, ...extra }
}

/** 跑一次判定。 */
function run(text, candidates, settings = BASE) {
  return judge({
    request: { text },
    candidates,
    tombstoned: false,
    chars: [...text].filter((char) => !/\s/u.test(char)).length,
    settings,
  })
}

console.log('=== 灰区取值丢失核对 ===')

/* ------------------------------------------------------------------ *
 * 1. 主判据：旧条无数字 + 新条有数字 → 必须 add
 * ------------------------------------------------------------------ */
console.log('\n--- 1. 旧条没提过值、新条第一次给出值（本脚本的主判据）---')

const lost = run('用户的自行车锁密码是 4712。', [
  candidate('m-121e17e680', '用户有一把自行车锁，并问密码是多少；密码不在对话中念出来。', 0.46),
])
check('灰区里新条带来旧条没有的数字 → 判 add（新建，不是只加固）',
  lost.action === 'add',
  `实际 ${lost.action}`)
check('主判据的判定理由里点名了那个数字',
  lost.reasons.some((line) => line.includes('4712')),
  lost.reasons.join(' / ').slice(0, 60))

/*
 * 同一条如果数字被抹掉，必须回到 append。
 *
 * 这一条是**校准锚**：少了它，上面那条通过可能只是「第 7 步整段被删」，
 * 那是假绿——那样连真正的「补充」也会被错判成新建，每次复述都多一条重复。
 */
const plain = run('用户有一把自行车锁，并说密码不在对话里念出来。', [
  candidate('m-121e17e680', '用户有一把自行车锁，并问密码是多少；密码不在对话中念出来。', 0.80),
])
check('同一句式但没带新数字时仍走 append（证明第 7 步没被整段关掉）',
  plain.action === 'append',
  `实际 ${plain.action}`)


/* ------------------------------------------------------------------ *
 * 2. 反向边界：旧条已有数字而新条不同，属于「换值」不许在这里抢判
 * ------------------------------------------------------------------ */
console.log('\n--- 2. 边界：旧条已有数字（换值属于 conflict，不许被本分支抢走）---')

const changed = run('用户的门禁密码是 7712。', [
  candidate('m-7db006', '用户的门禁密码是 6633。', 0.60),
])
check('旧条有数字、新条数字不同 → 仍走换值/补充这条路，不改判 add 抢判定',
  changed.action !== 'add' || !changed.reasons.some((line) => line.includes('首次给出的取值')),
  `实际 ${changed.action}`)

const sameNumber = run('用户的自行车锁密码是 4712。', [
  candidate('m-x', '用户的自行车锁密码是 4712。', 0.60),
])
check('两条数字相同 → 不触发本分支（数字不是新增信号）',
  !sameNumber.reasons.some((line) => line.includes('首次给出的取值')),
  `实际 ${sameNumber.action}`)

/* ------------------------------------------------------------------ *
 * 3. 全等线之上不受影响：复述仍然 drop
 * ------------------------------------------------------------------ */
console.log('\n--- 3. 全等线之上不受影响（复述仍然只记被提起）---')

const restate = run('用户的自行车锁密码是 4712。', [
  /* 复述的定义是「新颖度低 且 绝对新增少」，两样都要给足。 */
  candidate('m-x', '用户的自行车锁密码是 4712。', 0.98, { novelty: 0.1, freshGrams: 1 }),
])
check('包含度 ≥ 全等线且新颖度低 → 仍然 drop，不被本分支改成 add',
  restate.action === 'drop',
  `实际 ${restate.action}`)

/* ------------------------------------------------------------------ */
console.log('')
if (failures.length === 0) {
  console.log('全部通过：灰区不会再把「第一次给出的值」当补充吞掉。')
} else {
  console.log(`未通过 ${failures.length} 条：`)
  for (const label of failures) console.log(`  - ${label}`)
}
process.exit(failures.length === 0 ? 0 : 1)
