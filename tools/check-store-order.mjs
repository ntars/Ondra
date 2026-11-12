/**
 * 核对「存储三兄弟」的装载顺序与它们的消费方一致。
 *
 * ## 这条检查补的是哪条断掉的边
 *
 * 三个存储端口按优先级取用：
 *
 * ```ts
 * const store = ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')
 * ```
 *
 * `??` 的右半边是**备用后端**：SQLite 开不起来时（库损坏、磁盘满、权限没了），
 * 记忆链应该退到内存存储，至少这一轮还能用。
 *
 * 但 `loadCore` 装的是 `orderMembers()` 排过的序，而 `orderMembers` 只认成员
 * 自己声明的 `after`。`ondra-store-memory` 的 `after` 里有 `ondra-store-sqlite`
 * ——它要读 SQLite 状态来判断「我在不在用」——于是它被推到 SQLite **之后**，
 * 而清单里那些只写了 `after: ['ondra-store-sqlite']` 的消费方全都排在它
 * **前面**。
 *
 * 结果：`ctx.get('ondra-store-memory')` 在**每一个**消费方那里都是
 * `undefined`。备用后端装着呢，日志还打印「本后端仅作备用」，但没有任何人
 * 能看见它。SQLite 一旦失守，整条记忆链直接躺平，而备用后端就在旁边。
 *
 * ## 为什么这件事必须被检查盯住
 *
 * 它今天**不报错**：SQLite 正常时所有消费方都命中左半边，行为完全正确。
 * 症状只在 SQLite 失守那一刻出现，而那一刻恰恰是最需要冗余的时候。
 * 更麻烦的是它会随「加插件」悄悄复发——新写的插件照抄一行
 * `after: ['ondra-store-sqlite']` 就又漏了一个。
 *
 * ## 判据与反向验证
 *
 * 判据是**派生量**：把成员清单交给真的 `orderMembers()` 排一次序，再对每个
 * 成员的源码做一次字面检查——只要出现 `ctx.get('<某个存储键>')`，它在排序
 * 结果里的位置就必须在该键的提供方之后。
 *
 * 反向验证做过：把任意一个消费方的 `after` 里的 `'ondra-store-memory'` 删掉，
 * 本脚本立刻报出那一个 id（而不是笼统报错）。
 *
 * ## 为什么读 `src/` 而不是 `lib/`
 *
 * 被检查的是**人写的那一行声明**会不会漏，源码是唯一真源。不过排序依据必须
 * 用 `lib/`（宿主实际加载的是它），所以本脚本会先比对一次产物新鲜度：
 * 源码比产物新就说明两边可能不是同一份东西，直接判失败而不是给出假绿。
 *
 * 用法：node tools/check-store-order.mjs
 * 退出码：全部通过为 0。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const CORE_SRC = join(ROOT, 'cordis-host', 'plugins', 'ondra-core', 'src', 'index.ts')
const CORE_LIB = join(ROOT, 'cordis-host', 'plugins', 'ondra-core', 'lib', 'index.js')
const ORDER_LIB = join(ROOT, 'cordis-host', 'plugins', 'ondra-core', 'lib', 'order.js')

const failures = []
function check(label, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : `（${detail}）`}`)
  if (!ok) failures.push(label)
}

/* ---------------------------------------------------------------- *
 * 前置闸门：产物必须新于源码
 * ---------------------------------------------------------------- */

console.log('=== 前置闸门 · 产物新鲜度 ===')
if (!existsSync(CORE_LIB) || !existsSync(ORDER_LIB)) {
  console.log('  ✗ 核心产物不存在')
  console.log('  先执行：pnpm run build:host')
  process.exit(1)
}
const lag = statSync(CORE_SRC).mtimeMs - statSync(CORE_LIB).mtimeMs
check('核心产物新于源码', lag <= 2000, `源码超前 ${String(Math.round(lag))} ms`)
if (failures.length > 0) {
  console.log('')
  console.log('产物过期，排序结论不可信。先执行：pnpm run build:host')
  process.exit(1)
}

/* ---------------------------------------------------------------- *
 * 排一次真实的装载顺序
 * ---------------------------------------------------------------- */

