/**
 * 流式输出端到端：字是**逐帧**到界面的，还是攒齐了一次性蹦出来。
 *
 * ## 这条断言守的是什么
 *
 * 陪伴体最核心的体感是「她在说」，而不是「她想完了，把结果贴给你」。
 * 一条回复如果 2 秒后才整段出现，用户看到的是加载条；逐字出现才是对话。
 *
 * 而这个缺陷**从代码上看不出来**：`fetch` 有 `signal`、SSE 解析正确、
 * `response.write()` 每帧都调了、内核也确实逐帧 `notify` 了——每一层都
 * 对，但用户看到的仍是一次性蹦出。
 *
 * ## 上一版的真实链路（实测数据）
 *
 * 宿主的首帧延迟（`planFirstWord()`，0.8–2 秒）本意是「她想了想才开口」。
 * 但后续帧被挂在那条等待链的尾巴上：
 *
 * ```
 * 上游发送   0   301  602  903  1205 1507  ms
 * 宿主入队   0   301  602  903  1205 1507  ms   ← 逐帧到达，正常
 * 宿主发出   1832 1832 1832 1832 1832 1832 ms   ← 全挤在一起
 * ```
 *
 * 上游在 1.5 秒内说完整段，而首帧压了 1.8 秒——于是所有帧都在等首帧，
 * 等到最后一起放。观感与设计意图正好相反：**停顿本意是「像人」，结果
 * 读起来像「卡了然后加载完成」**。
 *
 * ## 判据为什么是「帧间隔」而不是「总时长」
 *
 * 总时长只能说明「有流」，说明不了「逐帧」。一个攒齐后一次性发出的实现，
 * 它的总时长同样可能是 6 秒（上游 6 秒说完，客户端 6 秒后一次收全）。
 * 唯一能分开两者的是**帧与帧之间的间隔分布**：
 *
 * - 真流式：间隔接近上游节奏（本例 400ms）；
 * - 攒批：大量间隔 < 20ms，随后一个长空档。
 *
 * 首帧延迟那 0.8–2 秒内的帧本来就该攒着（那是「她还没开口」），
 * 所以判据允许**前若干帧**挤在一起，只要求整体挤在一起的比例够低。
 *
 * 用法：node tools/check-e2e-stream.mjs
 * 退出码：全部通过为 0。
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
 * 假上游：慢速逐段发
 *
 * 段数与间隔的选择有讲究：首帧延迟上限是 2000ms（`HOLD_MAX_MS`），
 * 所以整段必须**明显长于 2 秒**，否则全部帧都落在首帧停顿里，
 * 「逐帧」与「攒批」两种实现在数据上完全一样，断言就分不出来。
 *
 * 20 段 × 400ms = 8 秒，其中前 5 段落在停顿里，后 15 段必须逐帧到达。
 * ---------------------------------------------------------------- */

/** 上游每一段的发送时刻。 */
const sentAt = []

const SEGMENTS = 20
const SEGMENT_MS = 400

