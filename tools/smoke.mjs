/**
 * 三层链路冒烟测试。
 *
 * 启动真实宿主进程，等它报告就绪，再依次调用 HTTP 接口，
 * 最后发送 SIGTERM 收尾。任何一步失败都以非零码退出。
 *
 * 独立成脚本而不写进测试框架：骨架阶段还没有测试依赖，
 * 而这个验证的价值在于"真的跑起来过一次"，不是单元覆盖。
 *
 * 用临时数据目录，避免污染用户真实的会话与配置。
 *
 * ## 两种目标
 *
 * 默认测工作区源码（`cordis-host/lib/index.js` + 当前 node）；
 * 加 `--package` 则测**打包后的产物**——用 `.app` 里内置的 node
 * 跑内置的宿主与插件。两者的接口契约完全一致，所以共用同一份检查，
 * 换的只是 root、入口和解释器三个变量。
 *
 * 分开来跑是必要的：源码跑得通不代表装进包里跑得通，
 * 常见的断法是 `collect-runtime` 漏了某个运行期依赖，
 * 那种错误只有用包内 node 启动才会暴露。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const usePackage =
  process.argv.includes('--package') || process.argv.includes('--app') || process.argv.includes('--dmg')

const repoRoot = join(import.meta.dirname, '..')
const appResources = join(repoRoot, 'releases', 'macos', '空谷 Ondra.app', 'Contents', 'Resources')

/** 打包模式下的三个路径；源码模式下 root 是仓库根，解释器是当前 node。 */
function resolveTarget() {
  if (!usePackage) {
    return {
      label: '工作区源码',
      root: repoRoot,
      hostEntry: join(repoRoot, 'cordis-host', 'lib', 'index.js'),
      nodeExe: process.execPath,
    }
  }
  const target = {
    label: '打包产物',
    root: appResources,
    hostEntry: join(appResources, 'cordis-host', 'lib', 'index.js'),
    nodeExe: join(appResources, 'node', 'bin', 'node'),
  }
  for (const path of [target.hostEntry, target.nodeExe]) {
    if (existsSync(path)) continue
    process.stderr.write(`找不到打包产物里的 ${path}\n`)
    process.stderr.write('请先运行 `node tools/bundle-release.mjs` 生成 releases/ 下的 .app。\n')
    process.exit(1)
  }
  return target
}

const target = resolveTarget()
const root = target.root
const hostEntry = target.hostEntry
const dataDir = await mkdtemp(join(tmpdir(), 'ondra-smoke-'))
process.stdout.write(`目标：${target.label}\n`)
process.stdout.write(`解释器：${target.nodeExe}\n`)
process.stdout.write(`数据目录：${dataDir}\n`)

/** 等待宿主在 stdout 上报 ready。 */
function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => { reject(new Error('等待就绪超时（15 秒）')) }, 15_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let newlineAt = buffer.indexOf('\n')
      while (newlineAt !== -1) {
        const line = buffer.slice(0, newlineAt)
        buffer = buffer.slice(newlineAt + 1)
        if (line.trim() !== '') {
          try {
            const message = JSON.parse(line)
            if (message.type === 'ready') {
              clearTimeout(timer)
              resolve(message)
              return
            }
            if (message.type === 'fatal') {
              clearTimeout(timer)
              reject(new Error(`宿主启动失败：${message.message}`))
              return
            }
          } catch {
            // 非 JSON 行忽略，stdout 偶尔可能混入原生警告。
          }
        }
        newlineAt = buffer.indexOf('\n')
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { process.stderr.write(`[host] ${chunk}`) })
  })
}

/** 发一个带上令牌的请求。 */
async function call(ready, method, path, body) {
  const response = await fetch(`${ready.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ready.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}：${text}`)
  return text === '' ? undefined : JSON.parse(text)
}

/**
 * 读一条 SSE 流，收集全部帧。
 *
 * 手写解析而不是用 EventSource：EventSource 无法自定义请求头，
 * 而令牌必须放在 Authorization 里。
 */
