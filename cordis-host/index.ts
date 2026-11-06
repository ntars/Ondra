/**
 * Cordis 宿主启动入口。
 *
 * ## 职责
 *
 * 1. 建立 Cordis 根上下文。
 * 2. 挂上 `desktop-bridge` 与 `dsh-client` 两个基础插件。
 * 3. 按需装载空谷核心（`ondra-core`，默认不装，见下）。
 * 4. 启动本地 HTTP 服务，把业务接口挂到路由上。
 * 5. 向父进程（Tauri 壳）报告就绪与访问地址。
 *
 * 它**不含业务逻辑**：所有业务都在插件里。入口只做装配与进程边界处理，
 * 这样换掉任一插件都不需要动这个文件。
 *
 * ## `ondra-core`：装入包内，默认全部禁用
 *
 * 它的 134 个成员属于旧项目那套 dsh 功能（情绪、记忆、人设、各类 IM 适配器），
 * 当前界面上真实使用的只有：会话、消息、模型、权限、工作区——都不在 core 里。
 *
 * 所以代码随包分发（用户能看到这些能力存在），但默认一个都不装载。
 * 要启用某个能力时，把它的 id 放进 `ONDRA_CORE_ENABLE`（逗号分隔）即可，
 * 不需要改代码也不需要重做打包流程。
 *
 * ### 体积：纠正一个曾经写错的数字
 *
 * 这里原先写「跟随软链后 929MB」，并据此认为必须把 core 剔出发布包。
 * 那个数字是 `du -shL` 的输出，而 `-L` 会把每条软链指向的内容**重复计入**：
 * pnpm 把 134 个插件都软链到同一份 `node_modules/.pnpm`，
 * 于是 47MiB 的真实文件被数了 134 次，滚成了 906MB。
 *
 * 按 inode 去重后实测：`plugins/ondra-core/node_modules` 只有
 * **47.4 MiB / 6375 个文件**，`@ntars/cordis` 本体只有 93 KiB。
 * 这个量级完全可以随包分发，所以「默认不装」的理由是
 * **界面不需要它**（少一片出错面），从来不是「装不下」。
 *
 * 判断一个目录的真实占用请用 `du -sh`（不跟随软链）或按 inode 去重统计，
 * 不要用 `du -shL`。
 *
 * ## 进程通信
 *
 * 与壳之间用 stdio 上的行分隔 JSON。为什么不用 Electron 那套 IPC：
 * 那是 Electron 专有的，Tauri 侧无法直接对接；而 stdio 是任何语言都能读写的
 * 最底层契约，壳换成什么都成立。
 */

import { Context } from '@ntars/cordis'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
// 插件按包名导入而非相对路径：包名让依赖关系可被 pnpm 与 tsc 的工程引用追踪，
// 相对路径则会绕过 workspace 链接，把插件源码编进宿主产物——那样插件的
// 自身依赖（如 dsh-sidecar）在运行时就解析不到了。
import * as desktopBridgePlugin from '@ondra/cordis-plugin-desktop-bridge'
import * as dshClientPlugin from '@ondra/cordis-plugin-dsh-client'
import { startWebServer, type RouteHandler, type RouteRequest, type StreamEmitter } from './src/server.js'
import { ConfigStore, resolveDataDir, type PermissionLevel, type StoredProfile } from './src/config.js'
import { ensureWorkspace, resolveWorkspaceRoot } from './src/workspace.js'
import { SettingsStore, scanSections, type SettingsSection, type SettingsSnapshot } from './src/settings.js'

/** 宿主与壳之间的消息形态。 */
type ShellMessage =
  | { type: 'ready'; url: string; token: string; port: number }
  | { type: 'fatal'; message: string }

/** 向壳发送一条消息。 */
function sendToShell(message: ShellMessage): void {
  const line = `${JSON.stringify(message)}\n`
  // 写 stdout 是协议通道。日志一律走 stderr，混在一起壳就解析不了。
  process.stdout.write(line, (error) => {
    // 回调参数在 Node 类型里是可选的，用 `!= null` 同时挡住 undefined 与 null。
    if (error != null) process.stderr.write(`[host] 写 stdout 失败：${error.message}\n`)
  })
}

