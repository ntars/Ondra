/**
 * 没有由头时不许编兜底句：正文留空，交给门控自己拒。
 *
 * ## 这个脚本要证明的一件事
 *
 * ```
 * 话由池空着 + 调用方没给正文
 *      → /api/proactive/check 不放行（allow:false）
 *      → 原因码是 content-empty（空正文），不是 ok
 *      → 门控台账里没有一条「已发」
 *      → 连问两次，第二次也不许变成 duplicate
 * ```
 *
 * ## 为什么需要它
 *
 * 宿主此前在「拿不到话由」时兜一句常量 `'想找你聊聊'`，然后再把这句话
 * 当正文交给门控。三个后果叠在一起：
 *
 * 1. 那句常量被塞进模型上下文（`nudgeFor()` 拼在「这次想提的事」后面），
 *    让她照着「想找你聊聊」这种空话组织语言；
 * 2. 它是个**常量**，去重闸（30 分钟窗口、最短 4 字）会把它认成同一句话，
 *    于是半小时内的第二次主动开口一律判重复；
 * 3. 症状与 `checkProactive()` 契约里警告的一模一样——「她只主动说过一次」。
 *
 * 而宿主自己那段注释写着「拿不到话由时不编兜底句」：**代码与它自己的
 * 约定相反**。本脚本把这条约定钉住。
 *
 * ## 为什么把 `proactive-reason` 关掉来制造「没有由头」
 *
 * 真实环境里池子是空的还是满的，取决于用户有没有待办、承诺、执念。
 * 靠「恰好没有」来复现，脚本会在别人机器上变绿或变红，属最难查的一类
 * 假失败。把话由服务关掉，`takeReason()` 必然返回 `undefined`——这是
 * 「拿不到由头」的**确定性**形态，而且正是用户能在设置页做出的动作。
 *
 * 用法：node tools/check-proactive-noreason.mjs
 * 退出码：全部通过为 0。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* ---------------------------------------------------------------- *
 * 前置闸门：产物必须新于源码
 * ---------------------------------------------------------------- */

const ROOT = join(import.meta.dirname, '..')

for (const [source, artifact] of [
  [join(ROOT, 'cordis-host', 'index.ts'), join(ROOT, 'cordis-host', 'lib', 'index.js')],
]) {
  if (!existsSync(artifact)) {
    console.log('=== 前置闸门 · 产物过期 ===')
    console.log(`  ✗ 产物不存在（${artifact}）`)
    console.log('  先执行：pnpm run build:host')
    process.exit(1)
  }
  const lag = statSync(source).mtimeMs - statSync(artifact).mtimeMs
  if (lag > 2000) {
    console.log('=== 前置闸门 · 产物过期 ===')
    console.log(`  ✗ ${source} 比产物新 ${String(Math.round(lag / 1000))} 秒`)
    console.log('  先执行：pnpm run build:host')
    process.exit(1)
  }
}

/* ---------------------------------------------------------------- *
 * 断言
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

/* ---------------------------------------------------------------- *
 * 起宿主
 * ---------------------------------------------------------------- */

/*
 * 静默窗钉成空窗：本脚本验的是「没有正文时门控怎么判」，与此刻几点无关。
 * 不钉的话它在夜里会因为更早的一道闸（静默时段）先拒，原因码就变了。
 * 取起止同一分钟即视为空窗，不改任何产品默认值。
 */
const dataDir = await mkdtemp(join(tmpdir(), 'ondra-no-reason-'))
await writeFile(
  join(dataDir, 'settings.json'),
  JSON.stringify({
    user: {
      'proactive-gate': {
        'quiet-start': '00:00',
        'quiet-end': '00:00',
        'anti-ban-quiet-start': '00:00',
        'anti-ban-quiet-end': '00:00',
      },
      // 制造「拿不到由头」的确定性形态。
      'proactive-reason': { enable: false },
    },
  }),
  'utf8',
)

const host = spawn(process.execPath, [join(ROOT, 'cordis-host', 'lib', 'index.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ONDRA_DATA_DIR: dataDir },
})

let stdoutBuffer = ''
let markReady
const readyPromise = new Promise((resolve) => { markReady = resolve })

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
      if (message.type === 'ready') markReady(message)
    } catch {
      // 非协议行忽略。
    }
  }
})

const stderrChunks = []
host.stderr.setEncoding('utf8')
host.stderr.on('data', (chunk) => { stderrChunks.push(String(chunk)) })

