/**
 * 内核 `system` 参数是否真的送到模型。
 *
 * ## 为什么必须起一个假供应商
 *
 * 「宿主把系统提示词传给了 `inference.run`」与「模型真的收到了它」之间，
 * 隔着一层 `toWireMessages()`。这一层是**纯过滤与改名**，看起来不会出错，
 * 但它恰好是「接了半根线」最爱出事的地方：参数收下了、日志打了、
 * 而真正 `JSON.stringify` 出去时被丢掉了。
 *
 * 只有站在供应商那一侧看请求体，才能确定它到了。所以这里起一个本地
 * HTTP 服务假装是 OpenAI 兼容端点，把收到的 `messages` 原样记下来。
 *
 * ## 验的是什么
 *
 * | 断言 | 防的是什么 |
 * | --- | --- |
 * | system 在最前 | 追加到尾部会变成「说完一轮再被告知你是谁」 |
 * | system 正文一致 | 传了但被截断 / 被转义坏 |
 * | 不落盘 | system 存进历史后，三轮就积累三份人格 |
 * | 空 system 不加消息 | 空 system 会让部分供应商直接 400 |
 *
 * 用法：node tools/check-kernel-system.mjs
 * 退出码：全部通过为 0。
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
 * 假供应商：只回一句固定的流，把请求体记下来
 * ---------------------------------------------------------------- */

/** 最近一次收到的请求体。 */
let lastBody

