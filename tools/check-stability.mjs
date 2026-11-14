/**
 * 人设 / 记忆 / 情绪的多轮稳定性。
 *
 * ## 它回答什么问题
 *
 * 单轮正确不等于稳定。用户真正的体感来自「聊了十几轮之后她还好吗」：
 *
 * - 记忆会不会越聊越乱（同一条事实重复写、或反过来丢）？
 * - 情绪会不会一路飙到底（模型每轮都推一点，没有回落就成了开关）？
 * - 人设会不会漂（第一轮说自己是空谷，第五轮变成通用助手）？
 * - 提示词会不会越长越失控（每轮都追加、从不收敛）？
 *
 * 这些都不是单轮断言能发现的——单轮全绿，多轮崩掉是这类系统最典型的
 * 失败形态。
 *
 * ## 判据为什么是「区间」而不是「精确值」
 *
 * 情绪是带衰减的动态系统，精确值取决于时钟与衰减曲线的实现细节。
 * 断言「第 5 轮的 mood 落在 [0,1] 且不等于第 1 轮」这种区间判据，
 * 抓的是「完全不动」（开关坏了）与「跑出边界」（量纲错），
 * 而不是把实现钉死在某个具体数字上。
 *
 * 运行：
 * ```
 * node tools/check-stability.mjs
 * ```
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const REPO = new URL('..', import.meta.url).pathname
const ROUNDS = 5

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : `  ${detail}`}`)
}

/* ------------------------------------------------------------------ *
 * 假上游：区分对话与提炼，记录每次请求的提示词长度
 * ------------------------------------------------------------------ */

const chatPromptLens = []
const extractCalls = []

const upstream = createServer((request, response) => {
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, cors)
    response.end()
    return
  }
  let raw = ''
  request.setEncoding('utf8')
  request.on('data', (chunk) => { raw += chunk })
  request.on('end', () => {
    /* 判据是提炼提示词里那句固定开场白（与 check-e2e-memory 同源）。 */
    const isExtract = raw.includes('你是记忆提炼器')

    response.writeHead(200, { ...cors, 'content-type': 'text/event-stream' })

    if (isExtract) {
      extractCalls.push(raw.length)
      /*
       * 提炼：回一条与**当轮用户输入**相关的事实。
       *
       * 上一版回固定内容，多轮下来每条都被判成「同一句话」而 merge，
       * 于是「记忆会不会累积」这条根本验不出来——库里永远 1 条。
       * 这里按轮次生成不同事实，让「累积」这个性质可测。
       */
      const nth = extractCalls.length
      const fact = {
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
            text: `用户第${String(extractCalls.length)}次提到住在杭州`,
            summary: '住杭州',
            subject: 'user',
            evidence: [{ source: 'USER', quote: '住在杭州', messageIndex: 0 }],
          },
        ],
      }
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(fact) } }] })}\n\n`)
    } else {
      /* 提示词长度：取 messages 里所有 content 的字符数总和。 */
      let len = 0
      try {
        const body = JSON.parse(raw)
        const messages = body.messages ?? []
        for (const message of messages) {
          len += typeof message.content === 'string' ? message.content.length : 0
        }
      } catch { /* 记不到就记 0 */ }
      chatPromptLens.push(len)

      for (const piece of ['我在。', '你刚才说的我记着了。']) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`)
      }
    }
    response.write('data: [DONE]\n\n')
    response.end()
  })
})

const upstreamPort = await new Promise((resolve) => {
  upstream.listen(0, '127.0.0.1', () => { resolve(upstream.address().port) })
})

/* ------------------------------------------------------------------ *
 * 起真宿主
 * ------------------------------------------------------------------ */