/**
 * 解析核心启用名单。
 *
 * 格式是逗号分隔的成员 id，例如 `ONDRA_CORE_ENABLE=ondra-rhythm,ondra-tts`。
 * 未设置或为空时返回空数组，表示「全部禁用」——这是默认策略。
 *
 * 为什么用环境变量而不是配置文件：这是一条调试/灰度开关，
 * 不该出现在用户能改的配置界面上。等某个能力真的接通了，
 * 它的启用与否应该由代码里的成员定义决定，而不是靠用户设环境变量。
 */
function parseEnableList(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return []
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/**
 * 解析端口环境变量。
 *
 * 解析不出来时返回 undefined 而不是 0：0 表示"让系统随机分配"，
 * 是个有意义的指令；而环境变量写错（比如 `ONDRA_PORT=906O` 用了字母 O）
 * 应该退回默认的 9060 起点，不该被误当成"用户想要随机端口"。
 * 静默退回默认起点并打一行警告，比让宿主起在一个用户没预期的端口上好。
 */
function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  // 只接受 0 与 1–65535 的整数。负数、小数、超范围的端口都不是有效端口。
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    process.stderr.write(`[host] ONDRA_PORT="${raw}" 不是有效端口，改用默认端口\n`)
    return undefined
  }
  return value
}

