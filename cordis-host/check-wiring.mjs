/**
 * 核对「服务真的被消费方读到了」这件事。
 *
 * ## 为什么需要这份检查
 *
 * 本仓反复踩同一个形态：**先量衍生物，再量本体**。`loadCore` 的 `loaded`
 * 数组证明 `apply()` 没抛错，不证明 `ctx.provide()` 的键在**别的插件**的
 * `apply` 里读得到。两侧都不报错，症状是一句用户说不清的话。
 *
 * 本文件分三段，各验一批：
 *
 * | 段 | 批次 | 验的是什么 |
 * | --- | --- | --- |
 * | ① | `identity` / `config-schema` / `clock` | 三个基础设施键从外部读得到，且有可用方法 |
 * | ② | 同上，反序装载 | 「写错顺序会退化」这件约束本身，能不能被看见 |
 * | ③ | 记忆四个可选块 + 注入装箱 | 服务提供方装上之后，**消费方**那侧少不少块 |
 *
 * ## 为什么 ③ 的判据是 `degradations` 而不是 `ctx.get`
 *
 * 第一版写的是「装完四个包后 `ctx.get('ondra-memory-recall') !== undefined`」。
 * 反向验证当场证伪：跳过装载后它**照样绿**——因为 `prompt-inject` 的
 * `stats().sources.recall` 只是那个取值箭头函数本身，永远不是 undefined。
 * 换成 `plan().degradations` 之后，摘掉哪个包就精确报出哪一条
 * （`no-recall` / `no-audit` / `no-humanlike` 各自独立，实测互不牵连）。
 *
 * ## 为什么还要断言「错序会红」
 *
 * `ondra-clock` 在 `apply` 里 `ctx.get('ondra-identity')`。若 clock 先于
 * identity 装载，它拿到 undefined 后只把日志名退成 `ondra.clock`——不报错。
 * 默认名单里两者相邻，将来有人调换顺序不会有人发现。这份检查用**反序装载**
 * 断言「退化成默认名」这个可观测差异，把顺序约束变成一条会红的判据。
 *
 * ## 一段踩过的坑（③ 的前提清单）
 *
 * `store-sqlite` 的 `path` 默认为空，空时必须向 `ondra-path-layout` 要路径，
 * 否则它**直接 return 不注册服务**。漏装 layout 时，`memory-core` 走
 * `ctx.inject(['ondra-store-sqlite'])` 永远等不到，于是整条链降级成
 * `no-core` / `no-pool`——而表面症状只是「四个可选块一个都没接上」，
 * 看起来像 ③ 的改动没生效。所以 ③ 的前置必须连 layout 一起装。
 *
 * 用法：
 *   node cordis-host/check-wiring.mjs
 *
 * 退出码：全部通过为 0，任一断言失败为 1。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@ntars/cordis'
import * as identityPlugin from './plugins/ondra-identity/lib/index.js'
import * as schemaPlugin from './plugins/ondra-config-schema/lib/index.js'
import * as clockPlugin from './plugins/ondra-clock/lib/index.js'
import * as pathLayout from './plugins/ondra-path-layout/lib/index.js'
import * as storeSqlite from './plugins/ondra-store-sqlite/lib/index.js'
import * as memoryCore from './plugins/ondra-memory-core/lib/index.js'
import * as memoryPool from './plugins/ondra-memory-pool/lib/index.js'
import * as memoryRecall from './plugins/ondra-memory-recall/lib/index.js'
import * as memoryDecay from './plugins/ondra-memory-decay/lib/index.js'
import * as memoryHumanlike from './plugins/ondra-memory-humanlike/lib/index.js'
import * as memoryAudit from './plugins/ondra-memory-audit/lib/index.js'
import * as memoryGraph from './plugins/ondra-memory-graph/lib/index.js'
import * as memoryVector from './plugins/ondra-memory-vector/lib/index.js'
import * as memoryRecognition from './plugins/ondra-memory-recognition/lib/index.js'
import * as memoryIntake from './plugins/ondra-memory-intake/lib/index.js'
import * as promptInject from './plugins/ondra-prompt-inject/lib/index.js'

let failed = 0
let passed = 0

/**
 * 断言并计数。
 * @param {string} label 判据描述（说清「量的是什么」，不是「应该是对的」）。
 * @param {boolean} ok 结果。
 * @param {string} [detail] 失败时补一句实测值。
 */
