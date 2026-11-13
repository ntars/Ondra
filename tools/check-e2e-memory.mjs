/**
 * 记忆提炼链端到端：从「用户说一句关于自己的话」到「`memory_fact` 里有那一行」。
 *
 * ## 这个脚本要证明的唯一一件事
 *
 * ```
 * 用户说「我叫小玖，住在杭州」
 *   → 原文进 memory_raw            （早已通）
 *   → 提炼器被真的调用一次          ← 此前一次都没被调用过
 *   → 模型返回两条带引文的事实
 *   → 校验通过、写进 memory_fact    ← 从建库起一直是 0 行
 * ```
 *
 * ## 为什么它必须是端到端，不能是单元级
 *
 * 这条链上有**五个**独立环节，每一个都有「没接上就静默降级」的设计：
 *
 * | 环节 | 断掉时的表现 |
 * | --- | --- |
 * | `ondra-llm-gateway` 进默认名单 | 提炼器 `ctx.get` 拿不到 → `no-gateway` |
 * | `ctx.get('llm')` 有注册方 | 网关 `available` 恒 false → `gateway-unavailable` |
 * | 网关 `sources` 非空 | `no-source` |
 * | `sources[].model` 填的是供应商 id | 「模型不存在：…」→ `upstream` |
 * | `ondra-memory-extract` 进默认名单 | 提炼器根本不存在 → `no-service` |
 *
 * 五处**全都不报错**。它们的共同症状是同一个：`memory_raw` 有数，
 * `memory_fact` 是 0。所以断言必须从最外层打进去、再从库文件读结果——
 * 任何一层用自己的 `stats()` 自证都会给出「我是好的」。
 *
 * ## 为什么伪造上游而不连真模型
 *
 * 会让这条检查依赖网络、密钥与钱，而它要验的是**接线**，不是模型质量。
 * 假上游只回一段固定 JSON，恰好覆盖「提炼 → 校验 → 写库」三段：
 * 两条事实各带一条逐字引文（引文必须能在用户原话里找到，否则被
 * `verify.ts` 的引文闸拦掉）。
 *
 * 用法：node tools/check-e2e-memory.mjs
 * 退出码：全部通过为 0。
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const REPO = join(import.meta.dirname, '..')

const failures = []
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${label}${detail === undefined ? '' : `（${detail}）`}`)
  } else {
    console.log(`  ✗ ${label}${detail === undefined ? '' : `（${detail}）`}`)
    failures.push(label)
  }
}

/* ---------------------------------------------------------------- *
 * 假上游：认出「提炼提示词」就回事实 JSON，否则回一句普通回复
 * ---------------------------------------------------------------- */

/** 每一次请求体，按时间顺序。用来断言「提炼那一次真的发出去了」。 */
const bodies = []

const FACTS = {
  facts: [
    {
      kind: 'fact',
      category: 'person',
      text: '用户自称小玖',
      summary: '用户叫小玖',
      subject: 'user',
      evidence: [{ source: 'USER', quote: '我叫小玖', messageIndex: 0 }],
    },
    {
      kind: 'fact',
      category: 'place',
      text: '用户住在杭州',
      summary: '住杭州',
      subject: 'user',
      evidence: [{ source: 'USER', quote: '住在杭州', messageIndex: 0 }],
    },
  ],
}

const upstream = createServer((request, response) => {
  let raw = ''
  request.setEncoding('utf8')
  request.on('data', (chunk) => { raw += chunk })
  request.on('end', () => {
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    bodies.push(parsed)
    const wire = raw
    // 判据是提炼提示词里那句固定开场白。用它而不是「有没有 facts 字段」：
    // 后者在普通回复里也可能出现，钉不住。
    const isExtract = wire.includes('你是记忆提炼器')
    /*
     * 普通回复分两种。
     *
     * 第二种是给情绪链用的：用户问一个「她答不上来」的问题，回复里带
     * 「不太确定」——`ondra-drive-gap` 的 `detect()` 会命中它，于是
     * `intake` 该把这个事实投成一次 `stumble` 情绪事件。
     * **不能让假上游直接回一句 `felt`**：那测的是测试自己，
     * 真正要验的是「上游判据命中 → 信号 → 情绪内核」这条四段链。
     */
    const unsure = wire.includes('接口的签名')
    const text = isExtract
      ? JSON.stringify(FACTS)
      : unsure
        ? '这个我也不太确定，得回头看下文档。'
        : '好，我记着了。'
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
    response.write('data: [DONE]\n\n')
    response.end()
  })
})

const upstreamPort = await new Promise((resolve) => {
  upstream.listen(0, '127.0.0.1', () => { resolve(upstream.address().port) })
})

/* ---------------------------------------------------------------- *
 * 起宿主
 * ---------------------------------------------------------------- */

/**
 * 从 SSE 文本里取会话 id（`event: session` 那一帧）。
 *
 * 推理接口是流式返回，会话 id 在开头的第一帧里，正文跟在后面。
 * @param text 整个响应体。
 * @returns 会话 id；找不到时返回空串。
 */
