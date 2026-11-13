/**
 * 召回侧的「已沉底」开关：设置页那一格与请求参数那一格，必须都算数。
 *
 * ## 这个脚本要钉住的一条
 *
 * ```
 * 配置 includeArchived = true，请求不传    → 沉底的那条要进候选
 * 配置 includeArchived = false，请求不传   → 沉底的那条不进（出厂行为）
 * 配置 = true，请求显式传 false            → 请求优先，不进（单轮覆盖）
 * 配置 = false，请求显式传 true            → 请求优先，进
 * ```
 *
 * ## 为什么需要它
 *
 * `ondra-memory-recall` 有一格 `includeArchived`（默认关）摆在设置页上，
 * 文案写「是否把已沉底的记忆纳入候选」。而第 19 轮核实：`settings.ts` 之外
 * 读的一直是 `request.includeArchived`，**配置那一格从来没有被读过一行**。
 * 于是用户打开它、重启、再去问沉底的事，答案一模一样——一个不报错、
 * 日志照实、界面照显示、行为不变的假开关。
 *
 * 本仓这类失效有个共同形态：判据存在、服务正常、中间那根线没接。
 * 第 2 轮 TTS、第 5 轮旁路、第 6 轮 intake 开关都是同一个形状，
 * 所以这里不验「字段名在源码里出现过」（那太宽，`request.includeArchived`
 * 就能骗过它），而是**直接构造真仓库、喂真请求、看真结果**。
 *
 * ## 为什么能只造一个假内核
 *
 * `RecallRepository` 是导出的类，构造函数只吃 `core / graph / vector /
 * recognition / settings / log / now` 七样。图谱与向量分支传 `undefined`
 * 即可——它们缺席是插件明写的正常情形（从因子表里退出去）。内核用一个
 * 只有一条沉底事实的假对象，`listFacts` 原样返回它。
 *
 * 断言取「结果里有没有那条 id」，不取任何自报计数：自报说「我展开了」
 * 和真的展开是两件事。
 *
 * 用法：node tools/check-recall-archived.mjs
 * 退出码：全部通过为 0。
 */

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const RECALL = join(ROOT, 'cordis-host', 'plugins', 'ondra-memory-recall')
const SOURCE = join(RECALL, 'src', 'service.ts')
const ARTIFACT = join(RECALL, 'lib', 'service.js')

let failed = 0
let index = 0

function check(label, ok, detail) {
  index += 1
  if (ok) {
    console.log(`  ✓ ${label}${detail === undefined ? '' : `（${detail}）`}`)
    return
  }
  failed += 1
  console.log(`  ✗ ${label}${detail === undefined ? '' : ` —— ${detail}`}`)
}

/* ---------------------------------------------------------------- *
 * 前置闸门：产物必须新于源码
 *
 * `lib/` 是构建产物，改 `src` 不 build 就跑这个脚本，等于验的是旧代码。
 * 第 5 轮踩过这个坑（`check:voice` 验了半小时前的产物）。
 * ---------------------------------------------------------------- */

console.log('=== 召回 · 沉底开关的四个通道 ===')

if (!existsSync(ARTIFACT)) {
  console.log(`  ✗ 产物不存在（${ARTIFACT}）——先跑 pnpm run build:plugins`)
  process.exit(1)
}
if (statSync(SOURCE).mtimeMs > statSync(ARTIFACT).mtimeMs + 1000) {
  console.log(`  ✗ 产物旧于源码（${ARTIFACT}）——先跑 pnpm run build:plugins`)
  process.exit(1)
}

const { RecallRepository } = await import(ARTIFACT)

/* ---------------------------------------------------------------- *
 * 造一条沉底事实 + 一个假内核
 * ---------------------------------------------------------------- */

const ARCHIVED_ID = 'fact-archived-1'
const HOUR = 3_600_000
const NOW = 1_790_000_000_000