try {
  console.log('=== 主动开口 · 没有由头时不编兜底句 ===')

  const info = await Promise.race([
    readyPromise,
    new Promise((_, reject) => { setTimeout(() => { reject(new Error('宿主 30 秒内没有就绪')) }, 30000) }),
  ])
  const base = `http://127.0.0.1:${String(info.port)}`
  const headers = { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' }

  /** 带鉴权头的 POST，回原始文本与解析后的对象。 */
  async function post(path, body) {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    const text = await response.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
    return { status: response.status, text, parsed }
  }

  /* -------------------------------------------------------------- *
   * 1. 没有由头、也没有正文：不放行
   * -------------------------------------------------------------- */

  console.log('\n--- 1. 池子空着 ---')

  const first = await post('/api/proactive/check', { sessionId: 'no-reason-probe', idleMinutes: 40 })
  check('接口返回 200', first.status === 200, `HTTP ${String(first.status)}`)
  check('不放行', first.parsed?.allow === false, `allow=${String(first.parsed?.allow)}`)
  /*
   * 原因码必须是门控给的 `content-empty`。
   *
   * 这是本脚本的核心判据：它证明**空正文真的走到了门控**，而不是宿主
   * 在本地拍了一个 `allow:false`。旧实现这里是 `ok`——因为宿主自己
   * 拿常量填了正文，门控根本没机会说「没有正文」。
   */
  check('原因码是 content-empty', first.parsed?.code === 'content-empty', String(first.parsed?.code))
  /*
   * 兜底句的残留检查。装在响应体整串上而不是某个字段：只要它出现在
   * 任何位置（`text` / `reason` / 未来新增的字段），就说明有人又把它塞回去了。
   */
  check('响应里没有「想找你聊聊」', !first.text.includes('想找你聊聊'))

  /* -------------------------------------------------------------- *
   * 2. 连问第二次：不许变成 duplicate
   * -------------------------------------------------------------- */

  console.log('\n--- 2. 连问第二次 ---')

  const second = await post('/api/proactive/check', { sessionId: 'no-reason-probe', idleMinutes: 40 })
  /*
   * 旧实现第二次的码是 `duplicate`：第一次放行时把常量记进了台账，
   * 第二次去重闸认出「同一句话」。两个码都不该出现——唯一的正确答案
   * 是「还是没正文」。
   */
  check('原因码仍是 content-empty', second.parsed?.code === 'content-empty', String(second.parsed?.code))
  check('没有变成 duplicate', second.parsed?.code !== 'duplicate')

  /* -------------------------------------------------------------- *
   * 3. 台账里一条都没记
   * -------------------------------------------------------------- */

  console.log('\n--- 3. 门控台账 ---')

  let sent = []
  try {
    const state = JSON.parse(readFileSync(join(dataDir, 'user', 'proactive-state.json'), 'utf8'))
    sent = Array.isArray(state.sent) ? state.sent : []
  } catch {
    // 文件还没生成 = 一条都没发过，与空数组同义。
    sent = []
  }
  check('没有记下任何一条「已发」', sent.length === 0, `${String(sent.length)} 条`)
  check(
    '台账里没有常量兜底句',
    !JSON.stringify(sent).includes('想找你聊聊'),
  )

  /* -------------------------------------------------------------- *
   * 4. 反向验证：给了正文就必须照常放行
   * -------------------------------------------------------------- */

  console.log('\n--- 4. 反向：调用方给了正文 ---')

  /*
   * 这一段防的是「把整条路焊死」。
   *
   * 只验前三段的话，实现者只要让 `/api/proactive/check` 永远返回
   * `allow:false` 就能全绿——那等于把她彻底闭嘴，是比原来更坏的修法。
   * 给一句真由头，门控必须照旧放行，且原因码不再是 content-empty。
   */
  const withText = await post('/api/proactive/check', {
    sessionId: 'no-reason-probe',
    idleMinutes: 40,
    text: '你交代过的事：明天提醒我把合同打印出来。',
  })
  check('有正文时放行', withText.parsed?.allow === true, `code=${String(withText.parsed?.code)}`)
  check('原因码不再是 content-empty', withText.parsed?.code !== 'content-empty', String(withText.parsed?.code))

  /* -------------------------------------------------------------- *
   * 5. 宿主没有把异常吞成静默
   * -------------------------------------------------------------- */

  const noise = stderrChunks.join('')
  check(
    'stderr 无未捕获异常',
    !/Uncaught|UnhandledPromiseRejection|Cannot read propert/i.test(noise),
    noise === '' ? '（空）' : noise.slice(0, 120),
  )
} catch (error) {
  check('脚本自身跑完', false, error instanceof Error ? error.message : String(error))
} finally {
  host.kill()
  await rm(dataDir, { recursive: true, force: true })
}

console.log('')
if (failures.length === 0) {
  console.log('全部通过。')
  process.exit(0)
} else {
  console.log(`共 ${String(failures.length)} 条未通过：`)
  for (const label of failures) console.log(`  - ${label}`)
  process.exit(1)
}
