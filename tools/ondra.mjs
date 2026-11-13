#!/usr/bin/env node
/**
 * 空谷命令行调试工具。
 *
 * ## 它为什么存在
 *
 * 界面出问题时，人的做法是「截图 → 猜是哪条规则 → 改 → 重新打包 → 再看」。
 * 一轮五分钟，而真正的原因往往在第七轮才浮现。这个工具把那一圈压成一次
 * 问答：`ondra ui dom .inspector` 直接给出那个面板的真实矩形与计算样式。
 *
 * ## 它连的是谁
 *
 * 不是壳，也不是内核，而是**宿主**的本地 HTTP 服务（默认 127.0.0.1:9060）。
 * 因为宿主是唯一同时握着配置（settings.json / config.json）与内核连接的一方。
 *
 * 令牌从数据目录的 `host.json` 读——那个文件只在调试开启时才存在，
 * 权限 0600。所以本工具在调试关闭时连「端口在哪」都不知道，这不是缺陷，
 * 是设计的一部分（见 `cordis-host/src/debug.ts` 文件头）。
 *
 * ## 开启方式
 *
 * ```sh
 * ondra on      # 写数据目录的 debug.enable，然后重启应用
 * ondra off
 * ```
 *
 * 也可以用 `ONDRA_DEBUG=1` 启动宿主（开发态）。
 *
 * ## 零依赖
 *
 * 只用 Node 内建模块。一个调试工具不该为了打印几行 JSON 去装一个 CLI 框架，
 * 也不该在 `pnpm install` 失败时跟着坏掉。
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// 数据目录与握手
// ---------------------------------------------------------------------------

/** 数据目录。与宿主 `resolveDataDir()` 的判据保持一致。 */
function dataDir() {
  const fromEnv = process.env.ONDRA_DATA_DIR?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'com.ntars.ondra')
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'com.ntars.ondra')
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'com.ntars.ondra')
}

const HANDSHAKE = () => join(dataDir(), 'host.json')
const SWITCH = () => join(dataDir(), 'debug.enable')

/** 终端着色。非 TTY（管道、CI）时不输出转义序列。 */
const color = (() => {
  const on = process.stdout.isTTY === true && process.env.NO_COLOR === undefined
  const wrap = (code) => (text) => (on ? `\u001B[${code}m${text}\u001B[0m` : String(text))
  return {
    dim: wrap('2'),
    bold: wrap('1'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    blue: wrap('36'),
  }
})()

/** 打印到 stderr 并退出。所有失败都走这里，保证退出码非零。 */
function fail(message, hint) {
  process.stderr.write(`${color.red('✗')} ${message}\n`)
  if (hint !== undefined) process.stderr.write(`  ${color.dim(hint)}\n`)
  process.exit(1)
}

/**
 * 读握手文件。
 *
 * 三种失败各给一句不同的话：没开调试、应用没跑、文件坏了。合并成
 * 一句「连不上」会让人在原地反复重启应用。
 */
async function connect() {
  const path = HANDSHAKE()
  if (!existsSync(path)) {
    const enabled = existsSync(SWITCH()) || process.env.ONDRA_DEBUG === '1'
    if (enabled) {
      fail(
        '调试开关已打开，但宿主没有写出握手文件——应用大概没在运行。',
        '先启动空谷 Ondra，再执行本命令。',
      )
    }
    fail(
      '调试接口没有开启。',
      `执行 \`node tools/ondra.mjs on\` 写入开关，然后重启应用。开关文件：${SWITCH()}`,
    )
  }

  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    fail(`读不到握手文件：${String(error)}`)
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail(`握手文件不是合法 JSON：${path}`, '删掉它，重启应用会重新生成。')
  }

  if (typeof parsed?.url !== 'string' || typeof parsed?.token !== 'string') {
    fail(`握手文件缺 url 或 token：${path}`, '删掉它，重启应用会重新生成。')
  }

  // 握手文件里的 pid 还活着吗。比直接连一次快，也能区分「应用没跑」与
  // 「应用跑了但端口不对」——后者通常是上一次运行留下的旧文件。
  if (typeof parsed.pid === 'number') {
    try {
      process.kill(parsed.pid, 0)
    } catch {
      fail(
        `握手文件指向的进程 ${String(parsed.pid)} 已经不在了。`,
        '应用可能已经退出。启动它，或删掉 host.json 后重试。',
      )
    }
  }

  return { url: parsed.url, token: parsed.token, version: parsed.version ?? '未知', port: parsed.port ?? 0, pid: parsed.pid ?? 0 }
}

