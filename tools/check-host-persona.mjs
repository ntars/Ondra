/**
 * 宿主级端到端：从 HTTP 接口进去，看人格是否真的走到供应商那一侧。
 *
 * ## 这个脚本要证明的唯一一件事
 *
 * 前面两个脚本各自证明了一段：
 * - `check-system-prompt.mjs`：宿主**拼得出**人格（读插件视图）。
 * - `check-kernel-system.mjs`：内核**送得进** system（假供应商看请求体）。
 *
 * 但它们之间的那一根线——`POST /api/inference` 里那句
 * `assembleSystemPrompt(ctx)` 的返回值有没有真的塞进 `inference.run`——**没被验过**。
 * 而本仓库反复踩的就是这个形态：「A 写、B 读、中间少根线」，两侧都不报错。
 *
 * 所以这里起完整的三层（宿主 + 内核 + 假供应商），从 HTTP 打进去，
 * 站在供应商一侧核对人格正文。这是唯一不能造假的口径。
 *
 * ## 为什么不复用 `smoke.mjs`
 *
 * `smoke.mjs` 走的是本地演示模型（`local/echo`），它**不联网、不看 system**，
 * 所以「人格有没有送到」在它那里恒不可见。必须换成会真发 HTTP 的供应商。
 *
 * 用法：node tools/check-host-persona.mjs
 * 退出码：全部通过为 0。
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
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
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '在。' } }] })}\n\n`)
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

const dataDir = await mkdtemp(join(tmpdir(), 'ondra-host-persona-'))
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

const hostStderr = []
host.stderr.setEncoding('utf8')
host.stderr.on('data', (chunk) => {
  hostStderr.push(String(chunk))
  process.stderr.write(`[host] ${chunk}`)
})

async function request(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, text }
}

try {
  console.log('=== 宿主级人格送达 · 端到端核对 ===')

  const info = await Promise.race([
    readyPromise,
    new Promise((_, reject) => { setTimeout(() => { reject(new Error('宿主 30 秒内没有就绪')) }, 30000) }),
  ])
  const base = `http://127.0.0.1:${String(info.port)}`
  const headers = { authorization: `Bearer ${info.token}` }
  console.log(`宿主就绪：${base}`)

  /** 带鉴权头的 POST。 */
  async function post(path, body) {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    return { status: response.status, text: await response.text() }
  }

  /* -------------------------------------------------------------- *
   * 1. 把供应商指向假端点
   * -------------------------------------------------------------- */

  const configured = await post('/api/config/profiles', {
    profiles: [{
      id: 'fake/persona',
      label: '假供应商',
      baseUrl: `http://127.0.0.1:${String(upstreamPort)}/v1`,
      model: 'fake',
      apiKey: 'test',
    }],
  })
  check('配置供应商成功', configured.status === 200, `HTTP ${String(configured.status)}`)

  const selected = await post('/api/models/select', { id: 'fake/persona' })
  check('选中供应商成功', selected.status === 200, `HTTP ${String(selected.status)}`)

  /* -------------------------------------------------------------- *
   * 2. 走一轮真实对话，站在供应商一侧核对
   * -------------------------------------------------------------- */

  console.log('\n--- 2. 一轮真实对话 ---')
  bodies.length = 0
  const run = await post('/api/inference', { input: '你在吗' })
  /*
   * 这个接口返回 SSE。只要 HTTP 200 且最后有 done 帧，就算这一轮跑通。
   * 不解析正文：本轮验的是「人格送到没送到」，不是「她答得对不对」。
   */
  check('推理接口返回 200', run.status === 200, `HTTP ${String(run.status)}`)
  check('这一轮真的打到了供应商', bodies.length >= 1, `${String(bodies.length)} 次请求`)

  const wire = Array.isArray(bodies[0]?.messages) ? bodies[0].messages : []
  const systemWire = wire.find((item) => item.role === 'system')
  check('供应商收到 system 消息', systemWire !== undefined, wire.map((item) => item.role).join(' →'))
  check('第一条消息是 system', wire[0]?.role === 'system', String(wire[0]?.role))

  /*
   * 这一条是本脚本的核心断言。
   *
   * 只验「有 system」不够：任何一句兜底话都能让它通过。要验**人格正文本身**
   * 到了供应商手里，只能按人设包的特征串去找。
   *
   * 「人格内核」是 `ondra-persona-assemble` 给第一段加的固定小标题
   * （见 `sections.ts` 的 `headingOf`），不是内容生成出来的——
   * 用人设包里某个具体句子做判据，换人设包就会红，而红的是测试。
   */
  check('system 正文含人格段标题', typeof systemWire?.content === 'string' && systemWire.content.includes('人格内核'),
    `${String(systemWire?.content?.length ?? 0)} 字`)
  check('system 正文有实质长度（> 300 字）', (systemWire?.content?.length ?? 0) > 300, `${String(systemWire?.content?.length ?? 0)} 字`)

  /* -------------------------------------------------------------- *
   * 3. 默认预算下人格必须完整（2026-11-08 第二十段改）
   * -------------------------------------------------------------- */

  console.log('\n--- 3. 默认预算下人格完整 ---')
  /*
   * 这一段原先断的是**反面**：默认 2600 下必然裁剪，所以要看到 stderr 里
   * 「人格未完整加载」。那条断言钉的是当时的缺陷，缺陷修掉之后它必然变红——
   * 而红的是测试，不是产品。所以这里按新的事实反过来写。
   *
   * 判据为什么用长度而不是「含某个句子」：用人设包里的具体话做判据，
   * 换一个包就红。出厂包（哦鲸鲸）完整装载实测 7,725 字，取 6,000 作下限，
   * 既容忍关系 / 浓度段的少量浮动，又仍能抓住「说话段被整段砍掉」这一类退化
   * （那就只剩 3,964 字）。
   *
   * 等 200ms 再读 stderr：日志是宿主 stderr 上的异步流，响应 body 收完不代表
   * 那一行已经到本进程。不等会得到「时红时绿」的断言——最难查的一种。
   */
  await new Promise((resolve) => { setTimeout(resolve, 200) })
  const stderrText = hostStderr.join('')
  check('默认预算下人格未被裁剪', !stderrText.includes('人格未完整加载'),
    stderrText.includes('人格未完整加载') ? '出现了裁剪提示' : undefined)
  check('system 正文达到完整装载量（> 6000 字）', (systemWire?.content?.length ?? 0) > 6000,
    `${String(systemWire?.content?.length ?? 0)} 字`)

  /* -------------------------------------------------------------- */
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
