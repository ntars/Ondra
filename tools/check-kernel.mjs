/**
 * 内核直连验证。
 *
 * 绕过宿主与壳，直接用管道驱动内核，逐个验证协议方法。
 * 存在的理由：三层链路出问题时，需要能一步定位是内核本身的问题还是转发的问题。
 * 这个脚本就是那个"只看内核"的入口。
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const entry = join(import.meta.dirname, '..', 'dsh-sidecar', 'lib', 'index.js')
const dataDir = await mkdtemp(join(tmpdir(), 'ondra-kernel-'))
process.stdout.write(`数据目录：${dataDir}\n`)

const child = spawn(process.execPath, [entry], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ONDRA_DATA_DIR: dataDir },
})

/** 已收到的消息，按 id 或事件名索引。 */
const responses = new Map()
const events = []
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
    } else if (typeof message.method === 'string') {
      events.push(message)
    }
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => { process.stderr.write(`[dsh] ${chunk}`) })

let nextId = 1
/** 发一个请求并等响应。 */
function call(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`${method} 超时`)) }, 15_000)
    waiters.set(id, (message) => {
      clearTimeout(timer)
      if (message.error !== undefined) reject(new Error(`${method} 失败：${message.error.message}（码 ${message.error.code}）`))
      else resolve(message.result)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

let failures = 0
const check = (label, ok, detail) => {
  process.stdout.write(`  ${ok ? '通过' : '失败'}  ${label}${detail === undefined ? '' : `（${detail}）`}\n`)
  if (!ok) failures += 1
}

try {
  const handshake = await call('kernel.handshake', { protocolVersion: '1.0', client: 'host', clientVersion: 'check' })
  check('握手', handshake.kernel === 'dsh', `内核 ${handshake.version}`)
  check('方法清单含 session.messages', handshake.methods.includes('session.messages'))
  check('方法清单含 model.configure', handshake.methods.includes('model.configure'))

  const models = await call('model.list', {})
  check('默认有一个可用的演示模型', models.length === 1 && models[0].id === 'local/echo', models[0]?.label)

  const session = await call('session.create', { title: '' })
  check('创建会话', typeof session.id === 'string', session.title)

  // 走一轮真实推理：本地演示模型会逐块回声。
  const before = events.length
  const result = await call('inference.run', { sessionId: session.id, input: '你好，空谷' })
  check('推理返回文本', typeof result.text === 'string' && result.text.length > 0, `${result.text.length} 字`)
  const deltas = events.slice(before).filter((event) => event.method === 'event.inference.delta')
  check('产生流式增量', deltas.length > 1, `${deltas.length} 帧`)
  const done = events.slice(before).filter((event) => event.method === 'event.inference.done')
  check('推送推理结束事件', done.length === 1)

  const messages = await call('session.messages', { sessionId: session.id })
  check('消息已落库为两条', messages.length === 2, `${messages.map((m) => m.role).join(' → ')}`)
  check('用户消息内容正确', messages[0]?.content === '你好，空谷')
  check('会话标题自动取自首句', (await call('session.get', { id: session.id })).title === '你好，空谷')

  // 配置一个不存在的模型，选中它必须立刻失败，而不是等到推理时。
  let selectFailed = false
  try {
    await call('model.select', { id: 'nope/not-exist' })
  } catch {
    selectFailed = true
  }
  check('选择不存在的模型时立即报错', selectFailed)

  // 配置一条指向本地无效端口的供应商，验证错误信息可读。
  const configured = await call('model.configure', {
    profiles: [{ id: 'test/bad', label: '错误端点', baseUrl: 'http://127.0.0.1:1/v1', model: 'x' }],
  })
  check('配置供应商后模型列表增加', configured.models.length === 2, configured.models.map((m) => m.id).join(', '))
  await call('model.select', { id: 'test/bad' })
  let networkError = ''
  try {
    await call('inference.run', { sessionId: session.id, input: '测试网络错误' })
  } catch (error) {
    networkError = error.message
  }
  check('连接失败时给出可读原因', networkError.includes('无法连接供应商'), networkError.slice(0, 60))

  // 删掉配置后，选中的模型必须自动回落到可用模型。
  const cleared = await call('model.configure', { profiles: [] })
  check('删除供应商后回落到演示模型', cleared.current === 'local/echo', cleared.current)

  // 落盘检查：关掉内核后重新打开，历史必须还在。
  const files = (await readdir(dataDir)).filter((name) => name.endsWith('.json'))
  check('会话已写入磁盘', files.length === 1, files[0])
  const raw = JSON.parse(await readFile(join(dataDir, files[0]), 'utf8'))
  check('磁盘文件含完整消息', raw.messages.length >= 2, `${raw.messages.length} 条`)
} catch (error) {
  process.stderr.write(`验证中断：${error.message}\n`)
  failures += 1
} finally {
  child.stdin.end()
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
  await rm(dataDir, { recursive: true, force: true })
}

process.stdout.write(failures === 0 ? '\n内核全部通过\n' : `\n${failures} 项失败\n`)
process.exit(failures === 0 ? 0 : 1)