/** 发一个 JSON 请求。 */
async function api(connection, path, options = {}) {
  const method = options.method ?? 'GET'
  let response
  try {
    response = await fetch(`${connection.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${connection.token}`,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
  } catch (error) {
    fail(
      `连不上宿主：${connection.url}`,
      `原因：${error instanceof Error ? error.message : String(error)}。应用可能正在退出。`,
    )
  }

  const text = await response.text()
  let payload
  try {
    payload = text === '' ? undefined : JSON.parse(text)
  } catch {
    payload = text
  }

  if (!response.ok) {
    const message =
      typeof payload === 'object' && payload !== null && typeof payload.error === 'string'
        ? payload.error
        : `HTTP ${String(response.status)}`
    fail(message)
  }
  return payload
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

/**
 * 把 `--key value`、`--flag` 与位置参数分开。
 *
 * 不引第三方解析器：本工具的参数只有十来种形态，而框架会带来
 * 「它到底怎么处理 `--`」这类与本工具无关的问题。
 */
function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const name = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true
    } else {
      flags[name] = next
      i += 1
    }
  }
  return { positional, flags }
}

/**
 * 把命令行上的字符串转成合适的类型。
 *
 * 顺序很重要：先试 JSON（`true` / `30` / `"x"` / `[1,2]` 都能正确还原），
 * 失败才当字符串。这样 `config set x y false` 得到的是布尔 false 而不是
 * 字符串 "false"——后者会被插件当成真值，症状是「开关关不掉」。
 */
function coerce(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** 打印一张两列表格。宽度按最长键对齐。 */
function table(rows, indent = '  ') {
  const width = rows.reduce((max, [key]) => Math.max(max, String(key).length), 0)
  for (const [key, value] of rows) {
    const label = String(key).padEnd(width)
    process.stdout.write(`${indent}${color.dim(label)}  ${value}\n`)
  }
}

/** 把值压成一行，便于表格显示。 */
function compact(value) {
  if (value === undefined) return color.dim('（未设置）')
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/** `status`：三进程与配置的总览。 */
async function cmdStatus(connection, { flags }) {
  const status = await api(connection, '/api/debug/status')
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
    return
  }

  const uptime = Math.round(status.uptimeMs / 1000)
  const minutes = Math.floor(uptime / 60)
  const seconds = uptime % 60

  process.stdout.write(`${color.bold('空谷 Ondra')} ${status.version}  ${color.green('调试已开启')}\n\n`)
  table([
    ['宿主', `${connection.url}（pid ${status.pid}）`],
    ['运行时长', minutes > 0 ? `${String(minutes)} 分 ${String(seconds)} 秒` : `${String(seconds)} 秒`],
    ['Node', `${status.node} / ${status.platform}-${status.arch}`],
    ['数据目录', status.dataDir],
    ['工作区', status.workspaceRoot],
    ['配置段', `${String(status.settingSections)} 段 / ${String(status.settingFields)} 项（已装载 ${String(status.activeSections)}，有段声明 ${String(status.registeredSections)}）`],
    ['插件', status.loadedPluginCount === undefined
      ? color.dim('（旧宿主：状态接口还没报这一项）')
      : `${String(status.loadedPluginCount)} 个已装载`],
    ['排队指令', status.queuedCommands === 0 ? color.dim('0') : `${String(status.queuedCommands)} ${color.yellow('（界面可能没在监听）')}`],
  ])
}

/** `on` / `off`：调试开关。 */
async function cmdSwitch(on) {
  const path = SWITCH()
  if (on) {
    await mkdir(dataDir(), { recursive: true })
    await writeFile(path, `${new Date().toISOString()}\n`, 'utf8')
    process.stdout.write(`${color.green('✓')} 已写入开关：${path}\n`)
    process.stdout.write(`  ${color.yellow('需要重启应用')}才生效。已经开着的话，从托盘退出再打开。\n`)
    process.stdout.write(`  ${color.dim('随后执行 `node tools/ondra.mjs status` 确认。')}\n`)
    return
  }
  if (!existsSync(path)) {
    process.stdout.write(`${color.dim('开关本来就是关的。')}\n`)
    return
  }
  await unlink(path)
  process.stdout.write(`${color.green('✓')} 已删除开关：${path}\n`)
  process.stdout.write(`  重启应用后调试接口不再注册。\n`)
}

/** `config` 概览：所有配置段与改动数。 */
async function cmdConfigList(connection, { flags }) {
  const data = await api(connection, '/api/debug/settings')
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
    return
  }

  const rows = data.sections.map((section) => {
    const changed = section.fields.filter((field) => field.changed).length
    const mark = changed > 0 ? color.yellow(`${String(changed)} 项已改`) : color.dim('全默认')
    const state = section.active ? '' : color.dim(' [插件停用]')
    return [section.id, `${color.dim(`${String(section.fields.length)} 项`)}  ${mark}${state}  ${color.dim(section.title)}`]
  })

  process.stdout.write(`${color.bold('配置段')} 共 ${String(data.totals.sections)} 段 / ${String(data.totals.fields)} 项，已改 ${String(data.totals.changed)} 项\n\n`)
  table(rows)
  process.stdout.write(`\n${color.dim('看某一项的当前值：node tools/ondra.mjs config <段>')}\n`)
}