async function main(): Promise<void> {
  const ctx = new Context()
  // baseUrl 影响插件的相对路径解析。指向宿主根目录，让插件内的资源路径
  // 相对于 cordis-host/ 而不是当前工作目录——后者取决于用户从哪里启动。
  ctx.baseUrl = new URL(`file://${join(import.meta.dirname, '..')}/`).href

  // --- 0. 数据与配置 ---------------------------------------------------------
  const dataDir = resolveDataDir()
  const config = await ConfigStore.open(join(dataDir, 'config.json'))
  // 内核的会话目录与配置分开：会话是用户数据（会备份、会迁移），
  // 配置是本机偏好（换机器该重填）。混在一起会让"只带走对话记录"做不到。
  const sessionsDir = join(dataDir, 'sessions')
  // 内核通过环境变量拿到数据目录，不自己推导——见 dsh-sidecar/src/index.ts。
  process.env.ONDRA_DATA_DIR = sessionsDir

  // --- 1. 桌面能力桥 ---------------------------------------------------------
  // 壳命令通道由 Tauri 的 IPC 提供，宿主通过环境变量拿到命令端点描述。
  // 骨架阶段未接壳时，缺省实现会明确抛错，便于在日志里立刻发现。
  await ctx.plugin(desktopBridgePlugin, {
    invoke: createShellInvoker(),
  })

  // --- 2. dsh 内核客户端 -----------------------------------------------------
  const sidecarEntry = resolveSidecarEntry()
  await ctx.plugin(dshClientPlugin, {
    entryPath: sidecarEntry,
    autoStart: true,
  })

  // --- 3. 空谷核心（装入包内，默认全部禁用） ---------------------------------
  // 134 个迁入插件随包分发，但默认一个都不装载：它们属于旧项目那套 dsh 功能
  // （情绪、记忆、人设、各类 IM 适配器），当前界面一个都没接。
  //
  // 「装着不用」而不是「不打包」是有意的：这些是产品的一部分，
  // 将来接通某个能力时把 id 加进 ONDRA_CORE_ENABLE 就能启用，不必重做打包流程。
  const corePlugin = await import('@ondra/cordis-plugin-ondra-core')
  const enableList = parseEnableList(process.env.ONDRA_CORE_ENABLE)
  const coreResult = await corePlugin.loadCore(ctx, { enable: enableList })
  logInfo(
    ctx,
    `空谷核心：清单 ${String(corePlugin.MIGRATED_PLUGIN_COUNT)} 项，`
    + `装载 ${String(coreResult.loaded.length)} 项，禁用 ${String(coreResult.skipped.length)} 项`,
  )
  // 跳过项只在「有启用名单」时逐条打原因。默认全禁的情况下逐条打 134 行
  // 只会把日志刷满，而那 134 行说的是同一件事：「这是默认策略」。
  if (enableList.length > 0) {
    for (const item of coreResult.skipped) {
      process.stderr.write(`[host] 未装载 ${item.id}：${item.reason}\n`)
    }
  }

  // --- 4. 把已存的配置推给内核 -----------------------------------------------
  // 内核启动时还不知道用户配过什么，这里补一次。失败不阻断启动：
  // 配置推送失败时内核仍有本地演示模型可用，界面不会完全不能用。
  await syncConfigToKernel(ctx, config.read())

  // --- 4.5 插件设置段 -------------------------------------------------------
  // 用户层单独一个文件（`settings.json`），不与模型密钥混存：前者是偏好、
  // 后者是凭据，混在一起会让「只带走偏好」或「只重置密钥」都做不到。
  const settings = await SettingsStore.open(join(dataDir, 'settings.json'))
  // 已装载名单：只用于在界面上标「插件已停用」（§6.7 的灰显义务）。
  // 默认全禁时 122 段全部灰显，这是真实状态，不该在界面上假装它们可用。
  const enabledPlugins = new Set(enableList)

  /*
   * 扫描一次，全程复用。
   *
   * 137 个包逐个 `import()` 实测 842ms。若每个请求都扫一遍，设置页每拖一次
   * 滑杆都要等近一秒——而插件的 `settings.js` 是一份静态常量，进程活着的
   * 期间不会变。装新插件本来就要求重启，所以缓存不存在"读到旧数据"的风险。
   */
  const settingsSections = await scanSections(resolvePluginsRoot(), enabledPlugins)
  logInfo(
    ctx,
    `插件设置段 ${String(settingsSections.length)} 个`
    + `（已注册 ${String(settingsSections.filter((item) => item.registered).length)}），`
    + `字段 ${String(settingsSections.reduce((sum, item) => sum + item.fields.length, 0))} 个`,
  )

  // --- 5. HTTP 服务 ----------------------------------------------------------
  const routes = buildRoutes(ctx, config, settings, settingsSections)
  // 端口策略：默认 9060 起，被占用则逐个顺延（见 src/server.ts 的 listenWithFallback）。
  // 允许用 ONDRA_PORT 覆盖，方便调试时指定别的起点；传 0 则退回系统随机分配。
  //
  // 这里不能写成 `{ port: parsePort(...) }`：项目开了 exactOptionalPropertyTypes，
  // 显式传 undefined 与"不传"是两回事，前者通不过类型检查。
  // 解析出 undefined 时就整个省掉这个字段，让 startWebServer 用它的默认值。
  const portOverride = parsePort(process.env.ONDRA_PORT)
  const server = await startWebServer(routes, portOverride === undefined ? {} : { port: portOverride })

  // --- 6. 报告就绪 -----------------------------------------------------------
  sendToShell({ type: 'ready', url: `${server.protocol}://127.0.0.1:${String(server.port)}`, token: server.token, port: server.port })
  logInfo(ctx, `宿主已就绪，监听 127.0.0.1:${String(server.port)}，数据目录 ${dataDir}`)
  logInfo(ctx, `工作区根目录 ${resolveWorkspaceRoot()}`)

  // --- 7. 优雅关闭 -----------------------------------------------------------
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => stopping ??= (async () => {
    await server.close()
    // 销毁根 Fiber 会触发全部插件的清理动作（含关闭内核子进程）。
    // 用 fiber.dispose 而不是某个事件名：Cordis 4 的事件表里没有 'dispose'，
    // 只有 internal/* 内部事件。
    await ctx.fiber.dispose()
  })()

  // 父进程关闭管道即表示壳退出了，此时必须跟着退出，否则成为孤儿进程。
  process.stdin.on('end', () => { void stop().finally(() => { process.exit(0) }) })
  process.on('SIGTERM', () => { void stop().finally(() => { process.exit(0) }) })
  process.on('SIGINT', () => { void stop().finally(() => { process.exit(0) }) })
}

/**
 * 写一条信息级日志。
 *
 * 骨架阶段不假设框架一定挂了 logger 实现，故先探测再回落 stderr。
 * 用独立的辅助函数而不是可选链：可选链只能传参给已存在的方法，
 * 无法在方法缺失时换一条输出通道。
 */
function logInfo(ctx: Context, message: string): void {
  const logger = (ctx as unknown as { logger?: { info?: (msg: string) => void } }).logger
  if (logger?.info !== undefined) logger.info(message)
  else process.stderr.write(`[host] ${message}\n`)
}

