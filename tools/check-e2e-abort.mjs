/**
 * 中断链端到端：点「停止生成」之后，这个会话必须立刻能再说一句。
 *
 * ## 这条断言守的是什么
 *
 * 一个用户很容易撞上、而所有既有检查都测不到的场景：
 *
 * ```
 * 她说得慢 → 用户点「停止生成」→ 再发一句 → 「该会话正在进行一轮对话」
 * ```
 *
 * 上一版的链路是这样的：内核在 `for await` 里看到 `aborted` 就 `break`，
 * 但那只是**不再向生成器要下一块**。适配器内部的 `readSseData` 还在
 * `await reader.read()` 上挂着，等上游发下一帧。上游是慢速远端时，
 * 这一等就是十几秒到几十秒。
 *
 * 而 `running.delete(sessionId)` 在 `finally` 里——生成器不结束，
 * `finally` 就跑不到，锁一直在。症状是**这个会话彻底发不出消息**，
 * 且要等到 30 秒宿主超时才「看起来恢复」。
 *
 * 用本地演示模型时上游几乎瞬间结束，所以这个缺陷在开发期完全看不出来。
 *
 * ## 为什么必须直连内核
 *
 * 走宿主会多一层 30 秒超时，把「锁没释放」和「宿主超时」混成同一个症状。
 * 直连内核能精确区分：**第一轮在 abort 后多久返回**，以及**第二轮能不能
 * 在合理时间内跑完**。这两个数才是判据。
 *
 * ## 假上游的两个坑（写在这里，免得下次重踩）
 *
 * 1. `req.on('close')` 在**请求体读完**时就会触发，不是连接断开。用它清
 *    定时器会让第一块数据都发不出去。要挂 `res.on('close')`。
 * 2. 段数不能太多。40 段 × 250ms = 10 秒，会让「第二轮正常」这条断言
 *    因为等太久而误判成失败。6 段足够证明流在跑。
 *
 * 用法：node tools/check-e2e-abort.mjs
 * 退出码：全部通过为 0。
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
 * 假上游：慢速逐段发，用来制造「生成中」这段真实存在的时间
 * ---------------------------------------------------------------- */

/** 每次请求到达的时刻。用来断言第二轮真的打到了上游。 */
const arrivals = []

/** 每次响应被客户端关闭的时刻。用来确认 abort 真的断了连接。 */
let closes = 0

const SEGMENTS = 6
const SEGMENT_MS = 250

