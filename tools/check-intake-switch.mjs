/**
 * 记忆收编的开关：关掉之后必须**一行都不收**。
 *
 * ## 这个脚本要证明的一件事
 *
 * ```
 * 「收对话进记忆」= 关
 *      → memory_raw 不涨（一个字都不落）
 *      → 诊断里 intake.available = false、reason = disabled
 * ```
 *
 * ## 为什么需要它
 *
 * `ondra-memory-intake` 的开关此前只影响**别人问它能不能用**时的回答，
 * 不影响**谁在调用它**：轮次结束时那次 `void flush(...)` 是直接调的，
 * 不经过 `available`。于是设置页写着「已关」、右栏写着「暂无记忆」、
 * 而库里 `memory_raw` 一直在长——三处都能自洽，只有用户的话被忽略了。
 *
 * 这不是「显示错了」，是**隐私面开关没有生效**：用户说别记了，还在记。
 * 第 2 轮 TTS「不出声」、第 5 轮「旁路没接上」都是同一个形态的变体——
 * 判据存在、服务正常、中间那根线没接。
 *
 * ## 为什么必须起两个宿主
 *
 * 插件在 `apply()` 时把配置定死，运行期改 `settings.json` 不会回头通知它。
 * 所以「关掉」这件事只能靠**预写用户层再启动**来复现，这也正是用户的
 * 真实使用路径（设置页保存 → 重启生效）。
 *
 * ## 为什么判据落在库里的行数
 *
 * `stats().skipped` 与服务自述的 `available` 都是**自报**的量。自报说
 * 「我没收」和真的没收是两件事——第 3 轮就是靠「只看 `available`」
 * 让这条缺陷绿了整整一轮。唯一不会被自己骗过的是写完之后去数库。
 *
 * 用法：node tools/check-intake-switch.mjs
 * 退出码：全部通过为 0。
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/* ---------------------------------------------------------------- *
 * 前置闸门：产物必须新于源码
 * ---------------------------------------------------------------- */

const ROOT = join(import.meta.dirname, '..')
const INTAKE = join(ROOT, 'cordis-host', 'plugins', 'ondra-memory-intake')

for (const [source, artifact] of [
  [join(INTAKE, 'src', 'index.ts'), join(INTAKE, 'lib', 'index.js')],
  [join(ROOT, 'cordis-host', 'index.ts'), join(ROOT, 'cordis-host', 'lib', 'index.js')],
]) {
  if (!existsSync(artifact)) {
    console.log('=== 前置闸门 · 产物过期 ===')
    console.log(`  ✗ 产物不存在（${artifact}）`)
    console.log('  先执行：pnpm run build:plugins && pnpm run build:host')
    process.exit(1)
  }
  const lag = statSync(source).mtimeMs - statSync(artifact).mtimeMs
  if (lag > 2000) {
    console.log('=== 前置闸门 · 产物过期 ===')
    console.log(`  ✗ ${source} 比产物新 ${String(Math.round(lag / 1000))} 秒`)
    console.log('  先执行：pnpm run build:plugins && pnpm run build:host')
    process.exit(1)
  }
}

/* ---------------------------------------------------------------- *
 * 假上游：只回一句普通回复（本脚本不关心提炼出什么）
 * ---------------------------------------------------------------- */