/** 组装 HTTP 路由表。 */
function buildRoutes(
  ctx: Context,
  config: ConfigStore,
  settings: SettingsStore,
  sections: readonly SettingsSection[],
): ReadonlyMap<string, RouteHandler> {
  const routes = new Map<string, RouteHandler>()

  /** 健康检查。壳用它确认宿主仍在响应。 */
  routes.set('GET /api/health', () => ({ body: { ok: true, at: Date.now() } }))

  /** 会话列表。转发到内核。 */
  routes.set('GET /api/sessions', async () => {
    const client = getDsh(ctx)
    const list = await client.call('session.list', { includeArchived: false })
    return { body: list }
  })

  /**
   * 创建会话。
   *
   * ## 工作区在这里建立，不在内核
   *
   * 创建会话的同时建立 `~/Ondra/workspace/YYYY-MM-DD` 目录，并把绝对路径
   * 写进会话元信息。三点理由：
   *
   * 1. **路径策略只有一处**：按日期分、根目录在哪、要不要建，全在这个文件里。
   *    内核只收到一个字符串，可以被换到任何环境而不必改。
   * 2. **进入即有答案**：用户点"新建对话"的那一刻，工作区就真实存在了，
   *    而不是等到第一次写文件才突然冒出来。
   * 3. **绑定是持久的**：路径写进会话文件，重启后仍在。不需要额外维护
   *    一张"会话 → 目录"的映射表——少一份数据就少一处可能不一致。
   *
   * 目录创建失败不阻断会话创建：会话本身是可用的，只是没有工作区。
   * 此时 workspace 留空串，界面显示"未绑定"，而不是显示一条会让人
   * 找不到东西的假路径。
   */
  routes.set('POST /api/sessions', async (request: RouteRequest) => {
    const client = getDsh(ctx)
    const body = (request.body ?? {}) as Record<string, unknown>
    const title = typeof body.title === 'string' ? body.title : ''

    let workspace = ''
    try {
      workspace = await ensureWorkspace(Date.now())
    } catch (error) {
      process.stderr.write(`[host] 建立工作区失败：${String(error)}\n`)
    }

    const meta = await client.call('session.create', { title, workspace })
    return { status: 201, body: meta }
  })

  /** 单个会话详情。 */
  routes.set('GET /api/sessions/:id', async (request: RouteRequest) => {
    const client = getDsh(ctx)
    const meta = await client.call('session.get', { id: request.params.id })
    return { body: meta }
  })

  /** 会话消息。界面打开历史对话时读它。 */
  routes.set('GET /api/sessions/:id/messages', async (request: RouteRequest) => {
    const client = getDsh(ctx)
    const messages = await client.call('session.messages', { sessionId: request.params.id })
    return { body: messages }
  })

  /** 归档会话。 */
  routes.set('POST /api/sessions/:id/archive', async (request: RouteRequest) => {
    const client = getDsh(ctx)
    await client.call('session.archive', { id: request.params.id })
    return { body: { ok: true } }
  })

  /**
   * 发起一轮对话，以流式返回。
   *
   * ## 为什么这里要自己订阅内核事件而不是直接等 `inference.run` 的返回值
   *
   * `inference.run` 要等整轮结束才返回。若只依赖它，界面在生成期间完全空白。
   * 内核在生成过程中逐块推送 `event.inference.delta`，这里转发给前端，
   * 界面就能边生成边显示。
   *
   * ## 会话 id 什么时候创建
   *
   * 前端可以先不发会话 id。空状态页的输入框没有"新会话"这个动作，
   * 用户直接在首页打字就开始对话了。此时由宿主先建一个会话，
   * 并通过 `session` 帧把 id 告诉前端，前端据此更新地址栏状态。
   */
  routes.set('POST /api/inference', async (request: RouteRequest) => {
    const client = getDsh(ctx)
    const body = (request.body ?? {}) as Record<string, unknown>
    const input = typeof body.input === 'string' ? body.input : ''
    if (input.trim() === '') {
      return { status: 400, body: { error: '内容不能为空' } }
    }

    let sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    // 没有会话就先建一个。标题留空，内核会用首轮内容自动命名。
    // 首页直接打字走的就是这条路，因此工作区也要在这里建一次——
    // 否则"从首页开始说话"的用户会没有工作区，而"点新建对话"的用户有。
    if (sessionId === '') {
      let workspace = ''
      try {
        workspace = await ensureWorkspace(Date.now())
      } catch (error) {
        process.stderr.write(`[host] 建立工作区失败：${String(error)}\n`)
      }
      const created = await client.call('session.create', { title: '', workspace }) as { id?: unknown }
      if (typeof created.id !== 'string') {
        return { status: 500, body: { error: '创建会话失败' } }
      }
      sessionId = created.id
    }
    const finalSessionId = sessionId

    return {
      stream: async (emit: StreamEmitter) => {
        emit.send('session', { sessionId: finalSessionId })

        // 只转发属于本会话的增量。内核可能同时在跑别的会话，
        // 不过滤会把 A 会话的字混进 B 会话的界面。
        const unsubscribe = client.onEvent((event) => {
          if (event.method === 'event.inference.reasoning') {
            const params = event.params as { sessionId?: unknown; text?: unknown } | undefined
            if (params?.sessionId !== finalSessionId) return
            if (typeof params.text !== 'string') return
            // 思考过程用独立帧名。界面据此把它渲染成"正在思考"的浅色过程，
            // 而不是当成正文的一部分。
            emit.send('reasoning', { text: params.text })
            return
          }
          if (event.method !== 'event.inference.delta') return
          const params = event.params as { sessionId?: unknown; text?: unknown } | undefined
          if (params?.sessionId !== finalSessionId) return
          if (typeof params.text !== 'string') return
          emit.send('delta', { text: params.text })
        })

        try {
          const result = await client.call('inference.run', { sessionId: finalSessionId, input }) as {
            text?: unknown
            aborted?: unknown
          }
          emit.send('done', {
            text: typeof result.text === 'string' ? result.text : '',
            aborted: result.aborted === true,
          })
        } finally {
          unsubscribe()
        }
      },
    }
  })

  /** 中断正在进行的推理。 */
  routes.set('POST /api/inference/abort', async (request: RouteRequest) => {
    const client = getDsh(ctx)
    const body = (request.body ?? {}) as Record<string, unknown>
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    if (sessionId === '') return { status: 400, body: { error: '缺少 sessionId' } }
    return { body: await client.call('inference.abort', { sessionId }) }
  })

  /** 模型列表。 */
  routes.set('GET /api/models', async () => {
    const client = getDsh(ctx)
    return { body: await client.call('model.list', {}) }
  })

  /** 切换当前模型。写入配置，重启后仍生效。 */
  routes.set('POST /api/models/select', async (request: RouteRequest) => {
    const client = getDsh(ctx)
    const body = (request.body ?? {}) as Record<string, unknown>
    const id = typeof body.id === 'string' ? body.id : ''
    if (id === '') return { status: 400, body: { error: '缺少模型 id' } }
    const result = await client.call('model.select', { id })
    await config.update({ currentModel: id })
    return { body: result }
  })

  /**
   * 读取配置。
   *
   * 密钥在返回前打码：界面只需要知道"填过了"，不需要拿到原文。
   * 原文只在内核发请求时使用，不经过任何返回给前端的路径。
   */
  routes.set('GET /api/config', () => {
    const current = config.read()
    return {
      body: {
        currentModel: current.currentModel,
        permission: current.permission,
        profiles: current.profiles.map((profile) => ({
          id: profile.id,
          label: profile.label,
          baseUrl: profile.baseUrl,
          model: profile.model,
          // 打码而非省略：省略会让界面以为没填，从而显示"未配置"。
          apiKey: profile.apiKey === '' ? '' : `${'•'.repeat(8)}${profile.apiKey.slice(-4)}`,
          hasKey: profile.apiKey !== '',
        })),
      },
    }
  })

  /** 写入供应商配置。整体替换语义。 */
  routes.set('POST /api/config/profiles', async (request: RouteRequest) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const raw = body.profiles
    if (!Array.isArray(raw)) return { status: 400, body: { error: 'profiles 必须是数组' } }

    // 打码后的密钥不能写回去——那会把真实的 key 替换成圆点。
    // 前端若原样回传打码值，说明用户没改密钥，此时沿用已存的原文。
    const existing = config.read().profiles
    const profiles: StoredProfile[] = []
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue
      const profile = item as Record<string, unknown>
      const baseUrl = typeof profile.baseUrl === 'string' ? profile.baseUrl.trim() : ''
      const model = typeof profile.model === 'string' ? profile.model.trim() : ''
      if (baseUrl === '' || model === '') continue
      const id = typeof profile.id === 'string' && profile.id !== '' ? profile.id : model
      const incomingKey = typeof profile.apiKey === 'string' ? profile.apiKey : ''
      const previous = existing.find((candidate) => candidate.id === id)
      const apiKey = incomingKey.includes('•') ? (previous?.apiKey ?? '') : incomingKey
      profiles.push({
        id,
        label: typeof profile.label === 'string' && profile.label.trim() !== '' ? profile.label.trim() : model,
        baseUrl,
        model,
        apiKey,
        ...(typeof profile.contextWindow === 'number' ? { contextWindow: profile.contextWindow } : {}),
      })
    }

    const updated = await config.update({ profiles })
    await syncConfigToKernel(ctx, updated)
    return { body: { ok: true, count: profiles.length } }
  })

  /** 读取/写入权限档位。 */
  routes.set('POST /api/config/permission', async (request: RouteRequest) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const value = body.permission
    if (value !== 'full' && value !== 'workspace' && value !== 'chat') {
      return { status: 400, body: { error: '权限档位不合法' } }
    }
    const updated = await config.update({ permission: value as PermissionLevel })
    return { body: { permission: updated.permission } }
  })

  /** 工具列表。 */
  routes.set('GET /api/tools', async () => {
    const client = getDsh(ctx)
    return { body: await client.call('tool.list', {}) }
  })

  /**
   * 设置全景：全部段 + 用户层。
   *
   * ## 为什么一次全给
   *
   * 1168 个字段的来源是 137 个包里的静态常量，不是数据库查询。
   * 一次返回约 500 KB，比让界面按层、按段发起 122 次请求快得多，
   * 也让「场景层的 13 项」与「原始层的 1168 条」读的是同一份数据——
   * 分两次取就会出现「场景层显示 30、原始层显示 90」的撕裂。
   *
   * ## 为什么带 `active`
   *
   * §6.7 明确：插件停用后，它的设置段必须灰显并注明。宿主是唯一知道
   * 「这一轮到底装了哪些插件」的地方，界面无从推断。
   */
  routes.set('GET /api/settings', () => {
    const snapshot: SettingsSnapshot = {
      sections: [...sections],
      user: settings.read(),
      totals: {
        sections: sections.filter((section) => section.registered).length,
        fields: sections.reduce((sum, section) => sum + section.fields.length, 0),
        unregistered: sections.filter((section) => !section.registered).length,
      },
    }
    return { body: snapshot }
  })

  /**
   * 写一个字段。
   *
   * ## 为什么值是 `undefined` 就删键
   *
   * 请求体里 `value` 缺省 = 删掉用户层对这个键的设置，让它回落到插件默认值。
   * 这是界面「恢复默认」的实现，与「写入 null」不是同一件事：
   * `null` 是显式置空、会覆盖下层（见 O-005 `LayerSet` 的注释）。
   *
   * ## 为什么不在这里校验范围
   *
   * 校验的真源是插件 `FIELD_SPECS` 的 `min/max/pattern`，插件自己在读取时
   * 还要再夹一次（例如 `completeConfig`）。宿主再写一份校验，就出现
   * 第二处真源——插件改了范围而宿主没改时，界面会拒绝一个合法的值。
   * 所以这里只做「键是否存在」的存在性检查，防止把拼错的键写进文件。
   */
  routes.set('POST /api/settings', async (request: RouteRequest) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const section = typeof body.section === 'string' ? body.section : ''
    const key = typeof body.key === 'string' ? body.key : ''
    if (section === '' || key === '') {
      return { status: 400, body: { error: '缺少 section 或 key' } }
    }

    const target = sections.find((item) => item.id === section)
    if (target === undefined) return { status: 404, body: { error: `没有这个配置段：${section}` } }
    if (!target.fields.some((field) => field.key === key)) {
      return { status: 404, body: { error: `段 ${section} 里没有字段 ${key}` } }
    }

    const hasValue = Object.hasOwn(body, 'value')
    await settings.set(section, key, hasValue ? body['value'] : undefined)
    return { body: { ok: true } }
  })

  return routes
}

