/**
 * 话术闸门：**一条消息能不能发出去**。纯函数，同样的输入永远同样的输出。
 *
 * ## 判定顺序（顺序就是优先级）
 *
 * ```
 * 1 开关关着            → disabled
 * 2 没驱动              → no-driver
 * 3 没连上              → not-connected
 * 4 空消息              → empty（整形之后才算「空」）
 * 5 超长                → too-long（本地已经截断，这里只兜后端）
 * 6 指令：不在白名单    → command-not-allowed
 * 7 指令：形状不对      → command-shape
 * 8 限频                → rate-limited
 * 9 每分钟预算          → budget-exhausted
 * ```
 *
 * ## 为什么「限频」排在内容判定之后
 *
 * 反过来的话，一条本来就会被拒的消息会先吃掉一次限频窗口——
 * 用户看到的是「被拒了但又得等 1.2 秒」，两个问题混在一起排查。
 * 内容先判、节奏后判，每条拒绝理由都只对应一个真问题。
 *
 * ## 为什么指令要做「形状」判定（不只是白名单）
 *
 * 白名单只回答「这个指令名许不许」。但 Minecraft 的指令参数里可以塞**选择器**：
 * `/kill @a`（杀掉服务器里所有人）、`/tp @e`（把全部实体瞬移）。
 * 白名单里有 `kill` 不代表允许 `@a`。所以第二条闸门看形状：
 * 含 `@`、`{`、`[`、`*`、`;`、`|`、`&`、`$`、反引号、反斜杠、换行的一律拒。
 *
 * 这是**结构白名单**而不是「过滤敏感词」，因为过滤总会漏，
 * 而形状判定能覆盖一整类注入（与 O-068 的 `adb shell` argv 白名单同一手法）。
 */

import { sanitize, sanitizeCommand } from './sanitize.js'
import type { PolicyConfig, SendVerdict } from './types.js'
import { CHAT_MAX, COMMAND_MAX } from './types.js'

/**
 * 指令里禁止出现的字符。
 *
 * `@`（选择器）、`{`/`[`（组件与列表参数）、`*`（通配）、`;`/`|`/`&`（串联命令）、
 * `$`/反引号（变量与执行）、反斜杠（转义）、换行（第二条命令）。
 */
const FORBIDDEN_RE = /[@{}[\]*;|&$`\\\n\r]/

/**
 * 从一段指令里取出「指令名」。
 *
 * 认 `/list` 与 `list` 两种写法；取到第一个空格为止，并转小写。
 * 空字符串（只有 `/`）返回 `''`。
 * @param text 指令。
 */
export function commandNameOf(text: string): string {
  const bare = text.trim().replace(/^\/+/, '')
  if (bare === '') return ''
  const first = bare.split(/\s+/, 1)[0]
  return first === undefined ? '' : first.toLowerCase()
}

/**
 * 一段聊天能不能发。
 * @param input 原始文本。
 * @param config 配置。
 * @param ready 驱动在位没有。
 * @param connected 连上没有。
 */
export function judgeChat(input: string, config: PolicyConfig, ready: boolean, connected: boolean): SendVerdict {
  if (!config.enable) {
    return refuse('disabled', '', 'Minecraft 接入是关着的。', '打开 enable；出厂只开放读状态。')
  }
  if (!config.enabledTools.includes('chat')) {
    return refuse(
      'chat-disabled',
      '',
      '发聊天没在 enabled-tools 里打开。',
      '要让她在游戏里说话，把 chat 加进 enabled-tools。',
    )
  }
  if (!ready) {
    return refuse(
      'no-driver',
      '',
      '没有 Minecraft 驱动，发不出去。',
      '装一个实现 MinecraftDriver 的端口（mineflayer 接线层）并 useDriver() 接进来。',
    )
  }
  if (!connected) {
    return refuse('not-connected', '', '还没连上服务器。', '先调 connect()：连接由调用方显式发起，本包不自动重连。')
  }

  const text = sanitize(input, config.chatMax)
  if (text === '') {
    return refuse('empty', '', '整形之后没有可发的内容。', '正文里全是控制字符或空白，换一句话。')
  }
  if (text.length > CHAT_MAX) {
    return refuse('too-long', text, `消息超过协议上限 ${CHAT_MAX} 字符。`, '本地会先截断，理论上不该走到这里——请检查 chatMax。')
  }

  return {
    allowed: true,
    code: 'ok',
    text,
    detail: `可以发（${text.length} 字符）。`,
  }
}

/**
 * 一段指令能不能发。
 * @param input 原始指令（可带 `/`）。
 * @param config 配置。
 * @param ready 驱动在位没有。
 * @param connected 连上没有。
 */
export function judgeCommand(
  input: string,
  config: PolicyConfig,
  ready: boolean,
  connected: boolean,
): SendVerdict {
  if (!config.enable) {
    return refuse('disabled', '', 'Minecraft 接入是关着的。', '打开 enable 之后再单独放行指令。')
  }
  if (!config.enabledTools.includes('command')) {
    return refuse(
      'command-disabled',
      '',
      '发指令没在 enabled-tools 里打开。',
      '`/` 是服务器管理员接口，出厂一律关闭；确认服务器是你的再把 command 加进 enabled-tools。',
    )
  }
  if (!ready) {
    return refuse(
      'no-driver',
      '',
      '没有 Minecraft 驱动，指令发不出去。',
      '装一个实现 MinecraftDriver 的端口并 useDriver() 接进来。',
    )
  }
  if (!connected) {
    return refuse('not-connected', '', '还没连上服务器。', '先调 connect()。')
  }

  const text = sanitizeCommand(input, COMMAND_MAX)
  if (text === '' || text === '/') {
    return refuse('empty', '', '空指令。', '至少给一个指令名，例如 `/list`。')
  }
  if (FORBIDDEN_RE.test(text)) {
    return refuse(
      'command-shape',
      text,
      '指令里出现了选择器或串联字符。',
      '指令只许「指令名 + 普通参数」：`@a`、`@e`、`{}`、`;`、`|` 这类一律不许——它们能一次作用到整个服务器。',
    )
  }
  const name = commandNameOf(text)
  if (name === '' || !config.commandAllowList.includes(name)) {
    return refuse(
      'command-not-allowed',
      text,
      name === '' ? '取不到指令名。' : `指令 \`${name}\` 不在允许列表里。`,
      '把要用的指令名加进 command-allow-list（小写、不含 `/`）；列表为空时一个指令都不许发。',
    )
  }

  return {
    allowed: true,
    code: 'ok',
    text: text.startsWith('/') ? text : `/${text}`,
    detail: `可以发（指令 \`${name}\`）。`,
  }
}

/**
 * 造一条拒绝。
 * @param code 结果码。
 * @param text 整形后的正文（拒绝时为原样或空）。
 * @param detail 说明。
 * @param hint 指路。
 */
function refuse(code: SendVerdict['code'], text: string, detail: string, hint: string): SendVerdict {
  return { allowed: false, code, text, detail, hint }
}
