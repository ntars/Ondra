/**
 * CORS 实测：起一个宿主，然后用真实浏览器语义的请求验证预检与主请求。
 *
 * 为什么不用 curl：curl 不执行 CORS，它只把响应头打印出来。
 * 真正要看的是「浏览器会不会放行」，这必须用 WebKit 内核去发请求。
 * 这里退一步用 Node 的 fetch + 手工按 CORS 规则判定响应头，
 * 能覆盖"预检是否通过、响应头是否齐全"这两个关键点。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const HOST_DIR = '/Users/ntars/Github/Ondra/cordis-host'

/**
 * 真实数据目录。**只读**，用来做「有没有被本次检查污染」的对照。
 *
 * 为什么必须对照：宿主起来会往数据目录写 `host.json`（调试握手），退出时删掉。
 * 如果检查脚本不隔离数据目录，它就会踩掉**正在运行的应用**的握手文件，
 * 导致 `node tools/ondra.mjs say/status` 全部报「应用大概没在运行」。
 * 这个坑真的踩过（2026-11-12 第 4 轮），下面那段断言就是防它复发。
 */
const REAL_DATA_DIR = process.platform === 'darwin'
  ? join(homedir(), 'Library', 'Application Support', 'com.ntars.ondra')
  : join(homedir(), '.local', 'share', 'com.ntars.ondra')
const REAL_HANDSHAKE = join(REAL_DATA_DIR, 'host.json')
const realHandshakeBefore = existsSync(REAL_HANDSHAKE)

/** 起宿主，等它打出 ready JSON。数据目录与端口一律隔离到临时目录。 */
function startHost(dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['lib/index.js'], {
      cwd: HOST_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      // ONDRA_PORT=0 让内核自己挑空口，避免和正在运行的应用抢 9060。
      env: { ...process.env, ONDRA_DATA_DIR: dataDir, ONDRA_PORT: '0' },
    })
    let buffer = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('宿主 20 秒内没有就绪'))
    }, 20_000)

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      for (const line of buffer.split('\n')) {
        if (line.trim() === '') continue
        try {
          const message = JSON.parse(line)
          if (message.type === 'ready') {
            clearTimeout(timer)
            resolve({ child, ready: message })
            return
          }
        } catch {
          // 非 JSON 行，继续等。
        }
      }
    })

    child.stderr.on('data', (chunk) => {
      process.stderr.write(`[host] ${chunk.toString('utf8')}`)
    })
  })
}

/** 发一个请求，返回状态与响应头。 */
async function probe(port, { method, path, headers }) {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, { method, headers })
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    text: await response.text(),
  }
}

const dataDir = await mkdtemp(join(tmpdir(), 'ondra-cors-'))
const { child, ready } = await startHost(dataDir)
console.log(`宿主就绪：${ready.url}`)

const ORIGIN = 'tauri://localhost'
let failures = 0

/** 检查一项，失败时计数。 */
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

try {
  // --- 1. 预检 ---
  console.log('\n[1] 预检 OPTIONS（浏览器发主请求前的第一步）')
  const preflight = await probe(ready.port, {
    method: 'OPTIONS',
    path: '/api/health',
    headers: {
      origin: ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  })
  check('状态码 204', preflight.status === 204, `实际 ${String(preflight.status)}`)
  check('放行来源', preflight.headers['access-control-allow-origin'] === ORIGIN,
    `实际 ${String(preflight.headers['access-control-allow-origin'])}`)
  check('放行 authorization 头',
    (preflight.headers['access-control-allow-headers'] ?? '').includes('authorization'),
    `实际 ${String(preflight.headers['access-control-allow-headers'])}`)
  check('声明 vary: origin', (preflight.headers.vary ?? '').toLowerCase().includes('origin'),
    `实际 ${String(preflight.headers.vary)}`)

  // --- 2. 带令牌的主请求 ---
  console.log('\n[2] 主请求（带令牌）')
  const authorized = await probe(ready.port, {
    method: 'GET',
    path: '/api/health',
    headers: { origin: ORIGIN, authorization: `Bearer ${ready.token}` },
  })
  check('状态码 200', authorized.status === 200, `实际 ${String(authorized.status)}`)
  check('响应带放行来源', authorized.headers['access-control-allow-origin'] === ORIGIN,
    `实际 ${String(authorized.headers['access-control-allow-origin'])}`)

  // --- 3. 无令牌必须被拒 ---
  console.log('\n[3] 无令牌的主请求（必须 401，证明放宽 CORS 没有放宽鉴权）')
  const denied = await probe(ready.port, {
    method: 'GET',
    path: '/api/health',
    headers: { origin: ORIGIN },
  })
  check('状态码 401', denied.status === 401, `实际 ${String(denied.status)}`)
  check('401 也带 CORS 头（否则前端连错误原因都读不到）',
    denied.headers['access-control-allow-origin'] === ORIGIN,
    `实际 ${String(denied.headers['access-control-allow-origin'])}`)

  // --- 4. 错误令牌必须被拒 ---
  console.log('\n[4] 错误令牌（必须 401）')
  const wrong = await probe(ready.port, {
    method: 'GET',
    path: '/api/health',
    headers: { origin: ORIGIN, authorization: 'Bearer not-a-real-token' },
  })
  check('状态码 401', wrong.status === 401, `实际 ${String(wrong.status)}`)

  // --- 5. 同源请求（无 Origin）不应被 CORS 逻辑干扰 ---
  console.log('\n[5] 同源请求（无 Origin 头）')
  const sameOrigin = await probe(ready.port, {
    method: 'GET',
    path: '/api/health',
    headers: { authorization: `Bearer ${ready.token}` },
  })
  check('状态码 200', sameOrigin.status === 200, `实际 ${String(sameOrigin.status)}`)
  check('不回 allow-origin', sameOrigin.headers['access-control-allow-origin'] === undefined,
    `实际 ${String(sameOrigin.headers['access-control-allow-origin'])}`)
} finally {
  // 等子进程真的退出再断言——握手文件是在退出钩子里删的，抢在退出前看会漏判。
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill()
  await exited

  console.log('\n[6] 没有污染真实数据目录（回归断言：曾经踩掉运行中应用的握手文件）')
  const realHandshakeAfter = existsSync(REAL_HANDSHAKE)
  check('真实数据目录的 host.json 与检查前状态一致',
    realHandshakeAfter === realHandshakeBefore,
    realHandshakeBefore ? '检查把运行中应用的握手文件删掉了' : '检查往真实数据目录写了握手文件')

  await rm(dataDir, { recursive: true, force: true })
}

console.log('')
if (failures === 0) {
  console.log('全部通过')
} else {
  console.log(`${String(failures)} 项失败`)
  process.exitCode = 1
}