/**
 * 把配置推给内核。
 *
 * 拆成独立函数是因为有两个调用点（启动时、配置变更后），
 * 而两处必须用完全相同的方式推送——否则会出现"启动时生效、改完不生效"。
 */
async function syncConfigToKernel(ctx: Context, current: { currentModel: string; profiles: StoredProfile[] }): Promise<void> {
  const client = getDsh(ctx)
  try {
    const result = await client.call('model.configure', { profiles: current.profiles }) as {
      models?: Array<{ id: string }>
      current?: string
    }

    // 恢复上次选中的模型。但若那个模型已经不在列表里（被删了、或换了机器），
    // 就用内核回落的默认值，而不是硬塞一个失效 id。
    const available = result.models ?? []
    if (current.currentModel !== '' && available.some((model) => model.id === current.currentModel)) {
      await client.call('model.select', { id: current.currentModel })
    }
  } catch (error) {
    process.stderr.write(`[host] 推送模型配置失败：${String(error)}\n`)
  }
}

/** 取内核客户端。缺服务时给出可行动的报错，而不是 `undefined.call` 崩溃。 */
function getDsh(ctx: Context): {
  call(method: string, params?: unknown): Promise<unknown>
  onEvent(listener: (event: { method: string; params: unknown }) => void): () => void
} {
  const client = (ctx as unknown as Record<string, unknown>)[dshClientPlugin.DSH_SERVICE_KEY]
  if (client === undefined) {
    throw new Error('dsh 内核客户端未装载')
  }
  return client as {
    call(method: string, params?: unknown): Promise<unknown>
    onEvent(listener: (event: { method: string; params: unknown }) => void): () => void
  }
}