const { members } = await import(CORE_LIB)
const { orderMembers } = await import(ORDER_LIB)

console.log('\n=== A 段 · 排序结果本身可靠 ===')

const ordered = orderMembers(members)
check('没有因环而排不出的成员', (ordered.unresolved ?? []).length === 0, JSON.stringify(ordered.unresolved ?? []))
check('排序结果覆盖全部成员', ordered.ordered.length === members.length, `${String(ordered.ordered.length)} / ${String(members.length)}`)

const position = new Map(ordered.ordered.map((member, index) => [member.id, index]))

/* ---------------------------------------------------------------- *
 * 逐个消费方核对
 * ---------------------------------------------------------------- */

console.log('\n=== B 段 · 每个取存储的成员都排在其提供方之后 ===')

/** 三个存储端口。判据只认这三个键：它们才是 `??` 链上的东西。 */
const STORE_KEYS = ['ondra-store-sqlite', 'ondra-store-memory', 'ondra-store-json']

/**
 * 一个成员是否在源码里取了某个存储键。
 * @param source 成员 `src/index.ts` 的全文。
 * @param key 存储键。
 */
function readsStore(source, key) {
  return source.includes(`ctx.get('${key}')`) || source.includes(`ctx.get("${key}")`)
}

let scanned = 0
const violations = []
for (const member of members) {
  const file = join(ROOT, 'cordis-host', 'plugins', member.id, 'src', 'index.ts')
  if (!existsSync(file)) continue
  scanned += 1
  const source = readFileSync(file, 'utf8')
  for (const key of STORE_KEYS) {
    if (key === member.id) continue
    if (!readsStore(source, key)) continue
    const mine = position.get(member.id)
    const theirs = position.get(key)
    // 提供方没进清单（未启用）时无从比较，跳过——那不是顺序问题。
    if (mine === undefined || theirs === undefined) continue
    if (mine < theirs) {
      violations.push(`${member.id}（第 ${String(mine)} 位）早于 ${key}（第 ${String(theirs)} 位）`)
    }
  }
}

check(`扫过 ${String(scanned)} 个成员的源码`, scanned > 0, '没扫到成员说明路径变了，判据失效')
check(
  '没有「取存储却排在其提供方之前」的成员',
  violations.length === 0,
  violations.length === 0 ? '零违规' : violations.join('；'),
)

/*
 * 下面两条是**具体到这一次修复**的锚点。
 *
 * 上一条判据是通例，能抓到任何新增的漏声明；但它有个盲区：若有人把
 * `ondra-store-memory` 整个从清单里删掉，通例会变成「提供方没进清单，
 * 跳过」，然后全绿——备用后端消失这件事就再也检查不到了。
 * 所以再钉两枚锚：备用后端确实在清单里，且真的排在 SQLite 之后
 * （它要读 SQLite 的状态，这条顺序是有意义的、不是随手写的）。
 */
console.log('\n=== C 段 · 备用后端仍在清单且位置符合设计 ===')
check('备用后端在清单里', position.has('ondra-store-memory'))
check(
  '备用后端排在 SQLite 之后（它要读 SQLite 状态）',
  position.get('ondra-store-memory') > position.get('ondra-store-sqlite'),
  `${String(position.get('ondra-store-memory'))} > ${String(position.get('ondra-store-sqlite'))}`,
)

/* ---------------------------------------------------------------- *
 * D 段 · 装配期同步取值的软依赖（第 12 轮新增）
 * ---------------------------------------------------------------- */