/** `config <section>`：单段字段明细。 */
async function cmdConfigSection(connection, section, { flags }) {
  const data = await api(connection, `/api/debug/settings?section=${encodeURIComponent(section)}`)
  const target = data.sections[0]
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(target, null, 2)}\n`)
    return
  }

  process.stdout.write(`${color.bold(target.title)}  ${color.dim(target.id)}\n`)
  process.stdout.write(`  ${color.dim(target.dir)}${target.active ? '' : color.yellow('  [插件已停用]')}\n\n`)

  for (const field of target.fields) {
    const value = field.changed ? color.yellow(compact(field.value)) : compact(field.default)
    const badge = field.changed ? color.yellow(' *') : '  '
    process.stdout.write(`  ${field.key}${badge}\n`)
    process.stdout.write(`    ${value}${field.doc === undefined ? '' : color.dim(`  — ${field.doc}`)}\n`)
  }
  process.stdout.write(`\n${color.dim('* 表示这个值被改过；未标的是插件声明的默认值。')}\n`)
}

/**
 * `config get` / `set` / `reset`。
 *
 * @param {string[]} rest 子命令之后的参数：`[段, 字段, 值?]`。
 *   刻意不传整个 argv——第一版传的是完整参数，于是 `[0]` 是 `'config'`、
 *   `[1]` 是子命令，段名被读成了 `'set'`，报「没有这个配置段：set」。
 */
async function cmdConfigWrite(connection, action, rest) {
  const [section, key, rawValue] = rest
  if (section === undefined || key === undefined) {
    fail('用法：config get|set|reset <段> <字段> [值]')
  }

  if (action === 'get') {
    const data = await api(connection, `/api/debug/settings?section=${encodeURIComponent(section)}`)
    const target = data.sections[0]
    const field = target.fields.find((item) => item.key === key)
    if (field === undefined) fail(`配置段 ${section} 没有字段 ${key}`)
    process.stdout.write(`${field.changed ? compact(field.value) : compact(field.default)}\n`)
    return
  }

  const body = action === 'reset'
    ? { section, key, reset: true }
    : { section, key, value: coerce(rawValue ?? '') }

  const result = await api(connection, '/api/debug/settings', { method: 'POST', body })
  const before = result.before === undefined ? color.dim('（默认）') : compact(result.before)
  const after = result.after === undefined ? color.dim('（回落到默认）') : compact(result.after)
  process.stdout.write(`${color.green('✓')} ${result.section}.${result.key}\n`)
  process.stdout.write(`  ${before} ${color.dim('→')} ${after}\n`)
  process.stdout.write(`  ${color.dim('下次启动宿主或插件读取时生效。')}\n`)
}

/** `logs`：调试日志。 */
async function cmdLogs(connection, { flags }) {
  const lines = typeof flags.lines === 'string' ? flags.lines : '200'
  const data = await api(connection, `/api/debug/logs?lines=${encodeURIComponent(lines)}`)
  if (data.lines.length === 0) {
    process.stdout.write(`${color.dim('（还没有日志）')}\n`)
    return
  }
  process.stdout.write(`${color.dim(data.path)}\n\n`)
  for (const line of data.lines) process.stdout.write(`${line}\n`)
}

/**
 * `ui`：所有界面动作的统一入口。
 *
 * 每个子命令最终都落到 `POST /api/debug/ui`，动作名与前端注册表一一对应。
 * 这样加一个新动作不需要改这个文件——`ui action <名字> '{...}'` 就能试。
 */
async function cmdUi(connection, positional, flags) {
  const [sub, ...rest] = positional

  /** 发一条界面指令并打印结果。 */
  const send = async (action, args, { quiet = false } = {}) => {
    const result = await api(connection, '/api/debug/ui', { method: 'POST', body: { action, args } })
    if (result.ok !== true) fail(`界面动作 ${action} 失败：${result.error ?? '未知原因'}`)
    if (!quiet) {
      if (flags.json === true) process.stdout.write(`${JSON.stringify(result.result, null, 2)}\n`)
      else if (typeof result.result === 'string') process.stdout.write(`${result.result}\n`)
      else process.stdout.write(`${JSON.stringify(result.result, null, 2)}\n`)
    }
    return result.result
  }

  switch (sub) {
    case undefined:
    case 'state':
      return send('state.get', {})
    case 'open':
      return send('panel.open', { panel: rest[0] ?? '' })
    case 'close':
      return send('panel.close', { panel: rest[0] ?? 'all' })
    case 'theme': {
      const mode = rest[0]
      if (mode !== 'light' && mode !== 'dark' && mode !== 'system') {
        fail('用法：ui theme light|dark|system')
      }
      return send('theme.set', { mode })
    }
    case 'click':
      if (rest[0] === undefined) fail('用法：ui click <选择器>')
      return send('dom.click', { selector: rest[0] })
    case 'type': {
      const text = rest.join(' ')
      if (text === '') fail('用法：ui type <文本> [--selector .composer__input] [--send]')
      await send('composer.set', { text }, { quiet: true })
      if (flags.send === true) {
        // 让 React 先把 draft 落到 state，再点发送。同一个宏任务里连续两次
        // 状态更新会让按钮还停在"禁用"上，点击等于没点。
        await new Promise((resolve) => { setTimeout(resolve, 200) })
        const result = await send('composer.send', {}, { quiet: true })
        process.stdout.write(`${color.green('✓')} 已发送\n`)
        return result
      }
      process.stdout.write(`${color.green('✓')} 输入框已填入 ${String(text.length)} 个字\n`)
      return undefined
    }
    case 'press': {
      const key = rest[0]
      if (key === undefined) fail('用法：ui press <键名> [--meta] [--shift]')
      return send('dom.press', {
        key,
        ...(flags.meta === true ? { meta: true } : {}),
        ...(flags.ctrl === true ? { ctrl: true } : {}),
        ...(flags.shift === true ? { shift: true } : {}),
        ...(flags.alt === true ? { alt: true } : {}),
      })
    }
    case 'dom': {
      if (rest[0] === undefined) fail('用法：ui dom <选择器> [--style prop,prop]')
      const props = typeof flags.style === 'string' ? flags.style.split(',').map((item) => item.trim()) : undefined
      return send('dom.query', {
        selector: rest[0],
        ...(props === undefined ? {} : { style: props }),
      })
    }
    case 'dump': {
      const args = {
        selector: rest[0] ?? 'body',
        depth: typeof flags.depth === 'string' ? Number(flags.depth) : 6,
      }
      return send('dom.dump', args)
    }
    case 'toast': {
      const text = rest.join(' ')
      if (text === '') fail('用法：ui toast <文字>')
      return send('toast', { text })
    }
    case 'reload':
      return send('reload', {})
    case 'action': {
      const name = rest[0]
      if (name === undefined) fail('用法：ui action <动作名> [JSON 参数]')
      const args = rest[1] === undefined ? {} : coerce(rest[1])
      return send(name, typeof args === 'object' && args !== null ? args : {})
    }
    default:
      fail(`未知子命令：ui ${sub}`, '可用：state / open / close / theme / click / type / press / dom / dump / toast / reload / action')
  }
}

/** `say`：发一句话并打印回复。 */
async function cmdSay(connection, positional, flags) {
  const text = positional.join(' ')
  if (text === '') fail('用法：say <文本> [--session <id>]')

  const body = {
    input: text,
    sessionId: typeof flags.session === 'string' ? flags.session : '',
  }

  const response = await fetch(`${connection.url}/api/inference`, {
    method: 'POST',
    headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok || response.body === null) {
    const detail = await response.text()
    fail(`推理失败（${String(response.status)}）：${detail.slice(0, 200)}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let sessionId = body.sessionId
  let reasoning = 0
  /** 流式吐出来的原文（拼起来），用来和 `done` 的最终文本对账。 */
  let streamed = ''
  /** `done` 里的最终文本。空串表示这一轮没有正文。 */
  let finalText = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let at = buffer.indexOf('\n\n')
    while (at !== -1) {
      const block = buffer.slice(0, at)
      buffer = buffer.slice(at + 2)
      at = buffer.indexOf('\n\n')

      let event = 'message'
      const dataLines = []
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7)
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
      }
      if (dataLines.length === 0) continue
      let payload
      try {
        payload = JSON.parse(dataLines.join('\n'))
      } catch {
        continue
      }

      if (event === 'session' && typeof payload.sessionId === 'string') sessionId = payload.sessionId
      else if (event === 'delta' && typeof payload.text === 'string') {
        streamed += payload.text
        process.stdout.write(payload.text)
      }
      else if (event === 'reasoning') reasoning += 1
      else if (event === 'error') fail(`推理出错：${payload.message ?? '未知'}`)
      else if (event === 'done' && payload.aborted === true) process.stdout.write(`\n${color.dim('（已中断）')}\n`)
      /*
       * `done` 里的完整文本才是「她真说了什么」。
       *
       * ## 为什么必须先打印 delta 再对一次账
       *
       * 流式 `delta` 是模型吐出来的原文；`done` 里是**过了口语化塑形**的那句
       * （见宿主 `src/oral.ts`：塑形发生在发 `done` 之前，界面用 `done`
       * 覆盖正文）。只打 delta，这个工具看到的永远是「没塑形」的样子，
       * 于是「口语化到底生没生效」在命令行里根本无法验证——
       * 而那正是本轮要验的东西。
       *
       * 两者不同时补一句差异，但**不重印全文**：正文已经流式打过一遍，
       * 再打一遍会让人以为她说了两次。
       */
      else if (event === 'done' && payload.aborted !== true && typeof payload.text === 'string') {
        if (payload.text !== '') {
          finalText = payload.text
        }
      }
    }
  }

  /*
   * 收尾：正文有差别时把「她真说的那句」补出来。
   *
   * 只有真不一样才补。每轮都补会让正常输出多出一大段重复；
   * 而完全一致时提一句「塑形没改动」，那又是把「没接线」与
   * 「接了但这一轮没什么可改」说成同一件事的误导。
   */
  if (finalText !== '' && finalText !== streamed) {
    process.stdout.write(`\n\n${color.dim('（塑形后，界面上显示的是这句：）')}\n${finalText}\n`)
  }
  process.stdout.write(`\n\n${color.dim(`会话 ${sessionId}${reasoning > 0 ? `，思考 ${String(reasoning)} 段` : ''}`)}\n`)
}