/**
 * 解析内核入口路径。
 *
 * 优先读环境变量：打包后目录结构由壳决定，宿主不该硬编码猜测。
 * 回落顺序依次尝试源码态与构建态位置，让开发时不必设环境变量。
 */
function resolveSidecarEntry(): string {
  const fromEnv = process.env.ONDRA_SIDECAR_ENTRY
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv

  const candidates = [
    join(import.meta.dirname, '..', '..', 'dsh-sidecar', 'lib', 'index.js'),
    join(import.meta.dirname, '..', '..', 'dsh-sidecar', 'src', 'index.ts'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  // 找不到时仍返回首选路径：让启动失败的报错指向预期位置，便于定位打包问题。
  return candidates[0] ?? join(import.meta.dirname, 'dsh-sidecar', 'lib', 'index.js')
}

/**
 * 解析 `plugins/` 目录的绝对路径。
 *
 * ## 为什么要试两个位置
 *
 * 宿主有两种运行形态：源码态（`node --experimental-strip-types index.ts`，
 * `import.meta.dirname` 是 `cordis-host/`）与构建态（`node lib/index.js`，
 * 是 `cordis-host/lib/`）。两者的 `plugins/` 都在上一层的同名字目录下。
 *
 * 不读环境变量：这个目录与宿主同属一个包，位置由包结构决定，
 * 不像 sidecar 那样会被壳搬到别处。多一个环境变量就多一处可能配错。
 */
function resolvePluginsRoot(): string {
  const candidates = [
    join(import.meta.dirname, 'plugins'),
    join(import.meta.dirname, '..', 'plugins'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  // 找不到也返回首选路径：扫描会得到空列表，界面显示「没有配置段」，
  // 比让宿主拒绝启动诚实——设置页空着不影响说话。
  return candidates[0] ?? join(import.meta.dirname, 'plugins')
}

/**
 * 创建壳命令通道。
 *
 * 骨架阶段壳还没实现命令端点，这里返回一个明确失败的实现。
 * 正式版会改为通过管道向壳发命令并等待回包。
 */
function createShellInvoker(): (command: string, args?: Record<string, unknown>) => Promise<unknown> {
  return async (command: string): Promise<unknown> => {
    throw new Error(`壳命令通道尚未接通：${command}`)
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? (error.stack ?? message) : message
  process.stderr.write(`[host] 启动失败：${stack}\n`)
  // 完整诊断只写 stderr；发给壳的只有可读消息，避免把本机路径暴露到界面。
  sendToShell({ type: 'fatal', message })
  process.exitCode = 1
})