/*
 * 为什么只钉这四条、而不写一条通例。
 *
 * 通例可以写成「源码里出现 `ctx.get('X')` 就必须把 X 列进 `after`」，但实测
 * 会命中 **148 处**：里面绝大多数是 (a) 惰性取值器 `() => ctx.get(...)`
 * ——装载完成后自愈，不需要顺序；(b) `identity` / `config-schema` / `clock`
 * 这类只影响日志名前缀的良性降级。混在一起报 148 条等于没有判据。
 *
 * 所以这里只钉实测**真的造成永久降级**的十六条。它们的共同形状是：
 * `apply()` 里**同步**取值，取不到就把 `undefined` 定死进一个长生命周期对象，
 * 而且插件自己会打一行读起来像「已知限制」的 warn。
 *
 * 反向验证：把对应 `after` 里的那个键删掉并 build，本段立刻红 1 条。
 * （第 13 轮新增的三条只做了抽样反向验证：删 `oral` 的 `after` 后本段红 1 条；
 * 另两条同形、同一个提供方，不再逐条删。）
 *
 * 第 14 轮新增六条，其中三条是**新的失败形态**，值得单独记住：
 * `store-sqlite` 取不到路径是 `log.error` + **整库不注册**（静默灾难）；
 * `store-json` 取不到 `config-schema` 时用户的 `enabled` 根本进不来
 * （「设置页打开 / 服务没注册」的假开关）；`emotion-express` 取不到内核
 * 只让一行启动日志说谎（行为不变）——三种严重度都收进同一张表是对的，
 * 因为它们同一个根因。
 */
console.log('\n=== D 段 · 装配期同步取值的依赖必须排在提供方之后 ===')

const EAGER_PAIRS = [
  ['ondra-path-layout', 'ondra-log-zh', '日志目录同步解析，取不到整进程转仅内存（不落盘）'],
  ['ondra-path-layout', 'ondra-onboarding', '首启状态库同步构造，取不到就每次重启重新引导'],
  ['ondra-path-layout', 'ondra-lexicon', 'stored 判据在装配期读一次，取不到就谎报「重启要重新攒样本」'],
  ['ondra-prompt-inject', 'ondra-inject-dedupe', '装配期探测一次，取不到就打一行假的「begin() 恒 bypassed」'],
  ['ondra-emotion-express', 'ondra-oral', '装配期探测一次，取不到就打「表达档未装载」（实际取值是惰性函数）'],
  ['ondra-emotion-express', 'ondra-rhythm', '同上：装配期探测一次，取不到就打「表达档未装载」'],
  ['ondra-emotion-express', 'ondra-expression-decide', '装配期探测一次，取不到就说「此刻没有表达档」'],
  // 第 14 轮新增六条（三种严重度，同一个根因：声明与实现不一致）
  ['ondra-emotion-core', 'ondra-emotion-express', '启动日志同步 profileOf()，取不到就把「数值来源 出厂基线」写死'],
  ['ondra-rhythm', 'ondra-rhythm-typing', '装配期同步取值打 warn，取不到就谎报「节奏服务未装载」'],
  ['ondra-path-layout', 'ondra-store-sqlite', '同步取路径，取不到就 log.error 并拒绝注册（整库消失）'],
  ['ondra-config-schema', 'ondra-store-json', '用户层 enabled 只经 schema.resolve 进来，缺它就永远是出厂 false'],
  ['ondra-store-memory', 'ondra-memory-vector', '三后端同步取值后传进构造函数，取不到就定死成「仅内存」'],
  ['ondra-store-json', 'ondra-memory-vector', '同上（第三个后端）'],
  ['ondra-emotion-express', 'ondra-emotion-project', '装配期 stats() 快照一次，取不到就谎报「投影一律不可用」'],
  // 第 14 轮第二批（分诊 B/A 组补报，同一个根因）
  ['ondra-memory-graph', 'ondra-memory-humanlike', '装配期同步取值，取不到就定死 graphAvailable=false（荒诞分支建不了边）'],
  ['ondra-evidence-gate', 'ondra-multimodal-memory', '装配期同步取值，取不到就报「入库不过证据闸」（实测只差 12ms）'],
]

for (const [provider, consumer, why] of EAGER_PAIRS) {
  const mine = position.get(consumer)
  const theirs = position.get(provider)
  check(
    `${consumer} 排在 ${provider} 之后（${why}）`,
    mine !== undefined && theirs !== undefined && mine > theirs,
    mine === undefined ? `${consumer} 不在清单里` : `${String(mine)} > ${String(theirs)}`,
  )
}

console.log('')
if (failures.length === 0) {
  console.log('全部通过。')
} else {
  console.log(`${String(failures.length)} 条未通过：`)
  for (const item of failures) console.log(`  - ${item}`)
}
process.exit(failures.length === 0 ? 0 : 1)