function sessionIdOf(text) {
  for (const block of text.split('\n\n')) {
    if (!block.includes('event: session')) continue
    const dataLine = block.split('\n').find((line) => line.startsWith('data:'))
    if (dataLine === undefined) continue
    try {
      const parsed = JSON.parse(dataLine.slice(5).trim())
      if (typeof parsed.sessionId === 'string') return parsed.sessionId
    } catch {
      // 解析不了就继续找下一帧。
    }
  }
  return ''
}

const dataDir = await mkdtemp(join(tmpdir(), 'ondra-e2e-memory-'))

/*
 * 供应商必须在**宿主启动之前**写进配置文件。
 *
 * ## 为什么不能等宿主起来再 POST /api/config/profiles
 *
 * 网关的来源清单是 `apply()` 时的快照：宿主入口读一次
 * `config.read().profiles`，派生 `sources` 塞进插件配置，之后
 * `LlmGateway.settings` 就是 `readonly`，`probe()` 只重算可用性缓存、
 * 不改来源清单。所以「先起宿主、后配供应商」这条路走到提炼那一步必然
 * 是 `no-source`——而症状只是一句 `failed=1`，说不出「配置没生效」。
 *
 * 上一版脚本正是这个顺序，于是七条断言里六条红，看起来像"记忆链断了"，
 * 实际链是好的，是测试自己把配置写晚了。
 *
 * 先写文件再启动，也正是真实用户的路径：填完供应商 → 重启应用 → 对话。
 */
await writeFile(
  join(dataDir, 'config.json'),
  JSON.stringify({
    currentModel: 'fake/memory',
    profiles: [{
      id: 'fake/memory',
      label: '假供应商',
      baseUrl: `http://127.0.0.1:${String(upstreamPort)}/v1`,
      model: 'fake-model',
      apiKey: 'test',
      contextWindow: 32_768,
    }],
    permission: 'chat',
  }, null, 2),
  'utf8',
)

