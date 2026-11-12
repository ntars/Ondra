/**
 * 宿主级端到端：一句真实回复，到她真的出声；外加「用户层配置真生效」。
 *
 * ## 这个脚本要证明的两件事
 *
 * ```
 * A. 模型回了一段 60 字的话
 *      → 闸门对「整段」判 too-long
 *      → 宿主挑出其中一句能念的
 *      → 只 admit() 一次
 *      → 合成真的跑了一次
 * B. settings.json 里写的用户值
 *      → 真的进了插件的 Config（不是被打回默认值）
 * ```
 *
 * ## 为什么非要 A 这条检查
 *
 * 第 2 轮抓到的缺陷形态是：`ondra-tts` 与 `ondra-tts-gate` 两个包各自完整、
 * 服务键都注册、探针全绿，而产品里**一次都没出过声**。原因是闸门句长口径
 * 是「单句 6–30 字」，宿主却把整段回复一次交给它 —— 回复超过 30 字就必然
 * `too-long`。它不报错、不影响文字、探针上只看到 `too-long` 一直涨。
 *
 * 当时 23 条自检没有一条抓得到。它们验的都是「服务能工作」（直接调
 * `admit()` / `speak()`），没有一条验「应用会不会用它」。本仓反复踩的
 * 就是这个形态：**A 写、B 读、中间少根线，日志完全干净。**
 *
 * ## 为什么非要 B 这条检查
 *
 * 第 1 轮的缺陷形态更隐蔽：`settings.json` 存 kebab 键（`min-chars`），
 * 插件的 `Config.validate` 走 `completeConfig` 只认 camel（`minChars`），
 * 于是**全部插件的用户配置在进 `apply` 之前被打回默认值**。存储能写能读、
 * 界面显示改过了、插件日志一行不报——只有行为是默认的。
 *
 * 判据必须落在**带连字符的键**上。`enable` 这种单词键在两种命名里长得
 * 一模一样，用它做判据，`camelizeKeys()` 整个删掉也照样绿。
 *
 * ## 判据为什么必须是派生量
 *
 * 不能用 `ttsLoaded === true`、`available === true`、`engine !== 'none'`。
 * 这三个在 A 那个缺陷下**全都是绿的**——插件确实装着、确实可用。
 * 唯一能证明「她真的念了」的是两个账本：
 *
 * - `gateStats.spoken > 0` —— 闸门真的放行过一句；
 * - `ttsStats.ok > 0` —— 合成真的成了一次。
 *
 * 两者都涨才叫「链子通了」。只看一个会把「放行了但合成失败」和
 * 「合成正常但从没被调用」说成同一件事。
 *
 * ## 为什么不断言 `played`
 *
 * `played` 要过 `afplay`，依赖系统输出设备。无人值守的机器（CI、静音、
 * 没有音频会话）上它必然为 0，而那不是被测能力坏了。本仓自己
 * `service.ts` 的注释也写明「播不出来不是合成失败」。所以本脚本
 * 主动把 `tts.playback` 设成 `off`：**既不等播放、也不制造噪音**，
 * 测的仍然是「判定 → 合成」这条真正的链。
 *
 * ## 为什么回复要长得超过 30 字
 *
 * 这是 A 的核心。若回一句 10 字的话，`admit(整段)` 直接放行，
 * 那条「整段 too-long 就静默」的死规则照样存在而检查恒绿。
 * 只有让整段超过 `max-chars`，`spoken > 0` 才等价于「挑句那一步真的跑了」：
 * 不挑就必然 `too-long` 拦下，`spoken` 不会涨。
 *
 * 用法：node tools/check-voice.mjs
 * 退出码：全部通过为 0。
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* ---------------------------------------------------------------- *
 * 前置闸门：产物必须新于源码
 * ---------------------------------------------------------------- *
 *
 * 本脚本跑的是 `lib/` 产物（与宿主实际加载的同一份），不是 `src/`。
 * 于是有一个第 4 轮真踩过的陷阱：
 *
 * ```
 * 改 src/voice.ts  →  忘了 build  →  跑 check:voice  →  全绿
 *                                     ↑ 绿的是**改动之前**的行为
 * ```
 *
 * 那一轮就是这么让一条断言假绿了整整一轮，直到实机复现才发现。
 * 光在注释里写「记得先 build」不管用——注释不会红。
 *
 * 所以把它做成硬闸门：任何一个被本脚本依赖的 `.ts` 比它的产物新，
 * 立刻失败并指名道姓。**这是本脚本的第一个断言，也是唯一一个
 * 不测产品、只测「你正在测的东西是不是你以为的那个东西」的断言。**
 *
 * 容差 2 秒：`tsc` 写产物的 mtime 可能略早于源文件的最终落盘时间
 * （同一次 build 内的先后顺序），留窄窗避免误报。
 */