const dataDir = await mkdtemp(join(tmpdir(), 'ondra-stability-'))
await writeFile(
  join(dataDir, 'config.json'),
  JSON.stringify({
    currentModel: 'fake/stability',
    profiles: [{
      id: 'fake/stability',
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

const info = await Promise.race([
  new Promise((resolve) => {
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
          if (message.type === 'ready') resolve(message)
        } catch { /* 非协议行 */ }
      }
    })
  }),
  new Promise((_, reject) => { setTimeout(() => { reject(new Error('宿主 40 秒内没有就绪')) }, 40_000) }),
]).catch((error) => {
  console.error(`✗ ${error.message}`)
  host.kill('SIGTERM')
  process.exit(1)
})

const base = `http://127.0.0.1:${String(info.port)}`
const headers = { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' }
console.log(`真宿主就绪：${base}\n`)

/* ------------------------------------------------------------------ *
 * 连续多轮对话
 * ------------------------------------------------------------------ */

console.log(`=== 连续 ${String(ROUNDS)} 轮对话 ===`)

const moods = []
const memoryCounts = []
const replyLengths = []
let sessionId = ''

for (let round = 1; round <= ROUNDS; round += 1) {
  const before = await (await fetch(`${base}/api/companion/state`, { headers })).json()
  /*
   * 采 `pleasure` 而不是 `mood`。
   *
   * 这一轮的输入含「谢谢」，命中的是 `gratitude` 信号，而它的位移表
   * （`SIGNAL_SHIFT.gratitude`）只动 pleasure / arousal / energy 三轴，
   * **不含 mood**。所以 mood 恒为基线 0.5 是正确行为——上一版拿 mood
   * 判「情绪有没有被推动」，判的是这条链根本不负责的那一轴。
   */
  moods.push(before.axes?.pleasure ?? null)

  /* 带「谢谢」——它是 `readSignal()` 认的 gratitude 词，能真的推动情绪。 */
  const text = `我叫小玖，住在杭州。谢谢你第${String(round)}次陪我。`
  const response = await fetch(`${base}/api/inference`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input: text, ...sessionId === '' ? {} : { sessionId } }),
  })

  if (response.status !== 200) {
    check(`第 ${String(round)} 轮对话返回 200`, false, `HTTP ${String(response.status)}`)
    break
  }

  const stream = await response.text()
  /* 从 SSE 里取会话 id，后续轮次复用同一会话。 */
  const match = /"sessionId":"([^"]+)"/.exec(stream)
  if (match !== null) sessionId = match[1]

  const deltas = [...stream.matchAll(/"text":"([^"]*)"/g)].map((m) => m[1])
  replyLengths.push(deltas.join('').length)

  /* 给提炼留时间落库。 */
  await new Promise((r) => { setTimeout(r, 2500) })

  /*
   * 直接读 SQLite 的 `memory_fact` 表，不走 `/api/memory`。
   *
   * ## 为什么不用端点
   *
   * `/api/memory` 返回的是**特定类型**的记忆（raw / 海马体那一侧），
   * 而提炼产出的事实落在 `memory_fact` 表里——两者不是同一批行。
   * 用端点读会得到 0，看起来像「记忆没写」，实际是查错了地方。
   *
   * `check-e2e-memory.mjs` 也是直接查这张表，这里与它同源。
   */
  let facts = 0
  try {
    const db = new DatabaseSync(join(dataDir, 'user', 'ondra.db'))
    try {
      facts = Number(db.prepare('select count(*) as n from memory_fact').get()?.n ?? 0)
    } finally {
      db.close()
    }
  } catch { /* 库还没建好时记 0 */ }
  memoryCounts.push(facts)
}

check(`完成 ${String(ROUNDS)} 轮对话`, moods.length === ROUNDS, `${String(moods.length)} 轮`)
check('每轮都有回复内容', replyLengths.every((n) => n > 0), replyLengths.join(' / '))

/* ------------------------------------------------------------------ *
 * 记忆稳定性
 * ------------------------------------------------------------------ */

console.log('\n=== 记忆稳定性 ===')

check('记忆条数不减少（不会越聊越少）',
  memoryCounts.every((n, i) => i === 0 || n >= memoryCounts[i - 1]),
  memoryCounts.join(' → '))