/** `sessions` / `models` / `tools`：三条只读列表。 */
async function cmdList(connection, what, { flags }) {
  const path = what === 'sessions' ? '/api/sessions' : what === 'models' ? '/api/models' : '/api/tools'
  const data = await api(connection, path)
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
    return
  }

  if (what === 'sessions') {
    if (data.length === 0) return void process.stdout.write(`${color.dim('（还没有会话）')}\n`)
    for (const session of data) {
      process.stdout.write(`  ${color.dim(session.id)}  ${session.title || color.dim('（未命名）')}\n`)
    }
    return
  }

  if (what === 'models') {
    for (const model of data) {
      const mark = model.selected === true ? color.green('●') : ' '
      process.stdout.write(`  ${mark} ${color.dim(model.id)}  ${model.name ?? ''}\n`)
    }
    return
  }

  for (const tool of data) {
    process.stdout.write(`  ${color.dim(tool.name)}  ${tool.description ?? ''}\n`)
  }
}

/** `raw`：直接打任何接口，逃生口。 */
async function cmdRaw(connection, positional, flags) {
  const [method, path, body] = positional
  if (path === undefined) fail('用法：raw <METHOD> <路径> [JSON]')
  const result = await api(connection, path, {
    method,
    ...(body === undefined ? {} : { body: coerce(body) }),
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

const HELP = `空谷命令行调试工具

用法：ondra <命令> [参数]

  status                     宿主状态、版本、配置规模
  on | off                   打开 / 关闭调试开关（需重启应用）
  config                     列出全部配置段
  config <段>                某一段的字段与当前值
  config get <段> <字段>     读一个值
  config set <段> <字段> <值> 写一个值（值按 JSON 解析）
  config reset <段> <字段>   恢复默认（删掉用户层这一键）
  logs [--lines 200]         调试日志
  say <文本> [--session id]  发一句话并打印回复

  ui state                   当前界面状态（会话、面板、主题）
  ui open <面板>             打开：inspector / settings / preferences /
                             today / week / memory / theater
  ui close <面板>            关闭（不写参数 = 全部关闭）
  ui theme <模式>            light / dark / system
  ui click <选择器>          点击一个元素
  ui type <文本> [--send]    填入输入框，--send 顺带发送
  ui press <键> [--meta]     派发按键
  ui dom <选择器>            元素的矩形与计算样式
  ui dump [选择器]           元素树（带矩形）
  ui toast <文字>            弹一条提示
  ui reload                  刷新界面
  ui action <名字> [JSON]    调用任意已注册动作

  sessions | models | tools  列表
  raw <METHOD> <路径> [JSON] 直接打任意接口

全局：--json 输出原始 JSON
`

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const command = positional[0]

  if (command === undefined || command === 'help' || flags.help === true) {
    process.stdout.write(HELP)
    return
  }

  // 开关两条命令不需要连宿主：它们的作用恰恰是「让下一次启动时的宿主开起来」。
  if (command === 'on' || command === 'off') {
    await cmdSwitch(command === 'on')
    return
  }

  const connection = await connect()

  switch (command) {
    case 'status':
      return cmdStatus(connection, { flags })
    case 'logs':
      return cmdLogs(connection, { flags })
    case 'say':
      return cmdSay(connection, positional.slice(1), flags)
    case 'ui':
      return cmdUi(connection, positional.slice(1), flags)
    case 'sessions':
    case 'models':
    case 'tools':
      return cmdList(connection, command, { flags })
    case 'raw':
      return cmdRaw(connection, positional.slice(1), flags)
    case 'model': {
      const id = positional[1]
      if (id === undefined) fail('用法：model <模型 id>')
      await api(connection, '/api/models/select', { method: 'POST', body: { model: id } })
      process.stdout.write(`${color.green('✓')} 已切到 ${id}\n`)
      return
    }
    case 'config': {
      const sub = positional[1]
      if (sub === undefined) return cmdConfigList(connection, { flags })
      if (sub === 'get' || sub === 'set' || sub === 'reset') {
        return cmdConfigWrite(connection, sub, positional.slice(2))
      }
      return cmdConfigSection(connection, sub, { flags })
    }
    default:
      fail(`未知命令：${command}`, '执行 `node tools/ondra.mjs help` 看全部命令。')
  }
}

await main()