const host = spawn(process.execPath, [join(REPO, 'cordis-host', 'lib', 'index.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ONDRA_DATA_DIR: dataDir, ONDRA_PORT: '0' },
})

let ready
const readyPromise = new Promise((resolve) => { ready = resolve })

let buffer = ''
host.stdout.setEncoding('utf8')
host.stdout.on('data', (chunk) => {
  buffer += chunk
  let at = buffer.indexOf('\n')
  while (at !== -1) {
    const line = buffer.slice(0, at).trim()
    buffer = buffer.slice(at + 1)
    at = buffer.indexOf('\n')
    if (line === '') continue
    try {
      const message = JSON.parse(line)
      if (message.type === 'ready') ready(message)
    } catch {
      // 非协议行忽略。
    }
  }
})

try {
  console.log('=== 记忆提炼端到端 · 从一句话到 memory_fact ===')

  const info = await Promise.race([
    readyPromise,
    new Promise((_, reject) => { setTimeout(() => { reject(new Error('宿主 30 秒内没有就绪')) }, 30000) }),
  ])
  const base = `http://127.0.0.1:${String(info.port)}`
  const headers = { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' }

  /** 带鉴权的 POST。 */
  async function post(path, body) {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    return { status: response.status, text: await response.text() }
  }

  /** 带鉴权的 GET。 */
  async function get(path) {
    const response = await fetch(`${base}${path}`, { headers })
    return { status: response.status, json: await response.json() }
  }

  /* ------------------------------------------------------------ *
   * 1. 五层前置全部在位（断任何一层，下面就不用测了）
   * ------------------------------------------------------------ */

  console.log('\n--- 1. 链路上的五个环节都在位 ---')

  const diagnostics = await get('/api/diagnostics/memory')
  check('诊断接口可读', diagnostics.status === 200, `HTTP ${String(diagnostics.status)}`)
  const diag = diagnostics.json
  check('模型运行时已注册（ctx.llm）', diag.llmProvided === true, String(diag.llmProvided))
  check('模型网关已装载', diag.gateway?.present === true, String(diag.gateway?.present))
  check('模型网关可用', diag.gateway?.available === true, String(diag.gateway?.reason ?? 'ok'))
  check('事实提炼器已装载', diag.extract?.present === true, String(diag.extract?.present))
  check('事实提炼器可用', diag.extract?.available === true, String(diag.extract?.reason ?? 'ok'))
  check('采集器已装载', diag.intake?.present === true, String(diag.intake?.present))
  const sources = diag.gateway?.stats?.sources
  check(
    '网关的来源清单非空',
    Array.isArray(sources) && sources.length >= 1,
    Array.isArray(sources) ? `${String(sources.length)} 条` : '（不是数组）',
  )

  /* ------------------------------------------------------------ *
   * 2. 供应商是启动前写进配置的，这里只确认它真的被读到了
   * ------------------------------------------------------------ */

  console.log('\n--- 2. 供应商已随配置生效 ---')

  const configNow = await get('/api/config')
  const profilesNow = Array.isArray(configNow.json?.profiles) ? configNow.json.profiles : []
  check(
    '宿主读到了启动前写入的供应商',
    profilesNow.some((profile) => profile.id === 'fake/memory'),
    `${String(profilesNow.length)} 条`,
  )
  check(
    '当前模型指向那个供应商',
    configNow.json?.currentModel === 'fake/memory',
    String(configNow.json?.currentModel),
  )

  /*
   * 来源清单必须在这一步就已经非空。它是 `apply()` 快照，**运行时改不了**——
   * 所以这里红就说明启动顺序又写错了，而不是"稍后会自愈"。
   */
  const afterConfig = await get('/api/diagnostics/memory')
  check(
    '启动即派生出来源（无需重启补一次）',
    Array.isArray(afterConfig.json.gateway?.stats?.sources)
      && afterConfig.json.gateway.stats.sources.length >= 1,
    `${String(afterConfig.json.gateway?.stats?.sources?.length ?? 0)} 条`,
  )

  /* ------------------------------------------------------------ *
   * 3. 一轮真实对话
   * ------------------------------------------------------------ */

  console.log('\n--- 3. 用户说了两句关于自己的话 ---')

  const SPOKEN = '我叫小玖，住在杭州。'
  const turn = await post('/api/inference', { input: SPOKEN })
  check('对话接口返回 200', turn.status === 200, `HTTP ${String(turn.status)}`)
  const sessionId = sessionIdOf(turn.text)
  check('拿到会话 id', sessionId !== '', sessionId)

  /*
   * 等落库。`intake.flush()` 是 fire-and-forget，回复流完之后才开始写，
   * 而提炼还要再等一次模型往返。不等待会得到「时红时绿」的断言。
   */
  await new Promise((resolve) => { setTimeout(resolve, 3000) })

  /* ------------------------------------------------------------ *
   * 4. 库里的真实证据
   * ------------------------------------------------------------ */

  console.log('\n--- 4. 事实真的写进了库 ---')

  const dbPath = join(dataDir, 'user', 'ondra.db')
  const db = new DatabaseSync(dbPath)
  let rawRows = 0
  let factTexts = []
  try {
    rawRows = db.prepare('select count(*) as n from memory_raw').get().n
    factTexts = db.prepare('select text from memory_fact').all().map((row) => String(row.text))
  } finally {
    db.close()
  }

  /*
   * 断言用「有没有真的写进去」，不是「表存不存在」。
   * `memory_fact` 的表从建库起就一直在，一直是 0 行——「表存在」
   * 会让任何 `tableExists` 类断言恒绿。
   */
  check('原文进了 memory_raw', rawRows >= 2, `${String(rawRows)} 行`)
  check('事实进了 memory_fact', factTexts.length >= 1, `${String(factTexts.length)} 行`)
  check(
    '事实正文来自那句原话',
    factTexts.some((text) => text.includes('小玖')) && factTexts.some((text) => text.includes('杭州')),
    factTexts.join(' / ') || '（空）',
  )

  /* ------------------------------------------------------------ *
   * 5. 提炼那一次真的打到了模型，且没有污染会话历史
   * ------------------------------------------------------------ */

  console.log('\n--- 5. 提炼真的调了一次模型 ---')

  const extractCalls = bodies.filter((body) => JSON.stringify(body ?? '').includes('你是记忆提炼器'))
  check('提炼请求发出去过', extractCalls.length >= 1, `${String(extractCalls.length)} 次`)

  /*
   * 断言「提炼不落盘」，而不是「请求里 stream=false」。
   *
   * 第一版写的是后者，实测红——而红的是**断言**，不是产品：`stream: true`
   * 是内核对着供应商那一层的流式开关（`model.complete` 内部仍走 SSE），
   * 与「网关这一层把流拼成整段文本」是两件事。拿它当判据，钉住的是一个
   * 实现细节；实现换成非流式那天，断言会无辜变红。
   *
   * 真正该守的不变量是：提炼的提示词与返回结果**一个字都不该进会话历史**。
   * 它们是指令不是对话——落盘后下次读历史会把它当成用户说过的话再喂回去，
   * 模型就会以为「她每隔一轮都被复制一遍事实」。
   */
  const messages = await get(`/api/sessions/${encodeURIComponent(sessionId)}/messages`)
  const historyText = JSON.stringify(messages.json ?? {})
  check('会话历史读得到', messages.status === 200, `HTTP ${String(messages.status)}`)
  check(
    '提炼的提示词没有落进会话历史',
    !historyText.includes('你是记忆提炼器'),
    `${String(historyText.length)} 字符`,
  )
  check(
    '提炼返回的 JSON 没有落进会话历史',
    !historyText.includes('"subject":"user"'),
    `${String(historyText.length)} 字符`,
  )

  const after = await get('/api/diagnostics/memory')
  check(
    '提炼器计数显示成功',
    after.json.extract?.stats?.succeeded >= 1,
    `calls=${String(after.json.extract?.stats?.calls)} succeeded=${String(after.json.extract?.stats?.succeeded)}`,
  )
  check(
    '提炼失败数为 0',
    after.json.extract?.stats?.failed === 0,
    `failed=${String(after.json.extract?.stats?.failed)} ${String(after.json.extract?.stats?.lastError ?? '')}`,
  )

  /* ------------------------------------------------------------ *
   * 6. 情绪：一轮「她答不上来」之后，emotion_state 里要有行
   * ------------------------------------------------------------ */

  console.log('\n--- 6. 情绪写入链（真宿主 + 真库）---')

  /*
   * ## 这一条为什么必须放在真宿主里跑
   *
   * `cordis-host/check-feel.mjs` 已经验了「intake → 信号 → feel → comfort」
   * 这条链，但它是**手工 loadCore** 的，与真实宿主的装载顺序、
   * 默认启用名单、配置注入都不同。本仓在这件事上栽过：
   * 单测全绿而宿主里那条线根本没人接（`session/event` 那一轮）。
   *
   * 真宿主里唯一能证明「接了」的证据是**库里的行**：
   * 表存在会让 `tableExists` 类断言恒绿，`available` 在内存态下也恒真。
   */
  const unsureTurn = await post('/api/inference', { input: '这个接口的签名是怎么写的？' })
  check('第二轮对话返回 200', unsureTurn.status === 200, `HTTP ${String(unsureTurn.status)}`)

  // 等落库：`flush()` 是 fire-and-forget，回复流完之后才开始写。
  await new Promise((resolve) => { setTimeout(resolve, 2000) })

  const emotionDb = new DatabaseSync(dbPath)
  let emotionRows = 0
  let axesText = ''
  try {
    emotionRows = emotionDb.prepare('select count(*) as n from emotion_state').get().n
    const row = emotionDb.prepare('select axes from emotion_state limit 1').get()
    axesText = typeof row?.axes === 'string' ? row.axes : ''
  } finally {
    emotionDb.close()
  }

  check('emotion_state 里有行（从建库起的第一次）', emotionRows >= 1, `${String(emotionRows)} 行`)
  check('存档里带六维（不是空对象）', axesText.includes('pleasure'), axesText.slice(0, 40) || '（空）')
  /*
   * 钉「真的偏离了基线」而不是「表里有行」。
   *
   * 一行 `mood:0.5 / tension:0` 也能让上面两条全绿——那正好是「谁都没写」
   * 的样子（`load()` 之后立刻 `save()` 就会产生这样一行）。
   * 手册 §3.2 的基线是 mood 0.5 / tension 0，所以判据是「不等于基线」。
   */
  let axesParsed
  try {
    axesParsed = JSON.parse(axesText)
  } catch {
    axesParsed = undefined
  }
  check(
    '情绪确实偏离了基线（不是「存了一次基线」）',
    typeof axesParsed?.tension === 'number' && axesParsed.tension > 0.01,
    `tension=${String(axesParsed?.tension)}`,
  )

  /* ------------------------------------------------------------ *
   * 7. 情绪弥散：宿主真的每轮都问了一次
   * ------------------------------------------------------------ */
  console.log('\n--- 7. 情绪弥散（真宿主 + 真库）---')

  /*
   * ## 这一条抓的是什么
   *
   * `cordis-host/check-diffuse.mjs` 验的是**宿主那个函数本身**对不对——
   * 但它直接 import 了 `src/diffuse.ts` 并手动调用，绕过了最关键的一环：
   * **推理路由有没有真的调它**。
   *
   * 本仓在这件事上栽过四次（`session/event`、`ctx.llm`、`feel()`、`claim()`），
   * 症状完全一样：函数写得对、单测全绿、而线没接上。唯一有效的口径是
   * 走真 HTTP 打进去、再从**宿主自己的视图**读出来。
   *
   * 判据选 `asked` 而不是 `claims`：前面已经跑过两轮对话，第二轮距第一轮
   * 只有几秒，间隔闸会判成 `no-gap`——`claims` 可能是 0 而一切正常。
   * `asked` 数的是「问了几次」，它涨了才证明接线存在。两个数一起看才分得开
   * 「没接线」与「接上了但判据在拦」。
   */
  const emotionDiag = await get('/api/diagnostics/emotion')
  check('情绪诊断接口可读', emotionDiag.status === 200, `HTTP ${String(emotionDiag.status)}`)
  check('弥散服务已装载', emotionDiag.json.diffuse?.present === true,
    String(emotionDiag.json.diffuse?.present))
  check('弥散服务可用', emotionDiag.json.diffuse?.available === true,
    String(emotionDiag.json.diffuse?.reason ?? 'ok'))
  /*
   * 两轮对话 → 应该问过两次。断言用 `>= 2`：若将来加了别的推理入口
   * （比如工具调用也走一轮），次数只会更多。钉死等号会让那种扩展无辜变红。
   */
  check('宿主每轮都问了一次弥散（asked ≥ 2）', emotionDiag.json.asked >= 2,
    String(emotionDiag.json.asked))
  /*
   * ## 库里的证据
   *
   * 标记表是弥散**唯一**的落盘痕迹：只在 `status === 'diffused'` 时才写。
   * 所以「表里有一行」直接证明「真的弥散过一次」，而不是「调过函数」。
   *
   * 两轮间隔几秒 → 第二轮必是 `no-gap`，于是只有第一轮写了标记。
   * 断言 `=== 1` 而不是 `>= 1`：多了说明间隔闸失效（每条都弥散），
   * 那会把心情在几秒内洗回基线——「她越聊越淡」正是这样来的。
   */
  const diffuseDb = new DatabaseSync(dbPath)
  let markRows = 0
  let markKey = ''
  try {
    markRows = diffuseDb.prepare('select count(*) as n from emotion_diffuse_mark').get().n
    const row = diffuseDb.prepare('select boundary_key from emotion_diffuse_mark limit 1').get()
    markKey = typeof row?.boundary_key === 'string' ? row.boundary_key : ''
  } finally {
    diffuseDb.close()
  }
  check('弥散标记表里有一行（真的弥散过）', markRows === 1, `${String(markRows)} 行`)
  check('标记的边界键带着会话 id（键生成走的是宿主那份）',
    markKey.includes(sessionId), markKey || '（空）')

  /*
   * ## 关系域：`familiarity` 真的离开了 0
   *
   * 上面那几条验的是「弥散问了没有」。这一条验**它读到的熟悉度是多少**——
   * 这是两个独立断点：`claim()` 可以被调到（`asked` 在涨），却一次都没收到
   * `familiarity`（宿主没传），于是公式里 `(1 − f × 0.5)` 恒等于 1，
   * 整段白写。两种情形下 `asked` 一模一样，只有读这一格才分得开。
   *
   * 判据钉的是**关系**而不是绝对值：
   *
   * | 关系 | 为什么 |
   * | --- | --- |
   * | `interactions ≥ 2` | 前面跑了两轮带用户输入的对话，`recordTurn()` 每轮 +1 |
   * | `familiarity = interactions / 5000` | 两处真源一漂，这个等式立刻不成立 |
   * | `familiarity > 0` | 0 是「陌生人」，也正是「链断了」的表现 |
   *
   * 不钉 `interactions === 2`：将来多一个推理入口就会变成 3，那是扩展不是缺陷。
   */
  const relationDiag = emotionDiag.json.relation
  check('关系诊断这一格在（服务已装载）', relationDiag?.present === true,
    String(relationDiag?.reason ?? 'ok'))
  check('两轮对话记到了互动（interactions ≥ 2）',
    typeof relationDiag?.interactions === 'number' && relationDiag.interactions >= 2,
    String(relationDiag?.interactions))
  check('熟悉度不再是 0（真的离开陌生人）',
    typeof relationDiag?.familiarity === 'number' && relationDiag.familiarity > 0,
    String(relationDiag?.familiarity))
  check('熟悉度与互动次数同步（= n / 5000）',
    typeof relationDiag?.familiarity === 'number'
    && typeof relationDiag?.interactions === 'number'
    && Math.abs(relationDiag.familiarity - relationDiag.interactions / 5000) < 1e-12,
    `f=${String(relationDiag?.familiarity)} n=${String(relationDiag?.interactions)}`)

  /*
   * ## 投影域：情绪块真的进了这一轮的系统提示词
   *
   * `cordis-host/check-emotion-project.mjs` 已经把「六态 → 模板 → 提示词」
   * 这条链从头验到尾了，但它**手工传 `enable`**，所以验不到两件事：
   *
   * 1. `ondra-emotion-project` 在不在**默认启用名单**里（漏了它，单测全绿、
   *    而真实用户一次都拿不到情绪块）；
   * 2. 真宿主那一处装配有没有被调用（`assembleSystemPrompt()` 被换个实现也能过）。
   *
   * 这两件只有真宿主能回答。判据是**两个数并排**：
   *
   * | 字段 | 含义 | 读到什么时的结论 |
   * | --- | --- | --- |
   * | `project.counters.projects` | 插件产出过几次 | 0 → 没人调 `project()` |
   * | `emotionApplied` | 宿主真的拼进提示词几次 | 涨得比上面慢 → 装配线断了 |
   *
   * 只验前者会漏掉「取到了又丢掉」——那正是本仓第九次踩的形态。
   */
  console.log('\n--- 8. 情感投影（真宿主 · 默认启用名单）---')
  const projectDiag = emotionDiag.json.project
  check('投影诊断这一格在（服务已装载，说明在默认名单里）', projectDiag?.present === true,
    String(projectDiag?.reason ?? 'ok'))
  check('投影看得见六态服务', projectDiag?.hasExpress === true)
  check('投影真的产出过（counters.projects > 0）',
    typeof projectDiag?.counters?.projects === 'number' && projectDiag.counters.projects > 0,
    String(projectDiag?.counters?.projects))

  const firstApplied = emotionDiag.json.emotionApplied
  check('宿主真的把它拼进过系统提示词（emotionApplied > 0）',
    typeof firstApplied === 'number' && firstApplied > 0, String(firstApplied))
  /*
   * 再打一轮，验「每轮都在拼」而不是「拼过一次」。
   *
   * 一次就够会掩盖一种真实缺陷：装配那一行被放进只跑一次的初始化里。
   * 判据钉**增量**而不是绝对值——绝对值在将来多一个推理入口时会变，
   * 那是扩展不是缺陷。
   */
  await post('/api/inference', { input: '今天先聊到这儿吧。' })
  /*
   * ## 为什么这里轮询而不是睡固定毫秒
   *
   * 第一版写的是 `setTimeout(800)`。跑八次里有一次红——而那条断言本身
   * 没问题，是**等得不够**：`emotionApplied` 在流式响应开始之前就已经自增，
   * 但 `/api/inference` 是流式的，`post()` 要等整个响应体读完才返回，
   * 返回之后诊断里那个数**一定**已经是新值。真正会抖的是宿主在负载高时
   * 把 `ready` 到首字节之间的空窗拉长。
   *
   * 换成「等到它涨，最多等 5 秒」：判据仍是「它涨了」，只是不再靠猜时间。
   * 时红时绿的断言比没有断言更糟——人会开始忽略红色（本仓记过这一条）。
   */
  let secondApplied = firstApplied
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const poll = await get('/api/diagnostics/emotion')
    secondApplied = poll.json.emotionApplied
    if (typeof secondApplied === 'number' && secondApplied > firstApplied) break
    await new Promise((resolve) => { setTimeout(resolve, 200) })
  }
  check('又打一轮，投影装配次数跟着涨（不是只拼过一次）',
    typeof firstApplied === 'number' && typeof secondApplied === 'number' && secondApplied > firstApplied,
    `${String(firstApplied)} → ${String(secondApplied)}`)
  /*
   * 唯一例外出口如实报「未接」。
   *
   * 这一条不是功能断言，是**反谎报**：宿主刻意不从对话里猜「用户是不是在
   * 问数值」（猜错一次就是她突然报数，而那是明文禁止的）。若哪天有人补了
   * 一份关键词表而没有走插件那道闸，这一格会先变 true，提醒他重新想一遍。
   */
  check('诊断如实报「报数例外未接」', projectDiag?.askedForNumbersWired === false)

  /*
   * ## 记忆注入：那一段真的挂上了，且宿主真的把它拼进了提示词
   *
   * `cordis-host/check-prompt-context.mjs` 用手工 `enable` 验过「上下文段
   * 能进装配」，所以它**验不到**这两件事：
   *
   * 1. `ondra-prompt-inject` / `ondra-memory-pool` 在不在**默认启用名单**里
   *    （漏了，单测全绿，真实用户一次都不会被她提起任何旧事）；
   * 2. 真宿主的 `provide` 顺序对不对（`provide` 晚于 `loadCore` 时，插件
   *    虽然最终能通过 `inject` 挂上，但装载期看到的是一个没有服务的世界）。
   *
   * 判据是三个数并排，缺一个就分不清三种成因：
   *
   * | 字段 | 含义 | 读到什么时的结论 |
   * | --- | --- | --- |
   * | `context.registered` | 注册表里有几段 | 0 → 插件没挂上（查 provide 顺序 / 名单） |
   * | `context.names` | 谁登记了 | 不含 `ondra:injection` → 挂错了对象 |
   * | `context.applied` | 有几轮真的产出了正文 | 0 而 registered > 0 → **库是空的**，不是断线 |
   *
   * 第三行尤其重要：新库必然没有任何记忆可注入，此时 `applied` 为 0 是
   * **正确**的。所以断言只钉前两格（接线），第三格只报数不判死——
   * 把它也钉成 >0 会让这个脚本在「干净库」上必红，而红会被当噪音。
   */
  console.log('\n--- 9. 记忆注入（真宿主 · 默认启用名单）---')
  const injectDiag = await get('/api/diagnostics/emotion')
  const ctxCell = injectDiag.json.context
  check('诊断里有 context 一格', ctxCell !== undefined && typeof ctxCell === 'object')
  check('注册表里有插件登记的段（说明 prompt-inject 在默认名单里）',
    typeof ctxCell?.registered === 'number' && ctxCell.registered > 0,
    String(ctxCell?.registered))
  check('登记名含 ondra:injection（挂的是记忆装箱那一段）',
    Array.isArray(ctxCell?.names) && ctxCell.names.includes('ondra:injection'),
    Array.isArray(ctxCell?.names) ? ctxCell.names.join(', ') : '(无)')
  /*
   * 报数不判死。`applied === 0` 在干净库上是正确答案；这里只把它打出来，
   * 让读日志的人知道「这一轮为什么提示词里没有记忆」。
   */
  console.log(`  · context.applied = ${String(ctxCell?.applied)}`
    + `${ctxCell?.applied === 0 ? '（干净库上这是正确答案：没有旧事可说）' : ''}`)

  /*
   * ## 9b. 注入正文里**真的有**那两条事实
   *
   * 上面三条只验到「注册了、名字对、这一轮产出了正文」。它们全部通过，
   * 而提示词里一个字都没有记忆，是完全可能的：
   *
   * | 断在哪 | `registered` | `names` | `applied` | 提示词里有没有事实 |
   * | --- | --- | --- | --- | --- |
   * | 插件没装 | 0 | — | — | 没有 |
   * | 挂错对象 | >0 | 不含 injection | 0 | 没有 |
   * | 库是空的 | >0 | 含 injection | 0 | 没有 |
   * | **装配时丢段** | >0 | 含 injection | **>0** | **没有** ← 前三格全绿 |
   *
   * 第四行是这条要抓的：段落产出了（`applied` 涨了），但拼进系统提示词
   * 那一步被裁掉或漏掉。症状与「她记性不好」在界面上完全一样。
   *
   * 判据取「假上游收到的 system 正文里含那两条事实的关键词」。这是
   * **外部事实**——前面每一环都能用「我产出了」自证，只有上游收到的
   * 请求体证明那句话真的走完了全程。
   */
  console.log('\n--- 9b. 提示词里真的有那两条事实 ---')
  /*
   * 这里必须再打一轮对话：上面那些请求发生在事实落库之前（第 3 段），
   * 它们的 system 里不可能有这两条。`requests` 记的是全部请求体。
   */
  const beforeCount = bodies.length
  const probe = await post('/api/inference', { input: '我今天有点累。' })
  check('探针轮返回 200', probe.status === 200, `HTTP ${String(probe.status)}`)
  await new Promise((resolve) => { setTimeout(resolve, 1200) })
  /*
   * 取这一轮里**非提炼**的那次请求。判据与假上游一致：不含提炼开场白。
   * 索引从 `beforeCount` 起，避免拿到前面几轮的旧请求。
   */
  const probeBodies = bodies.slice(beforeCount).filter((body) => body !== undefined)
  const systemOf = (body) => {
    const messages = Array.isArray(body?.messages) ? body.messages : []
    return messages
      .filter((message) => message.role === 'system')
      .map((message) => String(message.content ?? ''))
      .join('\n')
  }
  const systems = probeBodies.map(systemOf).filter((text) => !text.includes('你是记忆提炼器'))
  const systemText = systems.length === 0 ? '' : systems[systems.length - 1]
  check('探针轮的请求里有 system 正文', systemText.length > 0, `${String(systemText.length)} 字`)
  check('系统提示词里有「杭州」（地点那条真的进了提示词）', systemText.includes('杭州'))
  check('系统提示词里有「小玖」（姓名那条真的进了提示词）', systemText.includes('小玖'))
  /*
   * 反证：记忆不能出现在**用户消息**里。
   *
   * 若注入层把记忆拼进了用户那一轮，模型会以为「用户刚刚又说了这句话」，
   * 于是当成新信息再记一遍——库里条数翻倍，而她开始复述。这种错法在
   * 只看 system 的断言里完全看不出来。
   */
  const lastBody = probeBodies.length === 0 ? undefined : probeBodies[probeBodies.length - 1]
  const userText = (Array.isArray(lastBody?.messages) ? lastBody.messages : [])
    .filter((message) => message.role === 'user')
    .map((message) => String(message.content ?? ''))
    .join('\n')
  check('记忆没有被错拼进用户消息', !userText.includes('杭州'), `用户消息 ${String(userText.length)} 字`)
  /*
   * 人格段也在同一份提示词里。系统提示词有预算，记忆装箱与人格装配共用
   * 这一段；若记忆无节制占满预算，人格会被裁掉——表现是她说话没人设，
   * 而「记忆注入成功」照样全绿。两件事必须一起看。
   */
  check('人格段没有被记忆挤掉', systemText.includes('鲸') || systemText.includes('人格'))

  /* ------------------------------------------------------------ *
   * 10. 判重：同一句话再说一遍，库里不该多一条
   * ------------------------------------------------------------ *
   *
   * ## 这一条要防的是什么
   *
   * `intake` 原先把提炼结果交给 `extract()`，而 `extract()` 是**纯追加**语义。
   * 于是「搭档叫阿岚」说三遍，库里就有三条。三条都是合法记录、都能被召回、
   * 右栏看起来「记得挺多」——**没有任何一处会报错**，只有把正文拿出来数一遍
   * 才看得出是同一件事被记了三份。
   *
   * ## 为什么判据是「条数不变」而不是「判重服务 available」
   *
   * `available` 恒真：判重服务注册着、内核可用、`stats()` 一切正常，
   * 唯独 `settle()` 零调用方。这个脚本第 9 段之前就是这么绿了整个仓库。
   * 唯一能分辨的是**写完之后的库**：
   *
   * | 读数 | 含义 |
   * | --- | --- |
   * | `memory_fact` 条数翻倍 | 走的还是 `extract()` 直写 → 写入路径没接上 |
   * | 条数不变 + `times_said` 涨 | 判重真的在裁决（`drop` / `append` 只加固） |
   * | 条数不变 + 决策日志有空行 | 判重按「复述」丢掉了，且没留痕 |
   *
   * 第三行就是本轮修的断裂：`propose()` / `settle()` 此前全仓零调用方，
   * 而症状只是「库里同一句话有好几份」——看起来完全像正常记录。
   */
  console.log('\n--- 10. 判重：同一句话再说一遍，库里不该多一条 ---')

  const dedupeDiag = await get('/api/diagnostics/memory')
  const dedupeCell = dedupeDiag.json.dedupe
  check('诊断里有 dedupe 一格', dedupeCell !== undefined && typeof dedupeCell === 'object')
  check('判重服务已装载（说明在默认启用名单里）',
    dedupeCell?.present === true, String(dedupeCell?.present))
  check('判重服务可用', dedupeCell?.available === true,
    String(dedupeCell?.reason ?? dedupeCell?.error ?? 'ok'))

  /*
   * 记下「再说一遍之前」的两个数。第一句已经在第 3 段说过，此处是**第二次**说
   * 同一句、而假上游回的仍是同一批事实——包含度 1.0、新颖度 0，判重应当
   * 判成「复述」而不是再写一条。
   */
  const beforeDb = new DatabaseSync(dbPath)
  let factsBefore = 0
  let saidBefore = []
  try {
    factsBefore = beforeDb.prepare('select count(*) as n from memory_fact').get().n
    saidBefore = beforeDb.prepare('select times_said from memory_fact order by text').all()
      .map((row) => Number(row.times_said))
  } finally {
    beforeDb.close()
  }

  const again = await post('/api/inference', { input: SPOKEN })
  check('第三轮对话返回 200', again.status === 200, `HTTP ${String(again.status)}`)
  await new Promise((resolve) => { setTimeout(resolve, 3000) })

  const afterDb = new DatabaseSync(dbPath)
  let factsAfter = 0
  let saidAfter = []
  let logRows = 0
  let logActions = []
  try {
    factsAfter = afterDb.prepare('select count(*) as n from memory_fact').get().n
    saidAfter = afterDb.prepare('select times_said from memory_fact order by text').all()
      .map((row) => Number(row.times_said))
    const hasLog = afterDb.prepare(
      "select count(*) as n from sqlite_master where type='table' and name='memory_dedupe_log'",
    ).get().n
    if (hasLog > 0) {
      logRows = afterDb.prepare('select count(*) as n from memory_dedupe_log').get().n
      logActions = afterDb.prepare('select distinct action from memory_dedupe_log').all()
        .map((row) => String(row.action))
    }
  } finally {
    afterDb.close()
  }

  check('同一句话重复一遍，事实条数没有翻倍',
    factsAfter === factsBefore,
    `${String(factsBefore)} → ${String(factsAfter)} 条`)
  /*
   * 「被加固」是判重真的跑过的第二个独立证据：即便条数没涨，也可能是因为
   * 提炼这一次根本没返回事实（上游抖动），那时条数同样不变、但 `times_said`
   * 也不会动。两个数一起看才分得开。
   */
  const saidGrew = saidAfter.some((value, index) => value > (saidBefore[index] ?? 0))
  check('被重复提起的那条 times_said 涨了（判重走的是「复述 / 加固」而不是「再写一条」）',
    saidGrew,
    `[${saidBefore.join(',')}] → [${saidAfter.join(',')}]`)
  /*
   * 决策日志：判重留痕才能回答「我明明说过，怎么没记住」。
   *
   * 这一条**只报数不判死**——判重可以在没有存储端口时照常工作（`logging:false`），
   * 那时没有日志是正确行为。钉死它会让「内存态兜底」这个合法分支永远红。
   */
  console.log(`  · 判重决策日志 ${String(logRows)} 行`
    + `${logActions.length === 0 ? '' : `，动作含 ${logActions.join(' / ')}`}`
    + `${logRows === 0 ? '（无存储端口时不落日志，属正常降级）' : ''}`)
} finally {
  host.kill()
  upstream.close()
  await rm(dataDir, { recursive: true, force: true })
}

console.log('')
if (failures.length === 0) {
  console.log('全部通过。')
} else {
  console.log(`${String(failures.length)} 条未通过：`)
  for (const item of failures) console.log(`  - ${item}`)
}
process.exit(failures.length === 0 ? 0 : 1)