const archivedRecord = {
  id: ARCHIVED_ID,
  kind: 'fact',
  category: 'place',
  channel: 'chat',
  text: '备用钥匙放在衣柜最上层那个铁盒里',
  summary: '备用钥匙的位置',
  subject: 'user',
  salience: 60,
  arousal: 0.4,
  stabilityHours: 100,
  timesSaid: 2,
  hits: 1,
  createdAt: NOW - 240 * HOUR,
  lastSeenAt: NOW - 240 * HOUR,
  lastHitAt: null,
  archived: true,
  sealed: false,
  important: false,
}

const fakeCore = {
  available: true,
  listFacts: () => [archivedRecord],
  countFacts: () => 1,
  getFact: id => (id === ARCHIVED_ID ? archivedRecord : undefined),
}

/** 造一份配置。只覆盖本脚本用得到的键，其余取 settings 模块的默认值。 */
const settingsModule = await import(join(RECALL, 'lib', 'settings.js'))
const baseConfig = settingsModule.DEFAULT_CONFIG ?? settingsModule.defaultsOf?.() ?? {}

function configWith(includeArchived) {
  return { ...baseConfig, includeArchived }
}

const silentLog = { debug() {}, info() {}, warn() {}, error() {} }

function repoWith(includeArchived) {
  return new RecallRepository(fakeCore, undefined, undefined, undefined, configWith(includeArchived), silentLog, () => NOW)
}

/** 跑一次召回，返回命中 id 列表。 */
function searchIds(repo, request) {
  const result = repo.search({ text: '备用钥匙放在哪', at: NOW, ...request })
  return (result.hits ?? []).map(hit => hit.id)
}

/* ---------------------------------------------------------------- *
 * 四段断言
 * ---------------------------------------------------------------- */

// 1. 出厂配置（false）+ 请求不传 → 不展开。这是「什么都没改」的基准。
{
  const ids = searchIds(repoWith(false), {})
  check('配置 false、请求不传：沉底那条不参与', !ids.includes(ARCHIVED_ID), `hits=${JSON.stringify(ids)}`)
}

// 2. **本轮修的那条**：配置 true + 请求不传 → 必须展开。
//    修复前这里恒为空——配置那一格根本没人读。
{
  const ids = searchIds(repoWith(true), {})
  check('配置 true、请求不传：沉底那条进候选（配置真的生效）', ids.includes(ARCHIVED_ID), `hits=${JSON.stringify(ids)}`)
}

// 3. 请求显式 false 压过配置 true。`false` 是显式值，不能被配置翻回来。
{
  const ids = searchIds(repoWith(true), { includeArchived: false })
  check('配置 true、请求显式 false：请求优先，不展开', !ids.includes(ARCHIVED_ID), `hits=${JSON.stringify(ids)}`)
}

// 4. 请求显式 true 压过配置 false。单轮覆盖两个方向都要能走。
{
  const ids = searchIds(repoWith(false), { includeArchived: true })
  check('配置 false、请求显式 true：请求优先，展开', ids.includes(ARCHIVED_ID), `hits=${JSON.stringify(ids)}`)
}

// 5. `explain()` 走的是另一处判定，容易漏改——单独钉一次。
//    它是「这条为什么没被想起」的答案来源，两处判定不一致会让解释说谎。
{
  const repo = repoWith(true)
  const explained = repo.explain(ARCHIVED_ID, { text: '备用钥匙放在哪', at: NOW })
  check('explain() 与 search() 用同一套判据（配置 true 时说「在候选里」）', explained.found === true, `found=${String(explained.found)} reason=${String(explained.reason)}`)
}

/* ---------------------------------------------------------------- *
 * 汇总
 * ---------------------------------------------------------------- */

if (failed === 0) {
  console.log(`\n合计：${index}/${index} 通过`)
  process.exit(0)
}
console.log(`\n合计：${index - failed}/${index} 通过，${failed} 条红`)
process.exit(1)