/** 项目根（tools/ 的上一级）。 */
const ROOT = join(import.meta.dirname, '..')

/** 递归列出目录下的 `.ts` 源码，跳过声明文件。 */
function tsFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) tsFiles(full, out)
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

/**
 * 本脚本会 import 的全部产物，逐对给出「源码 → 产物」。
 *
 * 只列真正被 import 的四个入口所在的包（`ondra-tts-gate` / `ondra-tts`）
 * 加宿主自身，不列那 78 个包里用不到的部分——闸门要挡的是「我改的东西
 * 没生效」，不是「整个仓库都没 build」。
 */
function buildPairs() {
  const pairs = [[join(ROOT, 'cordis-host', 'index.ts'), join(ROOT, 'cordis-host', 'lib', 'index.js')]]
  const add = (srcDir, outDir) => {
    for (const src of tsFiles(srcDir)) {
      const rel = src.slice(srcDir.length + 1).replace(/\.ts$/, '.js')
      pairs.push([src, join(outDir, rel)])
    }
  }
  for (const name of ['ondra-tts-gate', 'ondra-tts']) {
    const base = join(ROOT, 'cordis-host', 'plugins', name)
    add(join(base, 'src'), join(base, 'lib'))
  }
  add(join(ROOT, 'cordis-host', 'src'), join(ROOT, 'cordis-host', 'lib', 'src'))
  return pairs
}

/** 产物与源码的 mtime 容差（毫秒）。 */
const STALE_TOLERANCE_MS = 2000

const staleArtifacts = []
const artifactPairs = buildPairs()
for (const [source, artifact] of artifactPairs) {
  if (!existsSync(artifact)) {
    staleArtifacts.push(`${source} 的产物不存在（${artifact}）`)
    continue
  }
  const behind = statSync(source).mtimeMs - statSync(artifact).mtimeMs
  if (behind > STALE_TOLERANCE_MS) {
    staleArtifacts.push(`${source} 比产物新 ${Math.round(behind / 1000)} 秒`)
  }
}

if (staleArtifacts.length > 0) {
  console.log('=== 前置闸门 · 产物过期 ===')
  for (const line of staleArtifacts) console.log(`  ✗ ${line}`)
  console.log('')
  console.log('  改完 src 不重新构建就跑，测到的是改动之前的代码——全绿也不算数。')
  console.log('  先执行：pnpm run build:plugins && pnpm run build:host')
  console.log('  （tsc -b 增量若判定无变化会跳过，必要时加 --force）')
  process.exit(1)
}

console.log('=== 前置闸门 · 产物新鲜 ===')
console.log(`  ✓ ${artifactPairs.length} 个产物都不旧于源码`)

/*
 * C 段要**直接**调宿主的 `speakReply()`，绕开 HTTP 与情绪服务的时序。
 *
 * 用动态 import 而非静态，是为了让上面的新鲜度闸门**先于模块求值**跑完：
 * 静态 import 会在任何顶层语句之前求值，那样闸门就退化成「加载完旧代码
 * 再告诉你它旧」，遇到产物缺导出时还要先吃一个看不懂的绑定错误。
 */
const { speakReply } = await import('../cordis-host/lib/src/voice.js')
const { Gate } = await import('../cordis-host/plugins/ondra-tts-gate/lib/service.js')
const { DEFAULT_CONFIG } = await import('../cordis-host/plugins/ondra-tts-gate/lib/settings.js')
const { speakable } = await import('../cordis-host/plugins/ondra-tts/lib/speakable.js')

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

/** 长回复：**整段 60 字以上**，且第一分句带情绪词。 */
const LONG_REPLY = '今天见到你我挺开心的。对了，你刚才问的那台机器我看过了，硬盘还剩一百二十个 G，跑起来一点都不卡，风扇也很安静，你放心用。'

/**
 * 短回复：3 字（净化后仍是 3 字，标点不会被剥）。
 *
 * 它同时是 A 段的反证与 B 段的探针，选它是因为**同一个字符串在两段里
 * 得到相反结论**，而唯一的差别就是 `min-chars`：
 *
 * | 段 | `min-chars` | 期望 |
 * | --- | --- | --- |
 * | A | 6（默认） | `too-short` 拦下 |
 * | B | 2（用户层写入） | 长度闸不再拦 |
 *
 * 这就是一个受控 A/B：两段之间只动一个变量。
 */