const upstream = createServer((request, response) => {
  let raw = ''
  request.setEncoding('utf8')
  request.on('data', (chunk) => { raw += chunk })
  request.on('end', () => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    let index = 0
    const timer = setInterval(() => {
      index += 1
      sentAt.push(Date.now())
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `段${String(index)}。` } }] })}\n\n`)
      if (index >= SEGMENTS) {
        clearInterval(timer)
        response.write('data: [DONE]\n\n')
        response.end()
      }
    }, SEGMENT_MS)
    /*
     * 挂 `res` 而不是 `req`：`req.on('close')` 在请求体读完时就触发，
     * 会把定时器在第一块数据发出之前清掉。
     */
    response.on('close', () => { clearInterval(timer) })
  })
})

const upstreamPort = await new Promise((resolve) => {
  upstream.listen(0, '127.0.0.1', () => { resolve(upstream.address().port) })
})

/* ---------------------------------------------------------------- *
 * 起宿主（流式缺陷在宿主层，必须经它）
 * ---------------------------------------------------------------- */

const dataDir = await mkdtemp(join(tmpdir(), 'ondra-e2e-stream-'))
/*
 * 供应商必须在启动前写进配置：网关的 `sources` 是 `apply()` 快照，
 * 起宿主后再 POST `/api/config/profiles` 不会刷新它。
 */
await writeFile(
  join(dataDir, 'config.json'),
  JSON.stringify({
    currentModel: 'slow/stream',
    profiles: [{
      id: 'slow/stream',
      label: '慢速',
      baseUrl: `http://127.0.0.1:${String(upstreamPort)}/v1`,
      model: 'slow',
      apiKey: 'x',
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
  console.log('=== 流式输出端到端 · 字是逐帧到的还是一次性蹦出的 ===')

  const info = await Promise.race([
    readyPromise,
    new Promise((_, reject) => { setTimeout(() => { reject(new Error('宿主 30 秒内没有就绪')) }, 30_000) }),
  ])
  const base = `http://127.0.0.1:${String(info.port)}`
  const headers = { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' }

  console.log('\n--- 1. 起一轮，逐帧记到达时刻 ---')
  const response = await fetch(`${base}/api/inference`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input: '说一段长一点的话' }),
  })
  check('推理接口返回 200', response.status === 200, `HTTP ${String(response.status)}`)
  check('响应是事件流', String(response.headers.get('content-type') ?? '').includes('text/event-stream'),
    String(response.headers.get('content-type')))

  /*
   * 边读边记：`delta` 帧的到达时刻。
   *
   * 不能用「读完再统一看」——那样记下的全是读完的时刻，间隔恒为 0，
   * 两种实现分不出来。必须在 `reader.read()` 返回的那一刻取时间。
   */
  const recvAt = []
  const texts = []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    let at = pending.indexOf('\n\n')
    while (at !== -1) {
      const block = pending.slice(0, at)
      pending = pending.slice(at + 2)
      at = pending.indexOf('\n\n')
      if (!block.includes('event: delta')) continue
      recvAt.push(Date.now())
      const dataLine = block.split('\n').find((line) => line.startsWith('data: '))
      if (dataLine !== undefined) {
        try {
          const parsed = JSON.parse(dataLine.slice(6))
          if (typeof parsed.text === 'string') texts.push(parsed.text)
        } catch {
          // 载荷不是 JSON 就跳过内容，只记时刻。
        }
      }
    }
  }

  console.log('\n--- 2. 帧数与内容完整性 ---')
  check('收到多帧（说明是流式，不是一次性响应）', recvAt.length >= 10, `${String(recvAt.length)} 帧`)
  /*
   * 内容一个字都不能少。逐帧与攒批都该满足这一条——它是**前置条件**，
   * 不是本脚本的重点，但缺了它后面的判据就没有意义（少了字说明流断了）。
   */
  const joined = texts.join('')
  check('全部 20 段都到了（没有丢帧）', joined.includes('段20。'), `${String(joined.length)} 字`)
  check('第一个字是第 1 段（顺序没乱）', joined.startsWith('段1。'), joined.slice(0, 12))

  console.log('\n--- 3. 帧间隔分布（核心判据）---')
  const gaps = []
  for (let index = 1; index < recvAt.length; index += 1) {
    gaps.push(recvAt[index] - recvAt[index - 1])
  }
  /*
   * 「挤在一起」的阈值取 20ms。
   *
   * 上游节奏是 400ms，所以真正的逐帧到达间隔在几百毫秒量级；20ms 只可能
   * 来自「同一批 flush 里连续写出」。用 20 而不是 100：网络与事件循环的
   * 抖动偶尔会让两帧挨得近，100 会把正常抖动也算成挤批。
   */
  const clumped = gaps.filter((gap) => gap < 20).length
  const ratio = gaps.length === 0 ? 1 : clumped / gaps.length
  /*
   * 允许的比例 30%。
   *
   * 首帧延迟（0.8–2 秒）内的帧本来就该攒着一起放——那是「她还没开口」。
   * 20 段 × 400ms = 8 秒，其中约 5 段落在停顿里，占 25%。留到 30%
   * 既容得下这段设计内的攒批，又抓得住「全部挤在一起」（那会是 95%+）。
   */
  check(
    '大部分帧是分散到达的（不是攒齐后一次蹦出）',
    ratio <= 0.3,
    `${String(clumped)}/${String(gaps.length)} 个间隔 < 20ms（${String(Math.round(ratio * 100))}%）`,
  )
  /*
   * 另一条独立的判据：**首帧延迟之后**的帧必须跟着上游节奏走。
   *
   * 只看整体比例有可能被"前 5 帧挤、后 15 帧散"之外的其他形态蒙过。
   * 这里取「中间那些间隔」的中位数：真流式应该接近 400ms，
   * 攒批则会出现大量 0 与一个巨大的空档，中位数会被拉到很低。
   */
  const sorted = [...gaps].sort((a, b) => a - b)
  const median = sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]
  check(
    '帧间隔中位数接近上游节奏（约 400ms）',
    median >= 150,
    `中位数 ${String(median)} ms`,
  )

  console.log('\n--- 4. 总时长对得上（没有额外的大延迟）---')
  const upstreamSpread = sentAt.length === 0 ? 0 : sentAt[sentAt.length - 1] - sentAt[0]
  const clientSpread = recvAt.length === 0 ? 0 : recvAt[recvAt.length - 1] - recvAt[0]
  /*
   * 客户端跨度不该显著小于上游跨度。
   *
   * 攒批实现的客户端跨度接近 0（全部帧同一时刻到），而逐帧实现接近上游
   * 跨度减去首帧停顿。判据取「不小于上游的一半」——留足首帧停顿的余量。
   */
  check(
    '客户端收到的时间跨度接近上游发送跨度（说明一直在收，不是最后才收）',
    clientSpread >= upstreamSpread * 0.5,
    `上游 ${String(upstreamSpread)} ms / 客户端 ${String(clientSpread)} ms`,
  )

  console.log('')
  if (failures.length === 0) {
    console.log('全部通过。')
  } else {
    console.log(`${String(failures.length)} 条未通过：`)
    for (const label of failures) console.log(`  - ${label}`)
  }
} finally {
  host.kill('SIGTERM')
  upstream.close()
  await new Promise((resolve) => { setTimeout(resolve, 300) })
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
}

process.exit(failures.length === 0 ? 0 : 1)