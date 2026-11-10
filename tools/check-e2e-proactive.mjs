/**
 * 宿主级端到端：从一句真实的话，到她主动拿它开口。
 *
 * ## 这个脚本要证明的唯一一件事
 *
 * ```
 * 用户说「明天提醒我把合同打印出来」
 *   → 待办入库
 *   → 门控放行并给出「你交代过的事」这个由头
 *   → 模型真的收到了这句由头
 * ```
 *
 * 这条链在纸面上有四段，每段都有自己的检查脚本，但**中间那根线**
 * ——「谁把一轮真实对话送进插件总线」——从来没有被验过，而它一直是断的：
 * `session/event` 在整仓里只有订阅方、没有发出方。症状不是报错，是
 * 六张表从建库起一直 0 行，所有单元级检查都绿（它们各自直接调
 * `intake.ingest()`，绕过了「谁触发」这一环）。
 *
 * ## 为什么必须从 HTTP 打进去
 *
 * 前三段各自的脚本都是直接调服务：`intake.ingest()` → `plan()` → `gate()`。
 * 那样验的是「服务能工作」，不是「应用会用它」。本仓反复踩的形态正是
 * 「A 写、B 读、中间少根线」——只有从最外层打进去、再从最外层读结果，
 * 才能抓到少掉的那根线。
 *
 * ## 为什么读 sqlite 而不读插件视图
 *
 * 宿主是独立进程，插件视图拿不到。库文件是唯一跨进程的真实证据，而且
 * 它恰好也能证明「真的落盘了」——内存态下插件视图照样好看。
 *
 * 用法：node tools/check-e2e-proactive.mjs
 * 退出码：全部通过为 0。
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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
 * 假供应商
 * ---------------------------------------------------------------- */

/** 每次请求的请求体，按时间顺序。 */
const bodies = []