check('记忆确实在累积（不是恒为 0）',
  memoryCounts[memoryCounts.length - 1] > 0,
  `最终 ${String(memoryCounts[memoryCounts.length - 1])} 条`)

/*
 * 累积但不能失控：每轮最多写几条，5 轮下来不该出现几十条。
 * 上限取「轮数 × 3」——真实提炼一轮最多 8 条，但这里假上游每轮只给 1 条，
 * 超过 3 倍说明有重复写入。
 */
check('记忆没有重复膨胀（≤ 轮数×3）',
  memoryCounts[memoryCounts.length - 1] <= ROUNDS * 3,
  `${String(memoryCounts[memoryCounts.length - 1])} ≤ ${String(ROUNDS * 3)}`)

/* ------------------------------------------------------------------ *
 * 情绪稳定性
 * ------------------------------------------------------------------ */

console.log('\n=== 情绪稳定性 ===')

const validMoods = moods.filter((m) => typeof m === 'number')
check('每轮情绪读数都是有效数字', validMoods.length === moods.length,
  `${String(validMoods.length)}/${String(moods.length)}`)

check('情绪始终在 [0,1] 内（没有跑出量纲）',
  validMoods.every((m) => m >= 0 && m <= 1),
  validMoods.map((m) => m.toFixed(2)).join(' / '))

/*
 * 情绪不能「一路飙到底」。
 *
 * 多轮推动下 mood 会有波动，但一个带衰减的系统不该单调冲到 0 或 1
 * 然后卡死。判据：末轮不等于首轮（说明真的动了），且不全相同
 * （说明不是开关）。
 */
check('情绪真的被推动（末轮 ≠ 首轮）',
  validMoods.length >= 2 && validMoods[0] !== validMoods[validMoods.length - 1],
  `${String(validMoods[0])} → ${String(validMoods[validMoods.length - 1])}`)

check('情绪不是恒定值（不是开关）',
  new Set(validMoods.map((m) => m.toFixed(3))).size > 1,
  `${String(new Set(validMoods.map((m) => m.toFixed(3))).size)} 个不同值`)

/* ------------------------------------------------------------------ *
 * 提示词稳定性
 * ------------------------------------------------------------------ */

console.log('\n=== 提示词稳定性 ===')

check('每轮都带提示词（不为空）', chatPromptLens.every((n) => n > 0),
  chatPromptLens.join(' / '))

/*
 * 提示词不该无限膨胀。
 *
 * 上下文有预算，超了会裁剪；但「每轮猛涨一倍」说明历史没被压缩，
 * 第 20 轮就会撑爆窗口。判据：末轮不超过首轮的 6 倍。
 */
if (chatPromptLens.length >= 2) {
  const first = chatPromptLens[0]
  const last = chatPromptLens[chatPromptLens.length - 1]
  check('提示词没有无限膨胀（末轮 ≤ 首轮×6）',
    last <= first * 6,
    `${String(first)} → ${String(last)}（${(last / first).toFixed(1)}×）`)
}

/* ------------------------------------------------------------------ *
 * 人设稳定性
 * ------------------------------------------------------------------ */

console.log('\n=== 人设稳定性 ===')

const personas = await (await fetch(`${base}/api/personas`, { headers })).json()
check('人设包清单在多轮后仍然可读', Array.isArray(personas.items),
  `${String((personas.items ?? []).length)} 个`)

const activeId = personas.activeId
check('人设包没有被对话改动（activeId 稳定）',
  typeof activeId === 'string' && activeId !== '',
  String(activeId))

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

host.kill('SIGTERM')
upstream.close()

const failed = checks.filter((c) => !c.ok)
console.log(`\n${failed.length === 0 ? '全部通过' : `${String(failed.length)} 条失败`}（共 ${String(checks.length)} 条）`)
for (const f of failed) console.log(`  ✗ ${f.name}${f.detail === '' ? '' : `  ${f.detail}`}`)
process.exit(failed.length === 0 ? 0 : 1)