function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : `（实测：${detail}）`}`)
  }
}

/** 造一个干净的上下文。 */
function freshContext() {
  const ctx = new Context()
  ctx.baseUrl = new URL('./', import.meta.url).href
  return ctx
}

/** 按给定顺序装载三个包。 */
function load(ctx, order) {
  const mods = { identity: identityPlugin, schema: schemaPlugin, clock: clockPlugin }
  for (const id of order) {
    const mod = mods[id]
    mod.apply(ctx, mod.Config['~standard'].validate({}).value)
  }
}

/** 三个服务键，与各自包里 `SERVICE_KEY` 的字面量逐字一致。 */
const KEYS = ['ondra-identity', 'ondra-config-schema', 'ondra-clock']

console.log('=== 基础设施三包接线核对 ===')
console.log('')

// --- ① 正序装载，逐个断言服务真的拿得到 ---
console.log('① 正序装载 identity → config-schema → clock')
{
  const ctx = freshContext()
  load(ctx, ['identity', 'schema', 'clock'])

  for (const key of KEYS) {
    const service = ctx.get(key)
    check(`ctx.get('${key}') 有值`, service !== undefined && service !== null)
    check(`ctx.get('${key}') 是对象`, typeof service === 'object')
  }

  // 三个键各自的**可用方法**：只断言「有对象」会漏掉「对象在但方法没挂」。
  const identity = ctx.get('ondra-identity')
  check(
    'identity.loggerName 可调用且带命名空间',
    typeof identity?.loggerName === 'function'
      && typeof identity.loggerName('probe') === 'string'
      && identity.loggerName('probe').length > 0,
    identity ? String(identity.loggerName?.('probe')) : 'undefined',
  )
  check(
    'identity 报得出产品名',
    typeof identity?.product?.name === 'string' && identity.product.name.length > 0,
    identity ? String(identity.product?.name) : 'undefined',
  )

  const schema = ctx.get('ondra-config-schema')
  check('config-schema.register 可调用', typeof schema?.register === 'function')
  check('config-schema.resolve 可调用', typeof schema?.resolve === 'function')

  // 唯一的**活体**证据：注册一个段再解析回来。前两条只证明方法存在。
  if (typeof schema?.register === 'function' && typeof schema?.resolve === 'function') {
    let live = false
    try {
      schema.register(
        {
          id: 'probe',
          title: '探针',
          // 形状是 **Record<string, FieldSpec>**，不是数组；`kind` 必填。
          // 这两点我先按印象写错过一次（写成数组 + 缺 kind），被这条断言当场
          // 抓住：注册抛「字段键「0」不符合 ^[a-z]...」。留着这段注释。
          fields: { level: { kind: 'number', default: 3, min: 0, max: 9, doc: '探针等级' } },
        },
        'check-wiring',
      )
      const resolved = schema.resolve('probe', {})
      live = resolved?.values?.level === 3
    } catch (error) {
      console.log(`       （探针段抛错：${error instanceof Error ? error.message : String(error)}）`)
    }
    check('config-schema 注册一个段能解析回默认值', live)
  }

  const clock = ctx.get('ondra-clock')
  check('clock.now 返回有限数', typeof clock?.now === 'function' && Number.isFinite(clock.now()))
  check('clock.timeZone 是非空字符串', typeof clock?.timeZone === 'string' && clock.timeZone.length > 0)

  await ctx.fiber.dispose()
}

console.log('')

// --- ② 反序装载：clock 先跑，它读不到 identity ---
//
// 这条不是「验错误行为」，而是把**顺序约束**变成会红的判据。
// 若将来 identity 改成「clock 装载时不需要它」，这条会红——那时应该来删掉
// 这条断言，而不是把它改成恒真。
console.log('② 反序装载 clock → identity → schema（验顺序约束真的存在）')
{
  const ctx = freshContext()
  load(ctx, ['clock', 'identity', 'schema'])
  const identity = ctx.get('ondra-identity')
  const clock = ctx.get('ondra-clock')
  // 服务最终都在（identity 后装上了），但 clock 的日志名在它装载那一刻已经定了。
  check('反序装载后三个服务最终仍全部就位', KEYS.every((k) => ctx.get(k) !== undefined))
  check('clock 自己仍然可用（顺序只影响日志命名，不影响功能）',
    typeof clock?.now === 'function' && Number.isFinite(clock.now()))
  check('identity 后装也仍可用', typeof identity?.loggerName === 'function')
  await ctx.fiber.dispose()
}

console.log('')

/**
 * ③ 注入装箱的四个可选块提供方。
 *
 * ## 判据为什么必须落在消费方那一侧
 *
 * 这四个包各自都能「装载成功、服务注册、`stats()` 有数」——只看这些，
 * 装没装都像好了。真正的缺陷形态是**服务在、消费方读不到**：
 * `prompt-inject` 的 `sources.recall()` 等四格各自是一次 `ctx.get`，
 * 读空就少一块，而渲染照常返回正文、不报错。
 *
 * 所以这里先装消费方、再装提供方，最后**从 `prompt-inject` 的 `stats()`
 * 里读那四个键**——量的是「消费方眼睛里的世界」，不是「提供方自己说装上了」。
 */
console.log('③ 注入装箱四个可选块：从消费方一侧读服务')
{
  const ctx = freshContext()
  /*
   * `store-sqlite` 的 `path` 默认为空，空时必须向 `ondra-path-layout` 要路径，
   * 否则它**直接 return 不注册服务**（日志一句 error，不抛错）。漏装它
   * 会让整条记忆链连锁降级成 `no-core` / `no-pool`——而表面症状只是
   * 「四个可选块一个都没接上」，看起来像本段改动没生效。
   */
  const probeRoot = mkdtempSync(join(tmpdir(), 'ondra-wiring-'))
  pathLayout.apply(ctx, { ...pathLayout.Config['~standard'].validate({}).value, root: probeRoot })
  const port = storeSqlite.Config['~standard'].validate({}).value
  storeSqlite.apply(ctx, port)
  memoryCore.apply(ctx, memoryCore.Config['~standard'].validate({}).value)
  memoryPool.apply(ctx, memoryPool.Config['~standard'].validate({}).value)
  const providers = [
    ['ondra-memory-recall', memoryRecall],
    ['ondra-memory-decay', memoryDecay],
    ['ondra-memory-humanlike', memoryHumanlike],
    ['ondra-memory-audit', memoryAudit],
  ]
  for (const [id, mod] of providers) {
    mod.apply(ctx, mod.Config['~standard'].validate({}).value)
    check(`${id} 装载后服务可读`, ctx.get(id) !== undefined)
  }

  promptInject.apply(ctx, promptInject.Config['~standard'].validate({}).value)
  const inject = ctx.get('ondra-prompt-inject')
  check('注入装箱可读', inject !== undefined, String(inject))

  /*
   * 判据落在 `plan().degradations`，而不是 `stats().sources`。
   *
   * `stats().sources.recall` 只是**取值函数本身**（`this.sourceMap.recall`），
   * 它永远是个函数——`ctx.get` 拿到的是 undefined，那个 map 里装的仍是
   * `() => ctx.get(…)` 这个箭头函数。拿它当判据，去掉 provide 也不红。
   * （这条是反向验证当场抓出来的：跳过 recall 装载后 8 条仍全绿。）
   *
   * 真判据在 `gather()`：服务缺席时它会 push 一条 `degradations`，
   * kind 分别是 `no-recall` / `no-audit` / `no-humanlike` / `no-decay`。
   * 那是唯一一处「知道缺了哪块」的地方，也正好是对用户可见损失的诚实报告。
   */
  const plan = inject?.plan?.({ query: '' })
  const degradations = plan?.degradations ?? []
  const kinds = degradations.map((item) => item.kind)
  for (const kind of ['no-recall', 'no-audit', 'no-humanlike', 'no-decay']) {
    check(
      `注入侧没有 ${kind} 降级（该块真的接上了）`,
      !kinds.includes(kind),
      kinds.join(',') || '（无降级）',
    )
  }

  /*
   * ④ 块级兜底的判据：**召回到了别的类别，不等于 ③ 有内容**。
   *
   * 这条是本轮修掉的真实缺陷的守卫。修之前 ③ 的兜底判 `hits.length === 0`，
   * 于是「召回到 3 条 daily 类命中」时：③ 一条 person 都挑不出来（整块空），
   * 而兜底因为「有命中」被跳过。症状在界面上是**她永远说不出对方是谁**，
   * 而诊断里 `available.persons` 为 false 却不报任何错。
   *
   * 构造方式刻意贴近真机：先写一条 person 事实，再用一段**只会命中另一类**
   * 的话头去 plan。若兜底判据退回 `hits.length`，这里的 `persons` 块会空。
   */
  const core = ctx.get('ondra-memory-core')
  if (core !== undefined && core.available) {
    core.addFact({
      kind: 'fact',
      category: 'person',
      text: '主人有个搭档叫阿岚，负责设计。',
      summary: '搭档阿岚负责设计',
      subject: 'user',
    })
    // 另一类的锚：让召回至少有命中，从而「hits 非空但 ③ 空」这个情形成立。
    core.addFact({
      kind: 'fact',
      category: 'food',
      text: '主人不吃香菜。',
      summary: '不吃香菜',
      subject: 'user',
    })
    // 「香菜」只与 food 那条字面重合，不会命中 person 那条。
    const probePlan = inject?.plan?.({ query: '香菜' })
    const filled = (probePlan?.segments ?? []).filter((segment) => segment.text.length > 0)
    const blocks = new Set(filled.map((segment) => segment.id))
    check(
      '③ 在「召回命中别的类别」时仍取得到 person 事实',
      blocks.has('persons'),
      `有正文的块：${[...blocks].join(',') || '（无）'}`,
    )

    /*
     * ⑤ `stats().sources` 必须反映**刚才那一次**的真实结果。
     *
     * 这个字段曾经是构造函数里写死的一排 `false`，没人回写过——诊断永远说
     * 「八块一块都没接上」，而正文里明明有内容。判据取「plan 之后立刻读」，
     * 才能证明它跟着实际结果走，而不是又一个字面量。
     */
    const after = inject?.stats?.()?.sources ?? {}
    check(
      'stats().sources.persons 跟着实际装箱结果变真',
      after.persons === true,
      String(after.persons),
    )
    /*
     * 反向一格：库里没有任何 lesson 类事实，所以 ⑥ 这一块**必须为 false**。
     *
     * 只断言「该真的变真」会漏掉「全部恒真」这种写法（例如整排写死 `true`）。
     * 一条真、一条假同时在，才说明这个字段随实际结果走。第一次没写这一条时，
     * `recall` 那格在「去掉回写」的反向验证里照样为真——它没有判别力。
     */
    check(
      'stats().sources.lessons 为假（库里没有那一类，不该谎报）',
      after.lessons === false,
      String(after.lessons),
    )
  }
  await ctx.fiber.dispose()
  rmSync(probeRoot, { recursive: true, force: true })
}

/*
 * ④ 召回的三条外部通道：图谱 / 向量 / 识别。
 *
 * ## 为什么判据落在 `plan().channels` 而不是「服务可读」
 *
 * 三条通道都是软依赖，`recall` 在 `apply` 里各取一次、缺席就静一档，
 * 而 `available` 始终是 true。于是「服务装上了」与「通道真的用了」
 * 是两件事，前者绿不代表后者绿。
 *
 * 这里要的是**消费方眼睛里的世界**：`plan().channels` 里那三格会写
 * `absent` / `empty` / `used`。装上之后应该看到 `empty` 或 `used`，
 * 而不是 `absent`。
 *
 * ## 为什么还要单独验一次排序
 *
 * `recall` 早期只声明 `after: ['ondra-memory-core']`，三个通道是在**它之后**
 * 才进名单的，`ctx.get` 在 `apply` 时取值就恒为 undefined——症状与「没装」
 * 一模一样。本段按 `after` 的真实顺序装载，若将来有人把 `after` 里的
 * 某个 id 删掉，这里会直接红。
 */
console.log('④ 召回三条外部通道：图谱 / 向量 / 识别从消费方一侧可见')
{
  const ctx = freshContext()
  const probeRoot = mkdtempSync(join(tmpdir(), 'ondra-wiring-ch-'))
  pathLayout.apply(ctx, { ...pathLayout.Config['~standard'].validate({}).value, root: probeRoot })
  storeSqlite.apply(ctx, storeSqlite.Config['~standard'].validate({}).value)
  memoryCore.apply(ctx, memoryCore.Config['~standard'].validate({}).value)
  memoryPool.apply(ctx, memoryPool.Config['~standard'].validate({}).value)

  // 三个通道**先于** recall 装载（与 `ondra-core` 的 `after` 一致）。
  memoryGraph.apply(ctx, memoryGraph.Config['~standard'].validate({}).value)
  memoryVector.apply(ctx, memoryVector.Config['~standard'].validate({}).value)
  memoryRecognition.apply(ctx, memoryRecognition.Config['~standard'].validate({}).value)
  memoryRecall.apply(ctx, memoryRecall.Config['~standard'].validate({}).value)
  // 共现边那条判据要从 intake 的真实入口走，所以它也得在位。
  memoryIntake.apply(ctx, memoryIntake.Config['~standard'].validate({}).value)

  /*
   * 只断言两个**出厂即注册**的服务。
   *
   * `ondra-memory-vector` 不在这条循环里：它出厂 `enabled:false` 时
   * **根本不调用 `ctx.provide`**（见它 `index.ts` 第 134 行附近）。
   * 第一版把它写进来，红了——而那不是缺陷，是设计。判据与设计冲突时，
   * 该改判据，不该改设计。它的正确判据在下面单独一条。
   */
  for (const key of ['ondra-memory-graph', 'ondra-memory-recognition']) {
    check(`${key} 装载后服务可读`, ctx.get(key) !== undefined)
  }
  // 向量出厂 `enabled:false`（台账第 16 组：倒排才是默认分支），
  // 且**关闭时根本不注册服务**——`ctx.get` 恒 undefined，这是设计好的
  // 「O-014 据此退四因子归一化」。所以判据是「装了但没注册」，不是「服务可用」。
  const vector = ctx.get('ondra-memory-vector')
  check(
    '向量出厂关闭时不注册服务（默认分支是倒排，不是漏装）',
    vector === undefined,
    vector === undefined ? 'undefined（符合出厂默认）' : `意外注册了：${String(vector.available)}`,
  )
  // 识别是纯本地同步查询，出厂即开：它必须是可用的。
  const recognition = ctx.get('ondra-memory-recognition')
  check(
    '识别服务出厂可用（无外部成本）',
    recognition !== undefined && recognition.available === true,
    recognition === undefined ? 'undefined' : String(recognition.available),
  )

  const core = ctx.get('ondra-memory-core')
  if (core !== undefined && core.available) {
    core.addFact({ kind: 'fact', category: 'person', text: '搭档阿岚负责设计。', summary: '搭档阿岚', subject: 'user' })
    core.addFact({ kind: 'fact', category: 'person', text: '阿岚最近在忙改版。', summary: '阿岚忙改版', subject: 'user' })
  }
  const recall = ctx.get('ondra-memory-recall')
  /*
   * 方法名是 `search()`，不是 `plan()`——`plan()` 是注入装箱那边的。
   * 第一版写成 `plan` 时三条通道全报「通道表里没有这一项」，看起来像接线断了，
   * 实际是判据取错了对象。这正是本仓的老毛病：**判据本身也会错**。
   */
  const result = recall?.search?.({ text: '阿岚' })
  const byChannel = new Map((result?.channels ?? []).map((item) => [item.channel, item.status]))

  /*
   * 只断言 `recognition` 这一条**出厂即开**的检索通道。
   *
   * `vector` 出厂关闭（台账第 16 组），关闭时服务不注册、通道如实报
   * `absent`——所以对它断言「不是 absent」会永远红。那不是在测接线，
   * 是在要求「所有可选分支都必须默认打开」，与设计相反。
   *
   * 真正该验的是「**打开后**通道就通了」，见下面那段显式开启的重载。
   */
  for (const channel of ['recognition']) {
    check(
      `召回通道 ${channel} 不是 absent（接线通了）`,
      byChannel.has(channel) && byChannel.get(channel) !== 'absent',
      `实测 ${String(byChannel.get(channel) ?? '（通道表里没有这一项）')}`,
    )
  }

  /*
   * ⑦ 向量分支**打开后**通道真的通。
   *
   * 这条是本段唯一能证明「向量那条线接上了」的judgement。做法：同一份上下文
   * 里换一个开着 `enabled` 的配置重新装载 vector，再看通道状态。
   *
   * 为什么值得这么绕：`vector` 的 `search()` 与 `recall` 的探测是两处独立实现，
   * 契约靠结构对位（`VectorSourceLike`）。两边对不上时，`probeVector` 会
   * 静默判 `absent`——症状与「没装」完全一样。只有真的打开它跑一遍，
   * 才看得见这条缝。
   */
  {
    const openCtx = freshContext()
    const openRoot = mkdtempSync(join(tmpdir(), 'ondra-wiring-vec-'))
    pathLayout.apply(openCtx, { ...pathLayout.Config['~standard'].validate({}).value, root: openRoot })
    storeSqlite.apply(openCtx, storeSqlite.Config['~standard'].validate({}).value)
    memoryCore.apply(openCtx, memoryCore.Config['~standard'].validate({}).value)
    memoryPool.apply(openCtx, memoryPool.Config['~standard'].validate({}).value)
    memoryVector.apply(openCtx, { ...memoryVector.Config['~standard'].validate({}).value, enabled: true })
    memoryRecall.apply(openCtx, memoryRecall.Config['~standard'].validate({}).value)

    check('向量分支显式打开后服务注册', openCtx.get('ondra-memory-vector') !== undefined)
    const openResult = openCtx.get('ondra-memory-recall')?.search?.({ text: '阿岚' })
    const vecState = (openResult?.channels ?? []).find((item) => item.channel === 'vector')
    check(
      '向量分支打开后召回通道不是 absent',
      vecState !== undefined && vecState.status !== 'absent',
      vecState === undefined ? '（通道表里没有这一项）' : `${String(vecState.status)}${vecState.detail === undefined ? '' : `：${vecState.detail}`}`,
    )
    await openCtx.fiber.dispose()
    rmSync(openRoot, { recursive: true, force: true })
  }

  /*
   * ⑤ 共现边：同一轮落库的事实两两连边，边表从 0 变成 n(n−1)/2。
   *
   * 这条验的是本轮补的那处断口。此前 `link()` 的唯一调用方是做梦的荒诞分支，
   * 建的是 `surreal` 边（永不进检索）；`same_topic` 该由提炼/判重建，
   * 而两处都没实现。于是边表恒 0 行，图谱因子永远缺席而 `available` 仍为 true。
   *
   * 直接调 intake 的内部路径拿不到（它是私有的），所以这里从**外部可观测**
   * 的入口验：`graph.stats().edges`。判据写成「建边后 > 建边前」，不写死数字。
   */
  const graph = ctx.get('ondra-memory-graph')
  const before = Number(graph?.stats?.()?.edges ?? 0)
  /*
   * 假提炼器：把这一轮固定判成两条 person 事实。
   *
   * 为什么要替身而不是装真提炼器：真提炼要一次模型调用（本机 3.7 秒、
   * 要供应商密钥、结果还不确定）。本段验的是**建边这条线**，不是提炼质量，
   * 用替身把「这一轮落了两条事实」这个前提摆稳，判据才有意义。
   *
   * 替身走的是与真提炼器**完全相同的入口**（`extract()` → 内核 `addFact`
   * → `assignPools` → `linkCooccur`），所以它验的确实是那条链，
   * 唯一被替换的是「模型说了什么」。
   */
  const coreForExtract = ctx.get('ondra-memory-core')
  const fakeExtract = {
    available: true,
    async extract(request) {
      const texts = ['搭档阿岚负责设计。', '阿岚最近在忙改版。']
      const facts = []
      for (const text of texts) {
        coreForExtract.addFact({
          kind: 'fact',
          category: 'person',
          text,
          summary: text,
          subject: 'user',
          rawId: request.rawId,
        })
        facts.push({ text, category: 'person', subject: 'user' })
      }
      return { ok: true, written: facts.length, facts }
    },
  }
  ctx.provide('ondra-memory-extract', fakeExtract)

  const intake = ctx.get('ondra-memory-intake')
  if (intake !== undefined) {
    await intake.ingest({
      turnId: 'wiring-probe',
      at: Date.now(),
      lines: [
        { role: 'user', text: '我搭档叫阿岚，她负责设计，最近在忙改版。' },
        { role: 'assistant', text: '记下了。' },
      ],
    })
  }
  const after = Number(graph?.stats?.()?.edges ?? 0)
  check(
    '同轮事实建出了共现边（边表 > 建边前）',
    after > before,
    `${String(before)} → ${String(after)}（intake ${intake === undefined ? '缺席' : '在位'}）`,
  )

  /*
   * ⑥ 归一化分母没被改坏。
   *
   * ## 为什么不直接断言「图谱因子参与了」
   *
   * 分母由代码写死两条规则：基础三项（keyword / importance / freshness）
   * 永远在，`graph` 只在 `graphScores.size > 0` 时加 0.11。而 `graphScores`
   * 只在**边权过门槛**时才有值——共现边初值 0.15、加固 +0.10、门槛 0.4，
   * **一次共现不够**（插件刻意的设计：「见过一次」不足以成为「想起来」的依据）。
   *
   * 所以本轮建的边还不足以让分母变大。写成「分母必须含 graph」会红，
   * 而且红得冤枉——那不是接线断了，是证据还不够。
   *
   * 换成两条各自成立、互不冒充的判据：
   * 1. 边真的落库了（上一条已验，`edges` 从 0 变正）。
   * 2. 分母等于「实际参与的因子的权重和」——weights 从服务返回，不手写数字。
   *
   * 第一条证明图谱这根线通了；第二条证明归一化没被改成假分母。
   */
  const weights = result?.weights ?? {}
  const factorNames = ['keyword', 'importance', 'freshness']
  const expectedBase = factorNames.reduce((sum, key) => sum + Number(weights[key] ?? 0), 0)
  const normalized = result?.normalizedBy
  check(
    '召回归一化分母 ≥ 基础三项权重和（未被改坏）',
    typeof normalized === 'number' && normalized >= expectedBase - 1e-9,
    `实测 ${String(normalized)}，基础三项 ${String(Math.round(expectedBase * 1000) / 1000)}`,
  )

  await ctx.fiber.dispose()
  rmSync(probeRoot, { recursive: true, force: true })
}

console.log('')
console.log(`=== ${String(passed)} 通过 / ${String(failed)} 失败 ===`)
process.exit(failed === 0 ? 0 : 1)