const server = createServer((request, response) => {
  let raw = ''
  request.setEncoding('utf8')
  request.on('data', (chunk) => { raw += chunk })
  request.on('end', () => {
    try {
      lastBody = JSON.parse(raw)
    } catch {
      lastBody = undefined
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    // 最小可用的 SSE：一个内容增量 + 一个结束标记。
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '好' } }] })}\n\n`)
    response.write('data: [DONE]\n\n')
    response.end()
  })
})

const port = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    resolve(server.address().port)
  })
})

/* ---------------------------------------------------------------- *
 * 起内核
 * ---------------------------------------------------------------- */

const entry = join(import.meta.dirname, '..', 'dsh-sidecar', 'lib', 'index.js')
const dataDir = await mkdtemp(join(tmpdir(), 'ondra-kernel-system-'))
const child = spawn(process.execPath, [entry], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ONDRA_DATA_DIR: dataDir },
})

const responses = new Map()
const waiters = new Map()
let buffer = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let at = buffer.indexOf('\n')
  while (at !== -1) {
    const line = buffer.slice(0, at).trim()
    buffer = buffer.slice(at + 1)
    at = buffer.indexOf('\n')
    if (line === '') continue
    const message = JSON.parse(line)
    if ('id' in message && message.id !== null) {
      responses.set(message.id, message)
      waiters.get(message.id)?.(message)
      waiters.delete(message.id)
    }
  }
})
child.stderr.setEncoding('utf8')
const kernelStderr = []
child.stderr.on('data', (chunk) => {
  kernelStderr.push(String(chunk))
  process.stderr.write(`[dsh] ${chunk}`)
})

let nextId = 1
async function call(method, params) {
  const id = nextId
  nextId += 1
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`超时：${method}`)) }, 15000)
    waiters.set(id, (message) => {
      clearTimeout(timer)
      if (message.error !== undefined) reject(new Error(message.error.message ?? '未知错误'))
      else resolve(message.result)
    })
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return await promise
}

/** 等内核就绪。 */
async function waitReady() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await call('kernel.ping', {})
      return
    } catch {
      await new Promise((resolve) => { setTimeout(resolve, 100) })
    }
  }
  throw new Error('内核没有在 10 秒内就绪')
}

try {
  await waitReady()
  await call('kernel.handshake', { protocolVersion: '1.0', client: 'check', clientVersion: '2.1.2' })

  await call('model.configure', {
    profiles: [{ id: 'fake/local', label: '假供应商', baseUrl: `http://127.0.0.1:${String(port)}/v1`, model: 'fake' }],
  })
  await call('model.select', { id: 'fake/local' })

  const session = await call('session.create', { title: '' })

  console.log('=== 内核 system 参数 · 端到端核对 ===')

  /* -------------------------------------------------------------- *
   * 1. system 被送到供应商，且在最前
   * -------------------------------------------------------------- */

  console.log('\n--- 1. system 是否到达 ---')
  const marker = '系统提示词标记·她叫鲸鲸'
  lastBody = undefined
  await call('inference.run', { sessionId: session.id, input: '你好', system: marker })

  check('供应商收到了请求体', lastBody !== undefined)
  const wire = Array.isArray(lastBody?.messages) ? lastBody.messages : []
  check('请求体含消息', wire.length >= 2, `${String(wire.length)} 条`)
  /*
   * 这一条是本轮的核心：`toWireMessages()` 只 filter 掉 `tool` 角色再 map，
   * 若它的实现被改成「只保留 user / assistant」，system 会被静默丢掉，
   * 而上面所有链路看起来都正常。
   */
  check('第一条是 system', wire[0]?.role === 'system', String(wire[0]?.role))
  check('system 正文与传入一致', wire[0]?.content === marker)
  check('user 消息在 system 之后', wire[1]?.role === 'user', String(wire[1]?.role))

  /* -------------------------------------------------------------- *
   * 2. system 不落盘
   * -------------------------------------------------------------- */

  console.log('\n--- 2. system 不落盘 ---')
  const stored = await call('session.messages', { sessionId: session.id })
  /*
   * 落库的应当只有 user 与 assistant 两条。
   *
   * 若 system 被存进去，下一轮读历史时会把它当普通消息再喂一遍——
   * 三轮之后模型收到三份人格，而会话文件也会涨到不该有的体积。
   * 这个缺陷在界面上完全看不出来，只能在这里抓。
   */
  check('历史只有 user 与 assistant', stored.length === 2, stored.map((item) => item.role).join(' → '))
  check('历史里没有 system', !stored.some((item) => item.role === 'system'))

  /* -------------------------------------------------------------- *
   * 3. 空 system 不产生空消息
   * -------------------------------------------------------------- */

  console.log('\n--- 3. 空 system ---')
  lastBody = undefined
  await call('inference.run', { sessionId: session.id, input: '再说一句', system: '   ' })

  const wire2 = Array.isArray(lastBody?.messages) ? lastBody.messages : []
  /*
   * 纯空白的 system 必须被当作「没传」。
   *
   * 有些供应商收到 `{role:'system',content:''}` 会直接 400。宿主的装配函数
   * 在无来源时返回空串，宿主按「空串不传」处理，内核这一层是第二道保险。
   */
  check('空白 system 不产生 system 消息', !wire2.some((item) => item.role === 'system'), wire2.map((item) => item.role).join(' → '))
  check('本轮 user 消息仍到达', wire2.some((item) => item.role === 'user' && item.content === '再说一句'))

  /* -------------------------------------------------------------- *
   * 4. nudge 与 system 并存时顺序正确
   * -------------------------------------------------------------- */

  console.log('\n--- 4. system 与 nudge 顺序 ---')
  lastBody = undefined
  await call('inference.run', {
    sessionId: session.id,
    system: '人格段',
    nudge: '现在轮到你开口',
  })

  const wire3 = Array.isArray(lastBody?.messages) ? lastBody.messages : []
  const systemIndex = wire3.findIndex((item) => item.role === 'system' && item.content === '人格段')
  const nudgeIndex = wire3.findIndex((item) => item.role === 'system' && item.content === '现在轮到你开口')
  /*
   * 人格必须在 nudge 之前。反过来的话，模型读到的第一句是「现在轮到你开口」，
   * 人设还没到位——主动开口那一轮的语气会明显比回话时生硬，而极难归因。
   */
  check('人格段在 nudge 之前', systemIndex !== -1 && nudgeIndex !== -1 && systemIndex < nudgeIndex,
    `system@${String(systemIndex)} nudge@${String(nudgeIndex)}`)

  /* -------------------------------------------------------------- *
   * 5. 落盘文件本身不含人格正文
   * -------------------------------------------------------------- */

  console.log('\n--- 5. 磁盘文件 ---')
  const files = (await readdir(dataDir)).filter((name) => name.endsWith('.json'))
  check('会话已写入磁盘', files.length === 1, files[0])
  if (files.length === 1) {
    const raw = await readFile(join(dataDir, files[0]), 'utf8')
    /*
     * 直接查磁盘原文，而不是查解析后的对象：序列化方式若把 system 塞进
     * 某个嵌套字段，解析后按 role 找会漏掉，而原文里一定看得见。
     */
    check('磁盘原文不含人格标记', !raw.includes(marker) && !raw.includes('人格段'))
  }
} finally {
  try {
    await call('kernel.shutdown', {})
  } catch {
    // 内核可能已经退出，忽略。
  }
  child.kill()
  server.close()
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