const upstream = createServer((request, response) => {
  request.resume()
  request.on('end', () => {
    const text = '好，我记着了。'
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
 * 断言与宿主
 * ---------------------------------------------------------------- */

const failures = []
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${label}${detail === undefined ? '' : `（${detail}）`}`)
  } else {
    console.log(`  ✗ ${label}${detail === undefined ? '' : `（${detail}）`}`)
    failures.push(label)
  }
}

const hosts = []

/**
 * 起一个宿主、配好假供应商、说一句话、等收编落定。
 * @param userLayer 写进 `settings.json` 的用户层；`{}` 表示全默认。
 * @returns 库里的 `memory_raw` 行数与诊断读数。
 */
async function runTurn(userLayer) {
  const dataDir = await mkdtemp(join(tmpdir(), 'ondra-intake-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ user: userLayer }), 'utf8')

  const child = spawn(process.execPath, [join(ROOT, 'cordis-host', 'lib', 'index.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ONDRA_DATA_DIR: dataDir },
  })
  hosts.push({ child, dataDir })

  let buffer = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', () => {})

  const info = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('宿主 30 秒内没有就绪')) }, 30000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let at = buffer.indexOf('\n')
      while (at !== -1) {
        const line = buffer.slice(0, at).trim()
        buffer = buffer.slice(at + 1)
        at = buffer.indexOf('\n')
        if (line === '') continue
        try {
          const message = JSON.parse(line)
          if (message.type === 'ready') {
            clearTimeout(timer)
            resolve(message)
          }
        } catch {
          // 非协议行忽略。
        }
      }
    })
  })

  const base = `http://127.0.0.1:${String(info.port)}`
  const headers = { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' }
  const post = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    return { status: response.status, text: await response.text() }
  }

  const configured = await post('/api/config/profiles', {
    profiles: [{
      id: 'fake/intake',
      label: '假供应商',
      baseUrl: `http://127.0.0.1:${String(upstreamPort)}/v1`,
      model: 'fake',
      apiKey: 'test',
    }],
  })
  if (configured.status !== 200) throw new Error(`配供应商失败：HTTP ${String(configured.status)}`)
  const selected = await post('/api/models/select', { id: 'fake/intake' })
  if (selected.status !== 200) throw new Error(`选供应商失败：HTTP ${String(selected.status)}`)

  const turn = await post('/api/inference', { input: '我跟你说件事，明天要把合同打印出来。' })
  if (turn.status !== 200) throw new Error(`对话失败：HTTP ${String(turn.status)}`)

  /* 收编是轮次结束后异步起的，3 秒足够它落盘（含一次提炼尝试）。 */
  await new Promise((resolve) => { setTimeout(resolve, 3500) })

  const dbPath = join(dataDir, 'user', 'ondra.db')
  let rawRows = -1
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath)
    try {
      rawRows = db.prepare('select count(*) as n from memory_raw').get().n
    } finally {
      db.close()
    }
  }

  const diagResponse = await fetch(`${base}/api/diagnostics/memory`, { headers })
  const diag = await diagResponse.json()

  return { rawRows, intake: diag.intake }
}

/* ---------------------------------------------------------------- *
 * A 段：默认开着，一轮必须落地
 * ---------------------------------------------------------------- */

console.log('=== A 段 · 默认（开关开着）一轮要落地 ===')
const a = await runTurn({})
check('memory_raw 至少一行', a.rawRows >= 1, `${String(a.rawRows)} 行`)
check('诊断里 intake 可用', a.intake?.available === true, String(a.intake?.reason ?? 'ok'))

/* ---------------------------------------------------------------- *
 * B 段：关掉开关，必须一行都不收
 * ---------------------------------------------------------------- */

console.log('')
console.log('=== B 段 · 关闭（enable=false）一行都不收 ===')
const b = await runTurn({ 'memory-intake': { enable: false } })

check('memory_raw 一行都没有', b.rawRows === 0, `${String(b.rawRows)} 行`)
check('诊断里 intake 报不可用', b.intake?.available === false, String(b.intake?.available))
check('诊断给出的理由是 disabled', b.intake?.reason === 'disabled', String(b.intake?.reason))

/* 受控 A/B：同一个脚本、同一句输入、只差这一个开关。 */
check('两段确实只差开关（A 收了、B 没收）', a.rawRows >= 1 && b.rawRows === 0,
  `${String(a.rawRows)} → ${String(b.rawRows)} 行`)

/* ---------------------------------------------------------------- *
 * 收尾
 * ---------------------------------------------------------------- */

for (const { child, dataDir } of hosts) {
  child.kill()
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 5000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
  try {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    // 临时目录删不掉不是被测能力的失败。
  }
}
upstream.close()

console.log('')
if (failures.length === 0) {
  console.log('全部通过。')
  process.exit(0)
}
console.log(`失败 ${String(failures.length)} 条：`)
for (const label of failures) console.log(`  ✗ ${label}`)
process.exit(1)