const SHORT_REPLY = '嗯好。'

/** 下一次请求要回什么。按段切换，避免用「第几次请求」猜。 */
let replyFor = LONG_REPLY

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
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: replyFor } }] })}\n\n`)
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

/** 所有起过的宿主，收尾时统一杀。 */
const hosts = []

/**
 * 起一个宿主，返回可直接用的 HTTP 助手。
 *
 * `playback: 'off'` 是**用户层配置**，不是改产品默认值。它的语义是
 * 「合成但别放出来」——正是自动化检查要的姿态：不依赖输出设备、
 * 不制造噪音、也不等 `afplay` 那三五秒。`enable` 保持默认的 true，
 * 否则 `speakReply()` 会在第一行就因 `reason === 'disabled'` 返回，
 * 那样测到的是「用户关了朗读」，不是「链子通不通」。
 * @param userSettings 写进 `settings.json` 的用户层。
 */
async function bootHost(userSettings) {
  const dataDir = await mkdtemp(join(tmpdir(), 'ondra-e2e-voice-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ user: userSettings }), 'utf8')

  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'cordis-host', 'lib', 'index.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ONDRA_DATA_DIR: dataDir },
  })
  hosts.push({ child, dataDir })

  let buffer = ''
  const stderrChunks = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderrChunks.push(String(chunk)) })

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

  return {
    base,
    headers,
    stderrText: () => stderrChunks.join(''),
    /** 带鉴权头的 POST。 */
    async post(path, body) {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
      return { status: response.status, text: await response.text() }
    },
    /** 读声音链探针。 */
    async voice() {
      const response = await fetch(`${base}/api/diagnostics/voice`, { headers })
      return await response.json()
    },
    /**
     * 等一个条件成立。
     *
     * `speakReply()` 在宿主里是 `void` 起的独立异步支路（不能 await，
     * 否则整轮对话要等播放结束）。所以朗读结果**一定晚于** `done` 帧。
     * 固定 `setTimeout` 要么太短（时红时绿）要么太长（白等）。
     * 轮询到条件成立即走，最长等 `timeoutMs`。
     * @param predicate 条件。
     * @param timeoutMs 最长等待毫秒。
     */
    async waitFor(predicate, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      let last
      while (Date.now() < deadline) {
        last = await this.voice()
        if (predicate(last)) return last
        await new Promise((resolve) => { setTimeout(resolve, 250) })
      }
      return last
    },
    /** 配好假供应商并选中。 */
    async useFakeProvider() {
      const configured = await this.post('/api/config/profiles', {
        profiles: [{
          id: 'fake/voice',
          label: '假供应商',
          baseUrl: `http://127.0.0.1:${String(upstreamPort)}/v1`,
          model: 'fake',
          apiKey: 'test',
        }],
      })
      const selected = await this.post('/api/models/select', { id: 'fake/voice' })
      return { configured, selected }
    },
  }
}

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
  /* ================================================================ *
   * A 段：从一句长回复到真的念出来
   * ================================================================ */

  console.log('=== A 段 · 从一句长回复到真的念出来 ===')

  const hostA = await bootHost({ tts: { playback: 'off' } })
  console.log(`宿主就绪：${hostA.base}`)

  console.log('\n--- 1. 两个插件都在，且通道可用 ---')

  const initial = await hostA.waitFor((state) => state.ttsAvailable === true, 10000)
  check('语音合成插件已装载', initial.ttsLoaded === true, String(initial.ttsLoaded))
  check('语音闸门已装载', initial.gateLoaded === true, String(initial.gateLoaded))
  /*
   * `ttsAvailable` 要轮询：通道探测（`say -v`、`edge-tts --version`）是
   * 起宿主之后才做的，`ready` 帧早于它。直接读会偶发拿到 false。
   */
  check('合成通道可用', initial.ttsAvailable === true, `engine=${String(initial.engine)}`)
  check('朗读没有被用户关掉', initial.enabled === true, `enabled=${String(initial.enabled)}`)
  check('探针没有报出阻塞原因', initial.note === '', initial.note || '（空）')

  console.log('\n--- 2. 用户说一句话，她回一段 60 字以上 ---')

  const wired = await hostA.useFakeProvider()
  check('配置供应商成功', wired.configured.status === 200, `HTTP ${String(wired.configured.status)}`)
  check('选中供应商成功', wired.selected.status === 200, `HTTP ${String(wired.selected.status)}`)

  replyFor = LONG_REPLY
  const turn = await hostA.post('/api/inference', { input: '今天怎么样？' })
  check('对话接口返回 200', turn.status === 200, `HTTP ${String(turn.status)}`)
  check('拿到会话 id', sessionIdOf(turn.text) !== '', sessionIdOf(turn.text))

  console.log('\n--- 3. 闸门放行过一句，合成真的成了一次 ---')

  /*
   * 等的是「判定**与**合成都有结论」，不是「判定有结论」。
   *
   * `speakReply()` 的顺序是 `admit()` → `await tts.speak()`：`spoken` 在
   * 合成**开始之前**就 +1 了。所以只等 `spoken >= 1` 会读到一个完全合法的
   * 中间态（`spoken=1 / ok=0 / calls=1`），把它当成「合成没成」就是一条
   * 时红时绿的假失败——本脚本第一版正是这么红的，记在这里当路标。
   *
   * 因此等到 `ok` 或 `failures` 任一有数（即合成这条路已经有了结论）为止；
   * 合成若失败，`failures` 会涨，下面的断言能直接指出是哪一种失败。
   */
  const spoken = await hostA.waitFor(
    (state) => (state.gateStats?.spoken ?? 0) >= 1
      && ((state.ttsStats?.ok ?? 0) >= 1 || (state.ttsStats?.failures ?? 0) >= 1),
    25000,
  )
  const gate = spoken.gateStats ?? {}
  const tts = spoken.ttsStats ?? {}

  /*
   * 这两条是本脚本存在的理由。
   *
   * 整段 60 字 > `max-chars` 30。若宿主退回「整段一次 admit」，这里必然
   * `too-long` 拦下、`spoken` 恒 0。所以 `spoken >= 1` 等价于
   * 「挑句那一步真的跑了」——判据是派生量，不是「插件在不在」。
   */
  check('闸门真的放行过（spoken ≥ 1）', (gate.spoken ?? 0) >= 1, `spoken=${String(gate.spoken ?? 0)}`)
  check('合成真的成了一次（ok ≥ 1）', (tts.ok ?? 0) >= 1, `ok=${String(tts.ok ?? 0)} / calls=${String(tts.calls ?? 0)}`)
  /*
   * 只合成一次，不 N 次。
   *
   * 挑句用的是 `decide()`（纯，不记账、不合成），选中之后才 `admit()` 一次。
   * 若哪天有人把试探改成 `admit()` 或直接 `speak()`，`calls` 会跟着候选数涨，
   * 频控与连读计数被一轮里的试探撑爆，症状是「她连着几轮不出声、过一会儿
   * 又突然出声」。这条断言就是钉这个的。
   */
  check('一轮只合成了一次', (tts.calls ?? 0) === 1, `calls=${String(tts.calls ?? 0)}`)
  check('没有合成失败', (tts.failures ?? 0) === 0, `failures=${String(tts.failures ?? 0)}${tts.lastError === undefined ? '' : ` / ${tts.lastError}`}`)

  console.log('\n--- 4. 反证：短句该被拦下，闸门不是摆设 ---')

  const decisionsBefore = gate.decisions ?? 0
  const spokenBefore = gate.spoken ?? 0

  replyFor = SHORT_REPLY
  const turn2 = await hostA.post('/api/inference', { input: '嗯，知道了。' })
  check('第二轮对话返回 200', turn2.status === 200, `HTTP ${String(turn2.status)}`)

  /*
   * 第二轮回复是 `嗯好。`——3 字，低于默认 `min-chars` 6。
   *
   * 用「句长」而不是「情绪」做反证：句长是确定性事实，不依赖情绪服务此刻
   * 的 mood/energy。用情绪做反证的话，它会在「刚好弥散到 0.15 以上」时
   * 时红时绿——最难查的一种假失败。
   *
   * 顺序上句长闸排在频控闸之前，所以不必等那 3000ms 冷却过去。
   */
  const after = await hostA.waitFor(
    (state) => (state.gateStats?.decisions ?? 0) > decisionsBefore,
    15000,
  )
  const gate2 = after.gateStats ?? {}
  check('第二轮也进了闸门判定', (gate2.decisions ?? 0) > decisionsBefore, `${String(decisionsBefore)} → ${String(gate2.decisions ?? 0)}`)
  check('短句被按 too-short 拦下', (gate2.blocked?.['too-short'] ?? 0) >= 1, JSON.stringify(gate2.blocked ?? {}))
  check('被拦下的那句没有出声', (gate2.spoken ?? 0) === spokenBefore, `${String(spokenBefore)} → ${String(gate2.spoken ?? 0)}`)

  console.log('\n--- 5. 归因：长而平铺的回复该记 flat，不该记 too-long ---')

  /*
   * 这一段锁的是**记账口径**，不是「出不出声」。
   *
   * 整段超过 `max-chars` 会走挑句；一句都挑不出来时，此前是拿**整段**
   * 去 `admit()`，闸门于是记住 `too-long`。但真因是每一句都 `flat`
   * （情绪强度不足、又没有情绪词）。实测日志是一对相邻行：
   *
   * ```
   * ondra.voice     整段过长，且分句后仍无可念句（flat）
   * ondra.tts-gate  语音未放行（too-long，72 字）
   * ```
   *
   * 设置页读的是 `blocked` 这个桶，于是它告诉主人「你的话太长」，
   * 而真正该看的是「她太平了」——归因错了，修法就全错。
   *
   * 回复里**刻意一个情绪词都没有**（避开 `放心` / `担心` / `喜欢` 这些
   * 在 40 词表里的词），这样情绪闸必然判 `flat`，判据不依赖情绪状态。
   */
  const FLAT_REPLY = '机器的硬盘还剩一百二十个 G 左右，风扇转速正常，温度也不高，性能方面没有问题。'

  const blockedBefore = { ...(gate2.blocked ?? {}) }
  replyFor = FLAT_REPLY
  const turn3 = await hostA.post('/api/inference', { input: '机器还好吗？' })
  check('第三轮对话返回 200', turn3.status === 200, `HTTP ${String(turn3.status)}`)

  const after3 = await hostA.waitFor(
    (state) => (state.gateStats?.decisions ?? 0) > (gate2.decisions ?? 0),
    15000,
  )
  const gate3 = after3.gateStats ?? {}
  check('第三轮也进了闸门判定', (gate3.decisions ?? 0) > (gate2.decisions ?? 0), `${String(gate2.decisions ?? 0)} → ${String(gate3.decisions ?? 0)}`)
  check(
    '长而平铺的回复被记成 flat',
    (gate3.blocked?.['flat'] ?? 0) > (blockedBefore['flat'] ?? 0),
    JSON.stringify(gate3.blocked ?? {}),
  )
  /*
   * 同时断言 `too-long` **没有**涨。
   *
   * 只断言 flat 涨是不够的：两个桶都涨也能让上一条绿，而那正是修复前的
   * 症状（一次判定往 `too-long` 里也记了一笔）。这条才是把旧行为钉死的。
   */
  check(
    '同一轮没有往 too-long 里错记',
    (gate3.blocked?.['too-long'] ?? 0) === (blockedBefore['too-long'] ?? 0),
    `${String(blockedBefore['too-long'] ?? 0)} → ${String(gate3.blocked?.['too-long'] ?? 0)}`,
  )

  console.log('\n--- 6. 收尾状态 ---')

  const finalA = await hostA.voice()
  check('结束时探针无阻塞原因', finalA.note === '', finalA.note || '（空）')
  /*
   * 宿主 stderr 里不该出现「朗读没做成」。
   *
   * 那是 `speakReply` 返回 `failed` 时宿主自己写的唯一一行。它出现就意味着
   * 「闸门放行了、合成却没成」——A 段第 3 条会红，但这一条能直接指出
   * 是哪一种失败（`spawn` / `timeout` / `empty` …）。
   */
  check(
    '宿主没有报「朗读没做成」',
    !hostA.stderrText().includes('朗读没做成'),
    hostA.stderrText().includes('朗读没做成')
      ? hostA.stderrText().trim().split('\n').slice(-3).join(' | ')
      : '（无）',
  )

  /* ================================================================ *
   * B 段：用户层配置真的进了插件
   * ================================================================ */

  console.log('\n=== B 段 · 用户层写的 min-chars 真的生效 ===')

  /*
   * 只动一个变量：`tts-gate.min-chars` 从默认 6 改成 2。
   *
   * 键名带连字符不是偶然——`enable` 那种单词键在 kebab 与 camel 两种命名里
   * 长得一模一样，用它当判据等于什么都没测。
   *
   * ## 这条断言锁的是什么，不锁什么（实测过，别信推测）
   *
   * 锁的是**「用户层有没有被注入到插件」这一整条**：把宿主
   * `buildMemberConfigs()` 里的注入整段切断，本段立刻红
   * （`blocked` 从 `{"flat":1}` 变回 `{"too-short":1}`）。这一点做过 A/B。
   *
   * **不锁** `camelizeKeys()` 那一步：`ondra-tts-gate` 自己的 `completeConfig()`
   * 用 `pick(raw, camel, kebab)` 两种键名都认（它是 63 个插件里唯一这么做的
   * 一个），所以即使宿主不做 kebab→camel 归一，这个插件照样读得到值。
   * 把 `camelizeKeys` 停掉，本段**仍然绿**——这条也做过 A/B，不是推测。
   *
   * 也就是说：camel 归一那一步的守卫仍在 `check:e2e` 身上（它把静默窗
   * 钉成空窗；若用户层被丢弃，夜间跑必红），而它是**时间相关**的。
   * 给 camel 归一补一条不依赖钟表的确定性断言，记在
   * `docs/PLUGIN-HEALTH.md` 的遗留里。
   */
  const hostB = await bootHost({ tts: { playback: 'off' }, 'tts-gate': { 'min-chars': 2 } })
  console.log(`宿主就绪：${hostB.base}`)

  const wiredB = await hostB.useFakeProvider()
  check('B 段供应商配置成功', wiredB.configured.status === 200, `HTTP ${String(wiredB.configured.status)}`)

  replyFor = SHORT_REPLY
  const turnB = await hostB.post('/api/inference', { input: '嗯，知道了。' })
  check('B 段对话返回 200', turnB.status === 200, `HTTP ${String(turnB.status)}`)

  const gateB = (await hostB.waitFor(
    (state) => (state.gateStats?.decisions ?? 0) >= 1,
    15000,
  )).gateStats ?? {}

  check('B 段这一句真的进了闸门判定', (gateB.decisions ?? 0) >= 1, `decisions=${String(gateB.decisions ?? 0)}`)
  /*
   * 同一句「嗯好。」，A 段被判 too-short、B 段不该再被判 too-short。
   *
   * 差别只可能来自 `min-chars`：若用户层被丢弃（第 1 轮那个缺陷），
   * 插件拿到的是默认 6，3 字照样 `too-short`，这条立刻红。
   *
   * 不在这里断言「放行了」——放不放行还要过情绪闸，而情绪强度依赖
   * 情绪服务此刻的状态，断言它会把一条确定性检查变成时红时绿。
   */
  check(
    '用户层 min-chars=2 已进插件（长度闸不再拦 3 字）',
    (gateB.blocked?.['too-short'] ?? 0) === 0,
    JSON.stringify(gateB.blocked ?? {}),
  )

  /* ================================================================ *
   * C 段：情绪词落在「念不出来的那一句」里，旁路仍然要生效
   * ================================================================ */

  console.log('\n=== C 段 · 整轮情绪词结论真的传到了 admit ===')

  /*
   * 这一段锁的是**情绪词旁路的取样范围**：手册 §9.4 的原话是
   * 「强度 ≥0.15 **或**本**轮**有情绪词」，而句长闸的口径是单**句**。
   *
   * 宿主要把长回复切成分句、只挑一句交给 `admit()`，而挑中的那一句
   * 很可能**不含**情绪词。若旁路按「这一句」判，`emotive` 就是 false，
   * 被 `flat` 拦下——症状是「她明明说了开心，却一声不响」：不报错、
   * 不影响文字，`blocked` 里只多一条 `flat`。
   *
   * ## 为什么不再走宿主黑盒（本段最贵的教训）
   *
   * 第 4 轮试过「起宿主 + 发一轮对话 + 断言 spoken 涨」。它**时红时绿**，
   * 而且绿的时候也证明不了什么。根子在闸门的 `emotionReason()`：
   *
   * ```ts
   * if (intensity === undefined) return undefined   // 缺数据不拦
   * ```
   *
   * 情绪服务在本轮还没有情绪事件时给不出 mood / energy，`intensity` 于是是
   * `undefined`，**任何**分句都会被放行——「旁路生效」与「根本没判」在探针
   * 上长得一模一样。实测同一段文本连跑两次：一次 `flat`、一次 `ok`，差别
   * 只在情绪服务那一刻有没有数据。
   *
   * 所以本段改为**确定性构造**：真 `Gate` 实例（真插件、真四道闸）、
   * 假 TTS（不合成、不播放、不碰扬声器）、直接调宿主的 `speakReply()`。
   * 情绪强度钉成基线 `mood=0.5 / energy=0.5` → `intensity=0 < 0.15`，
   * 于是**情绪闸一定拦**，唯一能救它的只有情绪词旁路。
   *
   * 对照组与实验组的文本**逐字相同，只删掉末尾的「开心。」**。两段之间
   * 只差这一个变量——这才是受控 A/B。
   *
   * ## 判据为什么读 `admit()` 的入参
   *
   * 只看 `spoken` 不够：它涨也可能来自别的路径。真正要钉住的是「整段的
   * 结论有没有被带进那一次 `admit()`」。所以给 `decide` / `admit` 各包一层
   * 探针，直接读它们收到的 `emotive`。
   *
   * 第 4 轮正是把 `turnEmotive` 临时置成 `undefined` 忘了还原——那时
   * `admit()` 收到 `undefined`，而 `spoken` 仍可能涨（候选句自己被判 ok
   * 的情形混进来），断言于是照绿。包一层探针就再也糊不过去。
   */
  const EMOTIVE_IN_SHORT_CLAUSE = '你问的那台机器我看过了，硬盘还剩一百二十个 G，风扇也很安静，性能没问题。开心。'
  /** 与上一行逐字相同，只删掉末尾那个 2 字情绪句。受控 A/B 的唯一变量。 */
  const SAME_WITHOUT_EMOTIVE = '你问的那台机器我看过了，硬盘还剩一百二十个 G，风扇也很安静，性能没问题。'

  const quietLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

  /**
   * 记录宿主写下的诊断行。
   *
   * 宿主调用的是 `ctx.logger('ondra.voice').debug('%s', message)`，所以只取
   * `%s` 之后那一个参数；不是 `%s` 形式就原样收下，免得断言依赖格式细节。
   * @param notes 收件数组。
   */
  function noteSink(notes) {
    return {
      debug: (format, ...rest) => {
        notes.push(rest.length > 0 ? rest.join(' ') : String(format))
      },
      info: () => {},
      warn: () => {},
      error: () => {},
    }
  }

  /**
   * 造一副「真闸门 + 假 TTS」的最小环境。
   *
   * 情绪固定成基线（`mood=0.5 / energy=0.5` → `intensity=0`）：不是为了造
   * 一个好看的场景，而是把「情绪强度」这个最大噪声源钉死，让「放行 / 拦下」
   * 只可能由情绪词旁路决定。
   * @returns 上下文、闸门、合成记录、闸门调用记录。
   */
  function voiceHarness(notes) {
    const synthesized = []
    const gateCalls = []
    const logSink = notes === undefined ? quietLog : noteSink(notes)
    const tts = {
      available: true,
      reason: '',
      engine: 'probe',
      speakable,
      async speak(text) {
        synthesized.push(text)
        return { ok: true, engine: 'probe' }
      },
      stats: () => ({ calls: synthesized.length, ok: synthesized.length, failures: 0, cache: 0 }),
    }
    const gate = new Gate({
      settings: DEFAULT_CONFIG,
      log: quietLog,
      now: () => 1_000_000,
      emotion: () => ({ state: () => ({ normalized: { mood: 0.5, energy: 0.5 } }) }),
      // 六态缺席：不参与判定，也少一个噪声源。
      express: () => undefined,
      tts: () => tts,
    })    /*
     * 包一层读入参。必须先 `bind`——`decide` / `admit` 是类方法，内部用
     * `this`；拆成裸函数再调会丢 `this` 抛错（见 `pickUtterance` 的路标注释）。
     */
    const decideBound = gate.decide.bind(gate)
    gate.decide = (text, options) => {
      gateCalls.push({ kind: 'decide', options })
      return decideBound(text, options)
    }
    const admitBound = gate.admit.bind(gate)
    gate.admit = (text, options) => {
      gateCalls.push({ kind: 'admit', text, options })
      return admitBound(text, options)
    }
    const ctx = {
      get: (key) => (key === 'ondra-tts-gate' ? gate : key === 'ondra-tts' ? tts : undefined),
      logger: () => logSink,
    }
    return { ctx, gate, synthesized, gateCalls }
  }

  console.log('\n--- C1. 实验组：整段带情绪词，旁路按整轮算 ---')

  const emo = voiceHarness()
  const outEmo = await speakReply(emo.ctx, EMOTIVE_IN_SHORT_CLAUSE)
  check('C1 带情绪词的长回复被放行', outEmo.status === 'spoken', `${outEmo.status} / ${String(outEmo.reason)}`)
  check('C1 只合成一次', emo.synthesized.length === 1, `合成 ${String(emo.synthesized.length)} 次`)
  check(
    'C1 念的是第一句长度合格的分句，不是整段',
    emo.synthesized[0] === '你问的那台机器我看过了',
    JSON.stringify(emo.synthesized[0] ?? ''),
  )
  const admitEmo = emo.gateCalls.filter((call) => call.kind === 'admit')
  check(
    'C1 整轮结论真的传进了 admit（emotive=true）',
    admitEmo.length === 1 && admitEmo[0].options?.emotive === true,
    `admit 次数=${String(admitEmo.length)} / emotive=${String(admitEmo[0]?.options?.emotive)}`,
  )

  console.log('\n--- C2. 对照组：只删掉「开心」，其余一字不差 ---')

  const plain = voiceHarness()
  const outPlain = await speakReply(plain.ctx, SAME_WITHOUT_EMOTIVE)
  check(
    'C2 没有情绪词就被 flat 拦下',
    outPlain.status === 'held' && outPlain.reason === 'flat',
    `${outPlain.status} / ${String(outPlain.reason)}`,
  )
  check('C2 一句都没合成', plain.synthesized.length === 0, `合成 ${String(plain.synthesized.length)} 次`)
  check(
    'C2 闸门确实判定过（不是没接线就直接返 held）',
    plain.gateCalls.filter((call) => call.kind === 'admit').length === 1,
    JSON.stringify(plain.gateCalls.map((call) => call.kind)),
  )

  /* ================================================================
   * D 段：无标点长句「切不动」时必须留一行诊断
   * ================================================================ */

  console.log('\n=== D 段 · 无标点长句切不动，但必须留痕 ===')

  /*
   * 这一段锁的是本轮唯一仍然「纯静默」的路径。
   *
   * 闸门先判句长（`service.ts` 的 `draft()` 第 143 行）再判情绪，所以一段
   * 没有任何标点、又超过 `max-chars` 的回复必定整段 `too-long`。宿主的
   * 补救是「挑一句能念的」，但 `clausesOf()` 靠标点切，无标点就只切出一段，
   * 候选**自己**就超长——于是：
   *
   * - 挑不出句子（`picked === undefined`）；
   * - 也没有 `fallback`（`firstBlock` 那条分支根本走不到）；
   * - 函数返回空对象，**一行日志都不写**。
   *
   * 症状在探针上和「她这轮不想说话」完全同形：`blocked.too-long` 涨了一格，
   * 没有别的话。前几轮一直把它记成「待查」，实际是归因缺失。
   *
   * ## 为什么不断言「念出半截话」
   *
   * 按字数拦腰截断能出声，但那违反手册对朗读的要求（一句完整的话）。
   * 所以这里的判据只有两条：**不出声**、**必须留痕**。行为不改善是刻意的，
   * 缺的是可观测性——把「切不动」与「不想说」分开。
   *
   * 对照组（C1）已经证明同一套环境下有标点就能念，所以这一段只要断言
   * 「无标点 → 沉默 + 有诊断」，不必再验正向。
   */
  const NO_PUNCT_LONG = '这台机器跑起来一点都不卡风扇也很安静硬盘还剩一百二十个G你完全可以放心用下去'
  const dNotes = []
  const bare = voiceHarness(dNotes)
  const outBare = await speakReply(bare.ctx, NO_PUNCT_LONG)
  check(
    'D 无标点长句整段判 too-long，不出声',
    outBare.status === 'held' && outBare.reason === 'too-long',
    `${outBare.status} / ${String(outBare.reason)}`,
  )
  check('D 一句都没合成（不硬切、不念半截话）', bare.synthesized.length === 0, `合成 ${String(bare.synthesized.length)} 次`)
  check(
    'D 必须留一行「切不动」诊断（不是静默）',
    dNotes.some((line) => line.includes('无标点可切')),
    JSON.stringify(dNotes),
  )
} finally {
  for (const { child, dataDir } of hosts) {
    child.kill()
    /*
     * 必须**等进程真的退出**再删目录。
     *
     * 宿主退出前还在收尾（关库、flush 日志）。`kill()` 只是发信号，
     * 立刻 `rm` 会撞上它正在写的文件，抛 `ENOTEMPTY`——而那是清理阶段的
     * 异常，会把已经全绿的断言结果盖成一次崩溃退出，读起来像被测能力坏了。
     * 本脚本第一版正是这么崩的。
     */
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
      // 临时目录删不掉不是被测能力的失败：系统会自己清。
    }
  }
  upstream.close()
}

console.log('')
if (failures.length === 0) {
  console.log('全部通过。')
} else {
  console.log(`${String(failures.length)} 条未通过：`)
  for (const item of failures) console.log(`  - ${item}`)
}
process.exit(failures.length === 0 ? 0 : 1)