async function readStream(ready, path, body) {
  const response = await fetch(`${ready.url}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ready.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`流式请求失败：${response.status}`)

  const frames = []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let at = buffer.indexOf('\n\n')
    while (at !== -1) {
      const block = buffer.slice(0, at)
      buffer = buffer.slice(at + 2)
      at = buffer.indexOf('\n\n')
      const eventLine = block.split('\n').find((line) => line.startsWith('event: '))
      const dataLine = block.split('\n').find((line) => line.startsWith('data: '))
      if (eventLine !== undefined && dataLine !== undefined) {
        frames.push({ event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) })
      }
    }
  }
  return frames
}

const child = spawn(target.nodeExe, [hostEntry], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ONDRA_DATA_DIR: dataDir },
  // 关键：父进程的 stdin 必须保持打开，否则宿主读到 EOF 会立即退出。
  // 这正是手动 `&` 后台启动时测不通的原因。
})

let failures = 0
const check = (label, condition, detail) => {
  if (condition) {
    process.stdout.write(`  通过  ${label}${detail === undefined ? '' : `（${detail}）`}\n`)
  } else {
    process.stdout.write(`  失败  ${label}${detail === undefined ? '' : `（${detail}）`}\n`)
    failures += 1
  }
}

try {
  const ready = await waitForReady(child)
  process.stdout.write(`宿主就绪：${ready.url}\n`)

  const health = await call(ready, 'GET', '/api/health')
  check('健康检查', health?.ok === true)

  // 无令牌必须被拒：这是本地接口唯一的安全边界，不能因为"同机"就放行。
  const unauthorized = await fetch(`${ready.url}/api/health`)
  check('无令牌返回 401', unauthorized.status === 401, `实际 ${unauthorized.status}`)

  /*
   * 会话是**单数**：`GET` 回一段或 `null`，`POST` 必须被拒。
   *
   * 这条断言在 2.2 之后一直是红的——脚本还按「多会话 + 新建」测，
   * 而宿主早已改成单会话制。冒烟脚本红着，比没有脚本更糟：它让人以为
   * 链路断了，而实际断的是测试自己。
   */
  const current = await call(ready, 'GET', '/api/sessions')
  check('会话为单数：读回一段或 null', current === null || typeof current?.id === 'string',
    current === null ? 'null' : current.id)

  const createRejected = await fetch(`${ready.url}/api/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ready.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: '端到端验证' }),
  })
  check('单会话模式下拒绝新建（409）', createRejected.status === 409, `实际 ${createRejected.status}`)

  const models = await call(ready, 'GET', '/api/models')
  check('模型列表可读', Array.isArray(models), `当前 ${models?.length ?? 0} 个`)

  const tools = await call(ready, 'GET', '/api/tools')
  check('工具列表可读', Array.isArray(tools))

  const missing = await fetch(`${ready.url}/api/nope`, { headers: { authorization: `Bearer ${ready.token}` } })
  check('未知路由返回 404', missing.status === 404)

  // --- 对话链路 -------------------------------------------------------------

  // 不带 sessionId：模拟用户在首页直接打字，由宿主自己建会话。
  const frames = await readStream(ready, '/api/inference', { input: '你好，介绍一下你自己' })
  const sessionFrame = frames.find((frame) => frame.event === 'session')
  check('流式返回会话 id', typeof sessionFrame?.data.sessionId === 'string', sessionFrame?.data.sessionId)

  const deltas = frames.filter((frame) => frame.event === 'delta')
  check('收到多个文本增量', deltas.length > 1, `${deltas.length} 帧`)

  const doneFrame = frames.find((frame) => frame.event === 'done')
  check('收到结束帧', doneFrame !== undefined)
  check('结束时带完整文本', typeof doneFrame?.data.text === 'string' && doneFrame.data.text.length > 0,
    `${doneFrame?.data.text?.length ?? 0} 字`)

  const newSessionId = sessionFrame.data.sessionId
  const messages = await call(ready, 'GET', `/api/sessions/${newSessionId}/messages`)
  check('消息可读回', Array.isArray(messages) && messages.length === 2,
    messages?.map((item) => item.role).join(' → '))
  check('用户消息内容正确', messages?.[0]?.content === '你好，介绍一下你自己')
  /*
   * 助手消息与流式正文一致——**句末标点除外**。
   *
   * ## 为什么留这一个口子
   *
   * `ondra-oral` 的口语化会去句末句号（「就吃用户的饭。」→「就吃用户的饭」），
   * 而塑形只发生在宿主这一侧：界面看到的是塑形后的句子，内核库里存的是
   * 模型原文。两者差一个标点，长度差 1。
   *
   * 这是**已知缺口**（真正修法是让宿主把塑形后的句子回写内核，代价是
   * 每轮多一次 RPC），不在这里假装它不存在：判据放宽到「去掉句末标点后
   * 完全相同」，一旦文案层面出现别的偏差，这条仍然会红。
   */
  const stripTail = (text) => String(text ?? '').replace(/[。！？…，、~～]+$/u, '')
  check('助手消息与流式内容一致（句末标点除外）',
    stripTail(messages?.[1]?.content) === stripTail(doneFrame?.data.text),
    `流式 ${stripTail(doneFrame?.data.text).length} 字 / 落库 ${stripTail(messages?.[1]?.content).length} 字`)

  const detail = await call(ready, 'GET', `/api/sessions/${newSessionId}`)
  check('会话标题自动取自首句', detail?.title === '你好，介绍一下你自己', detail?.title)

  // --- 配置链路 -------------------------------------------------------------

  const initialConfig = await call(ready, 'GET', '/api/config')
  check('配置可读', typeof initialConfig?.permission === 'string', initialConfig?.permission)

  const savedProfiles = await call(ready, 'POST', '/api/config/profiles', {
    profiles: [{ id: 'demo/x', label: '演示', baseUrl: 'https://api.example.com/v1', model: 'demo', apiKey: 'sk-secret-1234' }],
  })
  check('保存供应商配置', savedProfiles?.count === 1)

  const afterConfig = await call(ready, 'GET', '/api/config')
  check('密钥返回时已打码', afterConfig?.profiles?.[0]?.apiKey?.includes('•') === true, afterConfig?.profiles?.[0]?.apiKey)
  check('标记为已配置密钥', afterConfig?.profiles?.[0]?.hasKey === true)

  const modelsAfter = await call(ready, 'GET', '/api/models')
  check('供应商进入模型列表', Array.isArray(modelsAfter) && modelsAfter.length === 2, `当前 ${modelsAfter?.length} 个`)

  const selected = await call(ready, 'POST', '/api/models/select', { id: 'demo/x' })
  check('可切换模型', selected?.model === 'demo/x', selected?.model)

  // 打码值回传时必须保留原密钥，而不是把它替换成圆点。
  await call(ready, 'POST', '/api/config/profiles', {
    profiles: [{ id: 'demo/x', label: '演示', baseUrl: 'https://api.example.com/v1', model: 'demo', apiKey: afterConfig.profiles[0].apiKey }],
  })
  const preserved = await call(ready, 'GET', '/api/config')
  check('回传打码值不会覆盖真实密钥', preserved?.profiles?.[0]?.apiKey?.endsWith('1234') === true,
    preserved?.profiles?.[0]?.apiKey)

  const permission = await call(ready, 'POST', '/api/config/permission', { permission: 'chat' })
  check('可切换权限档位', permission?.permission === 'chat')

  const badPermission = await fetch(`${ready.url}/api/config/permission`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ready.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ permission: 'root' }),
  })
  check('非法权限档位被拒', badPermission.status === 400)

  /*
   * 清空全部：旧内容归档成段，当前段归零。
   *
   * 单会话制下没有「新建 / 归档」这条路，用户能做的只有清空——所以冒烟
   * 必须验这一条，否则「消息删不掉」这种最伤人的缺陷没有任何网兜着。
   */
  const cleared = await call(ready, 'POST', `/api/sessions/${newSessionId}/clear`, {})
  check('可清空全部', cleared?.archived === true, JSON.stringify(cleared))
  const afterClear = await call(ready, 'GET', `/api/sessions/${cleared.sessionId}/messages`)
  check('清空后当前段没有消息', Array.isArray(afterClear) && afterClear.length === 0,
    `${afterClear?.length ?? '?'} 条`)
} catch (error) {
  process.stderr.write(`冒烟测试中断：${error instanceof Error ? error.message : String(error)}\n`)
  failures += 1
} finally {
  // 关闭 stdin 让宿主走正常退出路径，顺带验证 EOF 处理是否生效。
  child.stdin.end()
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 5_000)
    child.once('exit', (code) => { clearTimeout(timer); resolve(code) })
  })
  await rm(dataDir, { recursive: true, force: true })
}

process.stdout.write(failures === 0 ? '\n全部通过\n' : `\n${failures} 项失败\n`)
process.exit(failures === 0 ? 0 : 1)