const upstream = createServer((request, response) => {
  arrivals.push(Date.now())
  let raw = ''
  request.setEncoding('utf8')
  request.on('data', (chunk) => { raw += chunk })
  request.on('end', () => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    let index = 0
    const timer = setInterval(() => {
      index += 1
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `段${String(index)}。` } }] })}\n\n`)
      if (index >= SEGMENTS) {
        clearInterval(timer)
        response.write('data: [DONE]\n\n')
        response.end()
      }
    }, SEGMENT_MS)
    /*
     * 挂 `res` 而不是 `req`：`req.on('close')` 在请求体读完就触发，
     * 会把定时器在第一块数据发出之前清掉——那会让第二轮"请求到了但
     * 一个字都没回"，看起来像内核又卡住了。
     */
    response.on('close', () => {
      closes += 1
      clearInterval(timer)
    })
  })
})

const upstreamPort = await new Promise((resolve) => {
  upstream.listen(0, '127.0.0.1', () => { resolve(upstream.address().port) })
})

/* ---------------------------------------------------------------- *
 * 起内核（直连，不经宿主）
 * ---------------------------------------------------------------- */

const dataDir = await mkdtemp(join(tmpdir(), 'ondra-e2e-abort-'))
const kernel = spawn(process.execPath, [join(REPO, 'dsh-sidecar', 'lib', 'index.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, DSH_DATA_DIR: dataDir },
})

/** 未处理的 Promise 拒绝。中断路径最容易在这里漏。 */
const unhandled = []
kernel.stderr.setEncoding('utf8')
kernel.stderr.on('data', (chunk) => {
  for (const line of chunk.split('\n')) {
    if (line.includes('未处理的 Promise 拒绝')) unhandled.push(line.trim())
  }
})

let nextId = 0
const pending = new Map()
let buffer = ''
kernel.stdout.setEncoding('utf8')
kernel.stdout.on('data', (chunk) => {
  buffer += chunk
  let at = buffer.indexOf('\n')
  while (at !== -1) {
    const line = buffer.slice(0, at).trim()
    buffer = buffer.slice(at + 1)
    at = buffer.indexOf('\n')
    if (line === '') continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.id === undefined || !pending.has(message.id)) continue
    const waiter = pending.get(message.id)
    pending.delete(message.id)
    if (message.error !== undefined) waiter.reject(new Error(JSON.stringify(message.error)))
    else waiter.resolve(message.result)
  }
})

/** 发一条 JSON-RPC。 */
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId + 1
    nextId = id
    pending.set(id, { resolve, reject })
    kernel.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

try {
  console.log('=== 中断链端到端 · 停止生成后必须能再说一句 ===')

  await new Promise((resolve) => { setTimeout(resolve, 1200) })

  console.log('\n--- 1. 配好慢速供应商 ---')
  await rpc('model.configure', {
    profiles: [{
      id: 'slow/test',
      label: '慢速',
      baseUrl: `http://127.0.0.1:${String(upstreamPort)}/v1`,
      model: 'slow',
      apiKey: 'x',
    }],
  })
  const selected = await rpc('model.select', { id: 'slow/test' })
  check('选中慢速供应商', selected.model === 'slow/test', String(selected.model))
  const session = await rpc('session.create', { title: '中断测试', workspace: dataDir })
  check('建好会话', typeof session.id === 'string', session.id)

  console.log('\n--- 2. 起一轮，等它真的在生成 ---')
  const first = rpc('inference.run', { sessionId: session.id, input: '第一轮' })
  first.catch(() => { /* 下面统一看结果 */ })
  await new Promise((resolve) => { setTimeout(resolve, 900) })
  check('慢速上游收到了第一轮请求', arrivals.length === 1, `${String(arrivals.length)} 次`)

  console.log('\n--- 3. 点停止 ---')
  const aborted = await rpc('inference.abort', { sessionId: session.id })
  check('中断被受理', aborted.aborted === true, JSON.stringify(aborted))

  /*
   * 关键判据一：第一轮要在 abort 之后**很快**返回。
   *
   * 阈值 1500ms 而不是更小：`reader.cancel()` 到 `finally` 之间还要走
   * 几层 await，给足余量。但绝不能用"等它自然结束"来测——上游 6 段要
   * 1.5 秒，那个数字与"立刻"分不开。
   */
  const abortAt = Date.now()
  const firstResult = await Promise.race([
    first.then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, error: error.message })),
    new Promise((resolve) => { setTimeout(() => { resolve({ timeout: true }) }, 5000) }),
  ])
  const releaseMs = Date.now() - abortAt
  check(
    '第一轮在中断后立刻返回（锁随之释放）',
    firstResult.timeout !== true && releaseMs < 1500,
    `${String(releaseMs)} ms`,
  )
  check(
    '返回里标明这一轮是被中断的',
    firstResult.ok === true && firstResult.value?.aborted === true,
    JSON.stringify(firstResult.value ?? firstResult.error ?? firstResult.timeout),
  )
  /*
   * 已产出的部分必须留下。
   *
   * 判据是"非空"而不是"等于某几段"：上游发到第几段取决于机器速度，
   * 钉死段数会让这条断言时红时绿。真正要守的是**用户看到的话不能消失**。
   */
  check(
    '中断前已产出的文本仍然落盘（不是全丢）',
    typeof firstResult.value?.text === 'string' && firstResult.value.text.length > 0,
    `「${String(firstResult.value?.text ?? '').slice(0, 20)}」`,
  )
  check('中断真的断了上游连接', closes >= 1, `${String(closes)} 次`)

  console.log('\n--- 4. 中断后立刻再说一句 ---')
  const secondAt = Date.now()
  const secondResult = await Promise.race([
    rpc('inference.run', { sessionId: session.id, input: '第二轮' })
      .then((value) => ({ ok: true, value }))
      .catch((error) => ({ ok: false, error: error.message })),
    new Promise((resolve) => { setTimeout(() => { resolve({ timeout: true }) }, 10_000) }),
  ])
  const secondMs = Date.now() - secondAt
  check('第二轮没有被锁挡住（不是「正在进行一轮对话」）', secondResult.timeout !== true && secondResult.ok === true,
    secondResult.timeout === true ? '超时' : String(secondResult.error ?? 'ok'))
  check('第二轮真的打到了上游', arrivals.length === 2, `${String(arrivals.length)} 次`)
  /*
   * 阈值取 6 段 × 250ms ≈ 1.5 秒，再加余量到 5 秒。
   * 这里量的是"能跑完"，不是"跑得快"——慢一点无所谓，卡住才是缺陷。
   */
  check('第二轮正常跑完（没有被上一次的中断连坐）', secondMs < 5000, `${String(secondMs)} ms`)
  check(
    '第二轮拿到了正文',
    typeof secondResult.value?.text === 'string' && secondResult.value.text.length > 0,
    `${String(secondResult.value?.text?.length ?? 0)} 字`,
  )
  check('第二轮不是被中断的', secondResult.value?.aborted === false, String(secondResult.value?.aborted))

  console.log('\n--- 5. 中断不留未处理的 Promise 拒绝 ---')
  /*
   * `reader.cancel()` 在打断一个正在 `read()` 的流时会以 AbortError 拒绝。
   * 上一版写 `void reader.cancel()`，把拒绝丢在 void 之外，进程级
   * `unhandledRejection` 会打一行「未处理的 Promise 拒绝：AbortError」。
   * 用户只是点了停止，却看到一条像是程序出错的日志。
   */
  await new Promise((resolve) => { setTimeout(resolve, 500) })
  check('没有未处理的 Promise 拒绝', unhandled.length === 0, unhandled.length === 0 ? '0 条' : unhandled[0])

  console.log('')
  if (failures.length === 0) {
    console.log('全部通过。')
  } else {
    console.log(`${String(failures.length)} 条未通过：`)
    for (const label of failures) console.log(`  - ${label}`)
  }
} finally {
  kernel.kill('SIGTERM')
  upstream.close()
  await new Promise((resolve) => { setTimeout(resolve, 300) })
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
}

process.exit(failures.length === 0 ? 0 : 1)