const upstream = createServer((request, response) => {
  let raw = ''
  request.setEncoding('utf8')
  request.on('data', (chunk) => { raw += chunk })
  request.on('end', () => {
    try {
      bodies.push(JSON.parse(raw))
    } catch {
      bodies.push(undefined)
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const line = bodies.length === 1 ? '好，我记着了。' : '嗯，合同的事我没忘。'
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: line } }] })}\n\n`)
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

const dataDir = await mkdtemp(join(tmpdir(), 'ondra-e2e-proactive-'))
const host = spawn(process.execPath, [join(import.meta.dirname, '..', 'cordis-host', 'lib', 'index.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ONDRA_DATA_DIR: dataDir },
})

let stdoutBuffer = ''
let ready
const readyPromise = new Promise((resolve) => { ready = resolve })

host.stdout.setEncoding('utf8')
host.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk
  let at = stdoutBuffer.indexOf('\n')
  while (at !== -1) {
    const line = stdoutBuffer.slice(0, at).trim()
    stdoutBuffer = stdoutBuffer.slice(at + 1)
    at = stdoutBuffer.indexOf('\n')
    if (line === '') continue
    try {
      const message = JSON.parse(line)
      if (message.type === 'ready') ready(message)
    } catch {
      // 非协议行忽略。
    }
  }
})

const stderrChunks = []
host.stderr.setEncoding('utf8')
host.stderr.on('data', (chunk) => { stderrChunks.push(String(chunk)) })

/** 从 SSE 文本里取会话 id（`event: session` 那一帧）。 */
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

try {
  console.log('=== 主动开口端到端 · 从一句话到她开口 ===')

  const info = await Promise.race([
    readyPromise,
    new Promise((_, reject) => { setTimeout(() => { reject(new Error('宿主 30 秒内没有就绪')) }, 30000) }),
  ])
  const base = `http://127.0.0.1:${String(info.port)}`
  const headers = { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' }
  console.log(`宿主就绪：${base}`)

  /** 带鉴权头的 POST。 */
  async function post(path, body) {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    return { status: response.status, text: await response.text() }
  }

  /* -------------------------------------------------------------- *
   * 1. 一轮真实对话
   * -------------------------------------------------------------- */

  console.log('\n--- 1. 用户交代一件事 ---')

  const configured = await post('/api/config/profiles', {
    profiles: [{
      id: 'fake/e2e',
      label: '假供应商',
      baseUrl: `http://127.0.0.1:${String(upstreamPort)}/v1`,
      model: 'fake',
      apiKey: 'test',
    }],
  })
  check('配置供应商成功', configured.status === 200, `HTTP ${String(configured.status)}`)

  const selected = await post('/api/models/select', { id: 'fake/e2e' })
  check('选中供应商成功', selected.status === 200, `HTTP ${String(selected.status)}`)

  /** 用户真正说的那句话。后面每条断言都要能在这句话上找到落点。 */
  const SPOKEN = '明天提醒我把合同打印出来。'

  const turn = await post('/api/inference', { input: SPOKEN })
  check('对话接口返回 200', turn.status === 200, `HTTP ${String(turn.status)}`)
  const sessionId = sessionIdOf(turn.text)
  check('拿到会话 id', sessionId !== '', sessionId)

  /*
   * 等落库。`intake` 的 `flush()` 是 fire-and-forget，回复流完之后才开始写。
   * 不等待会得到「时红时绿」的断言——最难查的一种，本仓已踩过两次。
   */
  await new Promise((resolve) => { setTimeout(resolve, 1500) })

  /* -------------------------------------------------------------- *
   * 2. 库里的真实证据
   * -------------------------------------------------------------- */

  console.log('\n--- 2. 这句话真的进了库 ---')

  const dbPath = join(dataDir, 'user', 'ondra.db')
  const db = new DatabaseSync(dbPath)
  let rawRows = 0
  let todoTexts = []
  try {
    rawRows = db.prepare('select count(*) as n from memory_raw').get().n
    todoTexts = db.prepare('select text from working_todo').all().map((row) => String(row.text))
  } finally {
    db.close()
  }

  /*
   * 断言用的是「有没有真的写进去」，不是「表存不存在」。
   *
   * 表在很久以前就建好了（`memory_raw` / `working_todo` 都在），
   * 一直是 0 行——而「表存在」这件事会让任何 `tableExists` 类的断言恒绿。
   */
  check('原文进了 memory_raw', rawRows >= 2, `${String(rawRows)} 行（用户与她各一条）`)
  check('待办进了 working_todo', todoTexts.length >= 1, `${String(todoTexts.length)} 行`)
  check('待办正文就是那句话', todoTexts.some((text) => text.includes('合同')), todoTexts.join(' / ') || '（空）')

  /* -------------------------------------------------------------- *
   * 3. 门控给出这个由头
   * -------------------------------------------------------------- */

  console.log('\n--- 3. 主动判定拿这件事当由头 ---')

  const checked = await post('/api/proactive/check', { sessionId, idleMinutes: 40 })
  const verdict = JSON.parse(checked.text)
  check('判定放行', verdict.allow === true, `code=${String(verdict.code)}`)
  /*
   * 判据必须是「由头种类」而不是记账话术。
   *
   * 修之前这里是「放行（今日主动 0/3）」——那不是解释，是内部账本。
   * 而它恒不为空的特性会让「有没有由头」这件事在断言里看不出来。
   */
  check('判据是由头种类而不是额度话术', verdict.reason === '你交代过的事', String(verdict.reason))
  check('由头正文带着那件事', typeof verdict.text === 'string' && verdict.text.includes('合同'), String(verdict.text))

  /* -------------------------------------------------------------- *
   * 4. 模型真的收到这句由头
   * -------------------------------------------------------------- */

  console.log('\n--- 4. 她开口时模型收到了这句由头 ---')

  bodies.length = 0
  const speak = await post('/api/inference', {
    sessionId,
    proactive: true,
    nudge: verdict.text,
  })
  check('主动开口接口返回 200', speak.status === 200, `HTTP ${String(speak.status)}`)
  check('这一轮真的打到了供应商', bodies.length >= 1, `${String(bodies.length)} 次请求`)

  const wire = Array.isArray(bodies[0]?.messages) ? bodies[0].messages : []
  const systemTexts = wire.filter((item) => item.role === 'system').map((item) => String(item.content))
  const allText = systemTexts.join('\n')

  check('请求体里有 system 消息', systemTexts.length >= 1, `${String(systemTexts.length)} 条`)
  check('由头真的进了模型上下文', allText.includes('合同'), `${String(allText.length)} 字`)
  /*
   * 「想问问你交代过的事」是宿主 `reasonToText()` 给 `todo` 那一支的固定措辞。
   * 用它而不是「主动」这类泛词：后者在任何一轮里都可能出现，钉不住。
   */
  check('由头带着 todo 那一支的措辞', allText.includes('你交代过的事'), '')

  /* -------------------------------------------------------------- *
   * 5. 反证：主动那一轮不该再造一条用户消息
   * -------------------------------------------------------------- */

  console.log('\n--- 5. 她自说自话不进记忆 ---')

  /*
   * 主动开口时用户没说话。若宿主照发 `user/message`，记忆链会把她的
   * 自言自语当成用户交代的事——「她记得自己说过什么」，而那不是事实。
   *
   * 判据是**待办条数没有增加**。用绝对值（「还是那一条」）而不是
   * 「大于 0」：后者在「每轮都多记一条」这个缺陷下照样绿。
   */
  await new Promise((resolve) => { setTimeout(resolve, 800) })
  const db2 = new DatabaseSync(dbPath)
  let todosAfter = 0
  let rawAfter = 0
  try {
    todosAfter = db2.prepare('select count(*) as n from working_todo').get().n
    rawAfter = db2.prepare('select count(*) as n from memory_raw').get().n
  } finally {
    db2.close()
  }
  check('主动那一轮没有新增待办', todosAfter === todoTexts.length, `${String(todoTexts.length)} → ${String(todosAfter)}`)
  check('主动那一轮没有新增原文', rawAfter === rawRows, `${String(rawRows)} → ${String(rawAfter)}`)
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
