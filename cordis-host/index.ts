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
import { readFile } from 'node:fs/promises'
// 插件按包名导入而非相对路径：包名让依赖关系可被 pnpm 与 tsc 的工程引用追踪，
// 相对路径则会绕过 workspace 链接，把插件源码编进宿主产物——那样插件的
// 自身依赖（如 dsh-sidecar）在运行时就解析不到了。
import * as desktopBridgePlugin from '@ondra/cordis-plugin-desktop-bridge'
import * as dshClientPlugin from '@ondra/cordis-plugin-dsh-client'
import { startWebServer, type RouteHandler, type RouteRequest, type StreamEmitter } from './src/server.js'
import { ChannelWebServer } from './src/channel-server.js'
import { installLogExporter } from './src/log-export.js'
import {
  DebugLog,
  UiBridge,
  clearDebugHandshake,
  installDebugRoutes,
  isDebugEnabled,
  writeDebugHandshake,
  type DebugEnvironment,
} from './src/debug.js'
import { ConfigStore, resolveDataDir, type PermissionLevel, type StoredProfile } from './src/config.js'
import { ensureWorkspace, resolveWorkspaceRoot } from './src/workspace.js'
import { SettingsStore, scanSections, type SettingsSection, type SettingsSnapshot } from './src/settings.js'
import { pushSystemLog, readSystemLog, systemLogSize } from './src/system-log.js'
import { readPluginSwitches, scanPlugins, writePluginSwitches, type PluginRow, type PluginSwitches } from './src/plugins.js'
import {
  checkProactive,
  declineProactive,
  gapEligibleFor,
  nudgeFor,
  takeReason,
  type DriveGapLike,
  type GateLike,
  type QuotaLike,
  type ReasonLike,
} from './src/proactive.js'
import { assembleSystemPrompt } from './src/system-prompt.js'
import { ContextRegistry, SYSTEM_PROMPT_SERVICE_KEY } from './src/prompt-context.js'
import { publishTurn } from './src/turn-events.js'
import { provideKernelLlm, sourcesFromProfiles } from './src/llm-runtime.js'
import { boundaryKeyOf, diffuseAcrossSessions, type DiffuseOutcome } from './src/diffuse.js'
import { recordTurn, relationProbe } from './src/relation.js'
import { evolveProbe, syncEvolveInteractions } from './src/evolve.js'
import { projectionProbe } from './src/emotion.js'
import { dreamProbe, runDream } from './src/dream.js'
import { snapshotProbe, verifySnapshot } from './src/snapshot.js'
import { resetVoiceGate, speakReply, voiceProbe } from './src/voice.js'
import { beginOralSession, oralProbe, shapeReply } from './src/oral.js'
import { pause, planFirstWord, planPieces, presenceOf, rhythmProbe } from './src/rhythm.js'
import { filterProbe, filterReply } from './src/filter.js'

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

/**
 * 读产品版本号。
 *
 * 不硬编码：版本由 `package.json` 一处决定，四份清单（根包、宿主、内核、
 * Tauri）已经靠一键脚本同步过，再抄一遍就多了一个会漂的地方。
 *
 * 读不到时返回「未知」而不是抛错：版本号只用于显示与诊断，
 * 不该让整个宿主因为少一个数字而起不来。
 */
async function readPackageVersion(): Promise<string> {
  try {
    // 源码态 index.ts 在 cordis-host/，构建态 lib/index.js 也在 cordis-host/ 下一层，
    // 所以 `..` 在两种情况下都指向 cordis-host/，package.json 始终在这个位置。
    const raw = await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    const value = typeof parsed === 'object' && parsed !== null ? (parsed as { version?: unknown }).version : undefined
    return typeof value === 'string' && value !== '' ? value : '未知'
  } catch {
    return '未知'
  }
}

async function main(): Promise<void> {
  // 进程起始时刻。`ondra status` 用它算运行时长——排查「宿主是不是偷偷重启过」
  // 时，这个数比日志里翻十页更快给出答案。
  const startedAt = Date.now()
  const ctx = new Context()
  // baseUrl 影响插件的相对路径解析。指向宿主根目录，让插件内的资源路径
  // 相对于 cordis-host/ 而不是当前工作目录——后者取决于用户从哪里启动。
  ctx.baseUrl = new URL(`file://${join(import.meta.dirname, '..')}/`).href

  /*
   * --- 系统提示词的运行时上下文出入口 -------------------------------------
   *
   * **必须在 `loadCore` 之前 provide。**
   *
   * `ondra-prompt-inject` 在 `apply()` 里第一件事就是 `ctx.get('systemPrompt')`：
   * 拿到就当场挂进提示词，拿不到才走 `ctx.inject(['systemPrompt'], …)` 等它。
   * 两条路本都该通，但「等它」那条路在**装载期**只注册一个回调，而宿主此前
   * 从不 provide，于是它一辈子等不到——这正是那句
   * 「注入装箱已就绪但无人阅读」的来源，也是她从来不提记忆里任何事的原因。
   *
   * 放在这里（而不是稍后）还有一个好处：装载期就可见，插件会走「拿到即挂」
   * 那条直路，装配链少一层异步等待，也少一个「究竟挂上了没有」的不确定态。
   */
  const promptContext = new ContextRegistry()
  ctx.effect(
    () => ctx.provide(SYSTEM_PROMPT_SERVICE_KEY, promptContext),
    '宿主: 注册系统提示词上下文',
  )

  /*
   * --- 通道回调的接入面（`webServer`）---------------------------------------
   *
   * **同样必须在 `loadCore` 之前 provide。**
   *
   * 8 条对外通道里 4 条是回调式（钉钉 / 飞书 / 微信公众号 / 企业微信），
   * 它们的 `apply()` 第一件事就是 `ctx.get('webServer')`，取不到就打一句
   * `log.error('没有 webServer：这个通道完全收不到消息')` 然后什么都不挂。
   * 宿主此前**从未 provide 过这个服务**，于是这 4 条通道哪怕装上也只会
   * 静默收不到消息——本轮补的就是这块地基。
   *
   * 注册表与服务器共用同一个实例：`register()` 只往表里加一条，
   * 真正的分发发生在 `startWebServer` 的 `handle()` 里（见 `src/channel-server.ts`）。
   */
  const channelWebServer = new ChannelWebServer()
  ctx.effect(
    () => ctx.provide('webServer', channelWebServer),
    '宿主: 注册通道回调接入面',
  )

  // --- 0. 数据与配置 ---------------------------------------------------------
  const dataDir = resolveDataDir()
  /*
   * 把 cordis 的日志接到磁盘上。
   *
   * **必须在 `loadCore` 之前。** 插件在 `apply()` 里打的每一句「凭据没齐」
   * 「没有 webServer」「配置条目已丢弃」都发生在装载期；导出器晚一步挂上，
   * 恰好漏掉最该看的那一段。
   *
   * 为什么这件事此前一直缺：`@ntars/cordis` 的 `LoggerService` 只自带一个
   * **内存环形缓冲**导出器（上限 1000 条，进程退出即消失），而宿主从未
   * `ctx.logger.exporter(...)`。于是 135 个插件的全部 info/warn/error 都被
   * 静默丢掉，「插件为什么不工作」在产品里没有任何一处能回答。
   * 详细理由写在 `src/log-export.ts` 的文件头。
   */
  const debugEnabledEarly = isDebugEnabled(dataDir)
  const hostLog = new DebugLog(dataDir)
  if (debugEnabledEarly) await hostLog.load()
  installLogExporter(ctx, hostLog, { includeDebug: debugEnabledEarly })
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

  /*
   * --- 2.5 模型运行时（`ctx.llm`）-------------------------------------------
   *
   * 必须**早于** `loadCore`：`ondra-llm-gateway` 在 `apply()` 里就构造服务，
   * 并在构造期算一次来源状态。服务晚到，网关那一轮探测就把所有来源判成
   * `gateway-unavailable`——而它只在「有来源不可用」时才重算，等下次调用
   * 才可能自愈，中间那几轮提炼全是 `no-gateway`。
   *
   * 补的是整条记忆提炼链的最上游一环：`ctx.get('llm')` 此前**全仓零注册方**
   * （见 `src/llm-runtime.ts` 的文件头）。
   */
  provideKernelLlm(
    ctx,
    () => {
      const client = (ctx as unknown as Record<string, unknown>)[dshClientPlugin.DSH_SERVICE_KEY]
      return client as { call(method: string, params?: unknown): Promise<unknown> } | undefined
    },
    // 每次调用时现读配置：供应商清单是运行时可变的，缓存一份快照必然漂。
    // 取的是**供应商 id**——内核用它在 `profiles` 里查「用哪条配置」。
    () => config.read().profiles.map((profile) => profile.id).filter((id) => id !== ''),
  )

  // --- 3. 空谷核心（装入包内，默认全部禁用） ---------------------------------
  // 134 个迁入插件随包分发，但默认一个都不装载：它们属于旧项目那套 dsh 功能
  // （情绪、记忆、人设、各类 IM 适配器），当前界面一个都没接。
  //
  // 「装着不用」而不是「不打包」是有意的：这些是产品的一部分，
  // 将来接通某个能力时把 id 加进 ONDRA_CORE_ENABLE 就能启用，不必重做打包流程。
  const corePlugin = await import('@ondra/cordis-plugin-ondra-core')
  /*
   * 默认启用名单。
   *
   * `ondra-proactive-gate`：它**不是**「打开一个功能」，而是「把界面已经
   * 依赖的那份判据接上」：§7.4 的打扰预算、§12.10 的「她主动开口」都写着
   * 「由 proactive-gate 判定」。
   *
   * `ondra-proactive-quota`：节律（档位额度、最小间隔、性格化沉默、退场句）。
   * 之前没装的理由是「它读记忆与执念池」，**这个理由已被实测推翻**：
   * quota 只经 `gate.peek()` 读今日已发数，不碰记忆；记忆缺席时它退化成
   * 「按档位算额度」，`plan()` 依然返回 `send / ok`，正是设置页那三档
   * （偶尔 / 正常 / 主动）背后需要的真源。不装它，「她多主动」这个滑杆
   * 拨到哪一档都没人执行。
   *
   * 以下四个是本轮新增的「话由链」，缺一环整条链就空转：
   *
   * | 成员 | 补的是哪一环 |
   * | --- | --- |
   * | `ondra-path-layout` | **数据根**。`ondra-store-sqlite` 的 `path` 默认为空，空时必须向它要路径；它是唯一知道「库该放哪儿」的人 |
   * | `ondra-store-sqlite` | 22 个业务插件在 `apply` 里同步取存储端口，没有它全部降级成内存态 |
   * | `ondra-memory-core` | 承诺要写记忆（`category=promise`），缺它 `remember()` 抛 `no-core`，承诺降级成待办 |
   * | `ondra-memory-prospective` | 承诺表 + 待办表 + 正则抽取 + 到期算术，是「话由」本体的来源 |
   * | `ondra-drive-gap` | 缺口池（执念）。它是话由表里**优先级最高**的一类——「她自己在惦记什么」 |
   * | `ondra-proactive-reason` | 把上面那张表翻成「此刻该说什么由头」，缺它门控只能给一句通用描述 |
   *
   * `ondra-memory-intake` 不在此列：它在「设置 → 记忆」里由用户开关控制，
   * 但**没有它，承诺与待办就没人写**（`detect()` / `addTodo()` 在全仓曾
   * 零调用方）。故一并默认启用——它做的只是把用户交代的话捡进表，
   * 与「她的记忆要不要开」是两件事：待办按设计根本不进记忆链。
   *
   * 用户在环境变量里写的名单会**追加**在默认项之后，不被覆盖。
   */
  const DEFAULT_CORE_ENABLE = [
    /*
     * 三个**纯基础设施**包。它们不是「又一个功能」，而是别人已经在用的地基——
     * 此前三个全不在名单里，于是 46 处 `ctx.get` 恒定拿到 `undefined`，
     * 而每一处都写好了「取不到就降级」的路径，**一处都不会报错**。
     *
     * | 包 | 已装消费方 | 缺席时的真实症状 |
     * | --- | --- | --- |
     * | `ondra-identity` | 22 个 | 日志命名空间全退成硬编码字符串；`strictKeys`、产品名、pidfile 名的唯一真源不存在 |
     * | `ondra-config-schema` | 20 个 | 每个插件只能读自己的实例配置，四层合并（factory→bundle→user→runtime）整条不发生 |
     * | `ondra-clock` | 4 个 | 缺口池 / 承诺 / 主动节律各自退回 `Date.now()`，跨时区与「自然日」结算没有统一口径 |
     *
     * 判据来自本轮的一次静态普查（数每个包里 `ctx.get('键')` 的命中数），
     * 不是凭印象：**「谁声明了依赖它」比「它听起来重不重要」可靠**。
     *
     * 三包都零依赖、只 `ctx.provide`、不装定时器（clock 的定时器挂在
     * `ctx.effect` 生命周期上，卸载即清），因此可以放心排在链最前。
     */
    'ondra-identity',
    'ondra-config-schema',
    'ondra-clock',
    'ondra-path-layout',
    'ondra-store-sqlite',
    /*
     * `ondra-store-memory`：**不是功能，是存储域的兜底端口**。
     *
     * 它此前不在名单里，而 21 处消费方写的是
     * `ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')`——
     * 那个 `??` 的右半边从来取不到东西。SQLite 一切正常时看不出差别，
     * 一旦库打不开（文件损坏、卷不支持共享内存、Node 缺 `node:sqlite`），
     * 记忆域 / 情绪域 / 人格域会**同时**拿到 `undefined`。而 `ondra-memory-core`
     * 用 `ctx.inject([...])` 等存储端口，等不到就整包不起，于是症状是
     * 「她失忆了，而且什么都不说」，日志里一行错都没有。
     *
     * ## 装上它不是「多开一个功能」
     *
     * 插件自己的 `apply()` 写得很清楚：**即使 SQLite 已在位也照常注册**，
     * 只在日志里说一句「本后端仅作备用，不会被选中」。选谁由消费方的
     * `??` 顺序决定，SQLite 永远优先。所以代价是一个空对象加一行日志，
     * 换掉的是「存储域单点全塌」。
     *
     * ## 为什么它之前被漏掉
     *
     * 因为它**没有设置字段**（`settings.ts` 不存在），在设置面板里不存在，
     * 于是「按清单核对设置段」这条老办法看不见它。而它的出厂 `enabled`
     * 明明是 `true`——用户若在别处看到「内存兜底：开」，那个开关背后
     * 从来没有人。
     */
    'ondra-store-memory',
    /*
     * `ondra-llm-gateway`：**模型网关**，事实提炼与做梦的唯一模型入口。
     *
     * 它此前不在名单里，于是三处静默失效叠在一起：
     *
     * | 缺的环 | 症状 |
     * | --- | --- |
     * | 网关没装载 | 提炼器 `ctx.get('ondra-llm-gateway')` 恒 undefined → `no-gateway` |
     * | `ctx.get('llm')` 全仓零注册 | 即便装上，网关 `available` 恒 false → `gateway-unavailable` |
     * | `sources` 默认空数组 | 即便上两层都通，仍 `no-source` |
     *
     * 三处都不报错（各自都是设计好的降级路径），合起来的唯一表现是
     * **`memory_fact` 从建库起一直 0 行**，而 `memory_raw` 有数。
     */
    'ondra-llm-gateway',
    'ondra-memory-core',
    'ondra-memory-prospective',
    'ondra-memory-intake',
    /*
     * `ondra-memory-dedupe`：**写入前的判重裁决**。
     *
     * 不装它的症状是本仓第十次踩的同一个形态——不是报错，而是**数据悄悄变形**：
     * `intake` 走 `extract()` 直写，而 `extract()` 是纯追加语义。
     * 用户把「搭档叫阿岚」说了三遍，库里就有三条。三条都合法、都能召回，
     * 右栏看起来「记得挺多」，只有把 `times_said` 与正文拿出来对，才看得出
     * 其实是同一件事被记了三份。
     *
     * ## 它与 `intake` 是**一对**，单独装任一个都等于没装
     *
     * | 只装 dedupe | 服务注册了，但 `propose()` / `settle()` 仍零调用方——空转 |
     * | 只装 intake | 走 `extract()` 直写，判重服务取不到，重复照旧 |
     *
     * 所以本轮同时在 `ondra-memory-intake` 里接上写入路径（有判重走
     * `propose()` + `settle()`，没有就退回 `extract()`），并把本包放进名单。
     *
     * ## 为什么它不改变「记住什么」，只改变「记几遍」
     *
     * `settle()` 的五分类里只有 `add` / `conflict`（`seal-old` 策略下）会新增行；
     * `merge` 改主条（`revise()` 保留旧正文在 `oldText`，可回溯）、
     * `append` / `drop` 只加固 `timesSaid`。**没有一条路径调 `forget()`**——
     * 墓碑的语义是「用户要求忘记」，把合并误写成遗忘，那条信息以后永远写不回来。
     */
    'ondra-memory-dedupe',
    /*
     * `ondra-memory-extract`：**事实提炼器**。
     *
     * 不装它的症状极其安静：`memory_raw` 照常有数（原文落盘不走提炼），
     * 而 `memory_fact` 从建库起一直 0 行。`intake` 走到「2. 提炼」那一步时
     * 取不到服务，只打一行 `提炼不可用（原文已保留）：no-service` 的 warn，
     * 然后正常返回。
     *
     * 于是她记得「有过这段对话」，却永远说不出「你叫什么、住哪儿」——
     * 而这正是记忆功能对用户可见的全部价值。
     */
    'ondra-memory-extract',
    /*
     * `ondra-memory-pool`：**记忆八池**，即「这条事实属于哪一类」。
     *
     * 它与下一个 `ondra-prompt-inject` 是**同一条链的两侧**，必须一起装：
     *
     * | 缺哪侧 | 症状 |
     * | --- | --- |
     * | 缺 pool | `intake` 归池那一步取不到服务直接 return，事实全部落海马体并置 `unclassified`，而海马体按设计**永不注入** |
     * | 缺 inject | 归池照常、池表有数，但**没有任何人读它**，她依旧什么都不提 |
     *
     * 两侧都缺的时候症状完全相同（她从不提记忆），所以两边必须一起进名单，
     * 否则只是把「空跑」挪了个位置。
     *
     * 依赖已满足：它只用 `ondra-store-sqlite`（已装）与 `ondra-memory-core`
     * 作为**软依赖**（缺席时只退时间轴，分类照常）。
     */
    'ondra-memory-pool',
    /*
     * `ondra-prompt-inject`：**注入装箱**，把八块记忆渲染成系统提示词的一段。
     *
     * 它此前即使装上也是空转：宿主从未 provide `systemPrompt` 键，于是它永远
     * 停在「等它出现」那条路上（见 `src/prompt-context.ts` 文件头）。本轮
     * 宿主补上了这个位置，它才第一次真的把记忆送进提示词。
     *
     * 八个依赖里六个可选（`recall` / `humanlike` / `decay` / `audit` 缺席即
     * 少一块），必需的两个——`ondra-memory-core` 与 `ondra-memory-pool`——
     * 都在上面。`systemPrompt` 由宿主提供。
     */
    'ondra-prompt-inject',
    'ondra-drive-gap',
    'ondra-proactive-gate',
    'ondra-proactive-quota',
    'ondra-proactive-reason',
    /*
     * 人格链三个成员。缺一环，`assembleSystemPrompt()` 就只剩一句
     * 「人格：装配不可用」，模型收到的 system 为空——表现是她说话毫无人设，
     * 而界面上一切正常，没有任何报错。
     *
     * | 成员 | 补的是哪一环 |
     * | --- | --- |
     * | `ondra-persona-loader` | **人设包**。`persona-core` 拿不到它就报 `no-loader`，`available` 恒 false |
     * | `ondra-persona-core` | 六槽位解析 + 边界条目，是四段里「内核 / 关系微调 / 边界」的来源 |
     * | `ondra-persona-vars` | 变量替换 + 浓度段。缺席不致命（照常拼内核与边界），但「浓度」段会永久缺失 |
     * | `ondra-persona-assemble` | 四段拼装与预算裁剪，是系统提示词的第一段 |
     *
     * 器官宿主 `ondra-organ-host` 不需要单独启用：它是「器官」的容器，
     * 当前没有任何器官注册，`prompt()` 恒空。等第一个器官落地时再加，
     * 现在装了也只是多一份空跑。装配侧已按「空产不算缺项」处理。
     */
    'ondra-persona-loader',
    'ondra-persona-core',
    'ondra-persona-vars',
    'ondra-persona-assemble',
    /*
     * `ondra-persona-evolve`：**人格演化的账本**。
     *
     * 它的漂移公式、三层夹紧、可回滚日志、三张表全都写完了，README 连
     * 「以前 60 就算开心，后来要 80」的手感表都列好了。缺的是四样东西，
     * 而四样全都不报错：
     *
     * | 缺的 | 症状 |
     * | --- | --- |
     * | 不在本名单 | 服务不注册，宿主 `ctx.get` 恒 undefined |
     * | `noteInteraction()` 零调用方 | `interactions` 恒 0，系数恒 ×1.00 |
     * | `thresholdOf()` 零调用方 | 算得出，没人问 |
     * | `personaState()` 零调用方 | 特质分不影响提示词 |
     *
     * 而 `×1.00` 是合法系数、`0` 是合法互动数，所以症状是
     * **「她永远像第一天认识你」**——本仓第八次踩同一个形态。
     *
     * ## 依赖 `ondra-emotion-stage`，但不自己计数
     *
     * 互动次数的唯一真源是关系插件的 `touch()`（每轮 +1 且落盘）。
     * 宿主 `src/evolve.ts` 的 `syncEvolveInteractions()` 只做**差额对齐**：
     * 真源是多少就把镜像补到多少。若这里也每轮 +1，两处从不同起点各自累加
     * 必然漂开，那时「阈值该按哪个数算」没有答案——那才是真正的第二真源。
     *
     * 它在 `after` 里不声明 `ondra-emotion-stage`：真源是用延迟取值读的
     * （`ctx.get` 在调用时发生，不在 `apply` 时），缺席只让本轮对齐跳过。
     */
    'ondra-persona-evolve',
    /*
     * 情绪链两个成员：`core` 持有状态，`express` 把它翻成六态。
     *
     * ## 为什么现在才装（此前 `proactive-reason` 的 `sources.emotion` 恒 false）
     *
     * 话由表里有四类：执念 / 承诺 / 待办 / **情绪偏离**。前三类早通了，
     * 第四类一直是空的——因为 `ondra-proactive-reason` 与 `ondra-emotion-express`
     * 都是「软依赖 + 取不到就降级」，两边都不报错：reason 少一类由头，
     * express 根本没装载。**只有去读 `plan().sources` 才看得见那个 false。**
     *
     * ## 为什么只装这三个，不把八个全装上
     *
     * 情绪域有 8 个包，但对外真有消费方的是这四个（`stage` 除外的其余
     * 四个 `ctx.get` 命中数为 0）。装没有消费者的插件不会让功能变好，
     * 只会让启动日志更长、出错面更大。`ondra-emotion-stage` 有 5 个消费方
     * （`filter-chain` / `grow` / `trust-dashboard`），但那三个本身还没进默认
     * 名单，等它们进来时再一并装——**先装有人用的，不预先铺满**。
     *
     * `ondra-emotion-diffuse` 是 2026-11-08 第二十五段补进来的第三个：
     * 它在整仓唯一的消费方是**宿主自己**（`src/diffuse.ts`），不在插件之间。
     * 这也正是它被漏掉五轮的原因——插件之间的 `ctx.get` 计数是 0，
     * 而「宿主有没有调它」这件事没有任何静态手段看得出来。
     *
     * ## 这两个都是「没有存储也要能跑」的设计
     *
     * `emotion-core` 在无存储时退回纯内存（`reason='no-store'`）而不是停服；
     * `emotion-express` 在无情绪服务时按出厂基线判「平静」（`source='baseline'`）。
     * 所以即使存储出问题，本名单也不会让宿主起不来。
     *
     * 注意：这两个模块此前因 `dynamic` 列的默认值写法错误而**建表失败**，
     * 一直静默跑在内存态（`reason='schema-failed'`）——服务在、六态照常判、
     * 只是重启丢状态。本轮已修（见 `ondra-emotion-core/src/store.ts`）。
     */
    'ondra-emotion-core',
    'ondra-emotion-express',
    /*
     * `ondra-emotion-diffuse`：**跨会话的情绪弥散**。
     *
     * 它的全套代码早就写完了——公式、幂等闸、间隔闸、单行标记表、文档里的
     * 参数总表与三个边界情形，一样不缺。缺的是两样东西，而两样都不报错：
     *
     * | 缺的 | 症状 |
     * | --- | --- |
     * | 不在本名单 | 服务不注册，宿主 `ctx.get` 恒 undefined |
     * | `claim()` 零调用方 | 即便装上，心情也跨不过会话边界 |
     *
     * 于是「换一场会话，上一场剩下的心情还剩多少」这件事从来没有发生过。
     * 用户能感知到的只有一句话：**她每次都像刚开完一场没断过的对话**——
     * 隔了一夜回来，情绪还是昨晚那个调子。
     *
     * 它不写情绪（`applied` 是字面量 `false`，接口上刻意没有 `setAxis`），
     * 落笔归宿主的 `src/diffuse.ts`。这个分界不能挪：插件只算，宿主只写。
     */
    'ondra-emotion-diffuse',
    'ondra-emotion-project',
    /*
     * `ondra-emotion-project`：**情绪的唯一文本出口**。
     *
     * 它的六态模板、四条护栏词表、四道拒绝闸、配置段、启动自检全都写完了，
     * 缺的是四样东西，而四样全都不报错：
     *
     * | 缺的 | 症状 |
     * | --- | --- |
     * | 不在本名单 | 服务不注册，宿主 `ctx.get` 恒 undefined |
     * | `project()` 零调用方 | 模板写好了，没人问 |
     * | 投影文本没有消费者 | 系统提示词只有人格 + 器官片段，没有一句关于「今天怎么开口」 |
     * | `constraint` 没有消费者 | §4.4 的限定句从未进过提示词 |
     *
     * 于是她永远用同一种语气说话——而「这一轮没有情绪块」与「她本来就不该有」
     * 症状完全相同（提示词里都缺那一段），所以不会有任何一处报错。
     * 本仓第九次踩同一个形态，落笔在宿主的 `src/emotion.ts`。
     *
     * ## 为什么它与 `-express` 必须都在
     *
     * `-express` 出**参数**（句形 / 语速 / 额度），本插件出**一段话**。
     * 两段行为指令同时进提示词会互相打架——模型会各听一半。
     * 所以 `-express` 的 README 明写「只出参数不出文本」，文本只在本插件出。
     * 缺 `-express` 时本插件照常注册，`project()` 返回 `no-state`（这是设计好的降级）。
     */
    /*
     * `ondra-emotion-stage`：**关系七阶 + 关系三维的底座**。
     *
     * 它此前被排除在名单外，理由是「有 5 个消费方，但那 5 个（`filter-chain` /
     * `grow` / `trust-dashboard`）本身还没进名单，等它们进来再一并装」。
     * 这个理由只看到了**插件之间**的消费方，漏掉了**宿主自己**——宿主新接的
     * 两条链都以它为前提：
     *
     * | 宿主侧消费方 | 缺了 `stage` 的症状 |
     * | --- | --- |
     * | `src/diffuse.ts` 的 `familiarityOf()` | 弥散公式里 `(1 − familiarity × 0.5)` 恒等于 1，整段白写 |
     * | `src/relation.ts` 的 `recordTurn()` | `interactions` 恒 0、七阶恒停敌意 |
     *
     * 而这两处的**表象都是「什么都没发生」**：心情照常弥散（只是比例永远是
     * 陌生人那档）、关系照常读得出来（只是永远显示「敌意」）。0 是合法值，
     * 所以不会有任何一处报错——本仓第七次踩同一个形态。
     *
     * 它与 `-diffuse` 同一条教训：**「插件之间的 `ctx.get` 计数」看不见
     * 「宿主有没有用它」**。往后再判一个插件该不该默认装，必须连宿主一起数。
     */
    'ondra-emotion-stage',
    /*
     * `ondra-prompt-inject` 的四个可选块提供方。
     *
     * 它们的服务键早就在 `prompt-inject` 的八个 `ctx.get` 里读着，缺一个就少一块，
     * 而**缺的那一块不会报错**——注入照样渲染，只是系统提示词里少一个标题。
     * 于是「她记不住朋友」与「她没有那个功能」在界面上完全同形。
     *
     * | 包 | 补的是哪一块 | 缺了之后的可见症状 |
     * | --- | --- | --- |
     * | `ondra-memory-recall` | ③【我认识的人】、⑤【这会儿想起来的】 | 想不起「你之前提过的那位同事」 |
     * | `ondra-memory-audit` | ①【不能忘的】 | 用户钉住的记忆没有出口，钉了等于没钉 |
     * | `ondra-memory-humanlike` | ⑦【顺着话头想起来的】 | 永远不会「顺口想起一件相关的小事」 |
     * | `ondra-memory-decay` | ① 与 ⑦ 的清晰度话术 | 说起旧事时永远用同一种确定语气 |
     *
     * 判据同样来自数 `ctx.get`：这四个键在 `prompt-inject` 里各有一处读取，
     * 而此前四个全不在名单里——`prompt-inject` 已装、服务却是 `undefined`。
     *
     * 四个的硬依赖都只有 `ondra-memory-core`（已在上面）；`graph` / `vector` /
     * `recognition` 是软依赖，缺席时各自降级（召回退纯字面、审计不清孤儿边、
     * 衰减只借话术不自算阈值）。`decay` 与 `audit` 还要 `ondra-store-sqlite`，
     * 也已在最前面。
     */
    'ondra-memory-recall',
    'ondra-memory-decay',
    'ondra-memory-humanlike',
    'ondra-memory-audit',
    /*
     * `ondra-memory-recall` 的三条外部通道：图谱、向量、识别。
     *
     * 召回自带的只有两条（罕见词、二元组 BM25）。另外三条**服务键早就写死在
     * 它的 `ctx.get` 里**，缺席时各降一档、都不报错：
     *
     * | 通道 | 缺席时的表现 | 判据 |
     * | --- | --- | --- |
     * | 图谱 | 五因子分母从 1.00 降到 0.89，图谱因子整项退出 | `plan().channels` 里 `graph: absent` |
     * | 向量 | 语义因子退出归一化，只剩字面 | `channels` 里 `vector: absent` |
     * | 识别 | 「同主题零共同词」永远认不出来 | `channels` 里 `recognition: absent` |
     *
     * 三条都不报错、`available` 都是 true，所以「她认不出同义说法」与
     * 「这个功能本来就没有」在界面上完全同形。**只能靠读通道表才看得见。**
     *
     * ## 图谱为什么还要宿主补一步
     *
     * 装 `ondra-memory-graph` 只解决「容器在不在」。它的四类边里，
     * `same_topic` 按设计归 O-011 提炼 / O-012 判重建，`surreal` 归 O-019 做梦建，
     * 而**这两处全仓都没有实现**——`link()` 的唯一调用方是做梦插件的荒诞分支。
     * 于是只装容器的话，边表永远是 0 行、`relatedness()` 永远返回空，
     * 图谱因子看起来「接上了」，实际一条边都没有。
     *
     * 补的是 `cooccur`（共现）这一类：**同一轮对话里提炼出来的两条事实**
     * 就是「她真的见过它们一起出现」的最小证据。落笔在
     * `ondra-memory-intake` 的 `linkCooccur()`（`plugins/ondra-memory-intake/src/index.ts`）——
     * 它手上正有「这一轮落库了哪几条 id」，而图谱插件拿不到这个视角。
     *
     * （这段注释原先写的是「落笔在宿主的 `src/memory-links.ts`」，那个文件从来没有
     * 存在过；实现一直在 intake 里。注释指错地方，比没有注释更费时间。）
     *
     * ## 向量默认是关的，这不是漏配
     *
     * `ondra-memory-vector` 出厂 `enabled: false`（台账第 16 组：倒排才是默认分支）。
     * 装进来但不点开，用户能在设置页看到这一段、能自己打开——这比「包里没有」
     * 多一条选择，也比「默认打开」少一份成本。`recognition` 则是纯本地同步查询，
     * 装上就有、无外部成本，出厂即开。
     */
    'ondra-memory-graph',
    'ondra-memory-vector',
    'ondra-memory-recognition',
    /*
     * `ondra-memory-heal`：**记忆库体检 + 可核对修复**。
     *
     * 它的七类问题判定、三档修复、二次确认闸全都写完了，缺的是两样东西，
     * 而两样都不报错：
     *
     * | 缺的 | 症状 |
     * | --- | --- |
     * | 不在本名单 | 服务不注册，`config memory-heal` 恒标「插件已停用」 |
     * | `diagnose()` 零调用方 | 即便装上，巡检从不发生，`stats()` 恒全零 |
     *
     * 第二行是本轮真正要修的断裂。只把 id 加进名单是**最坏的做法**：
     * 配置段本来就在（`scanSections` 不要求已装载），于是「装没装」
     * 这件事在配置列表里完全看不出来，看起来像「已经好了」。
     *
     * ## 为什么它此前被漏掉
     *
     * `ctx.get('ondra-memory-heal')` 全仓命中数为 0——**没有任何插件消费它**，
     * 静态普查据此判「装它没有真实收益」。这个判据漏掉了宿主自己：
     * 体检的读者是人（设置 → 记忆库 → 体检），不是另一个插件。
     * 与 `ondra-emotion-diffuse` 是同一类漏判（那条教训写在它上面那段注释里）。
     *
     * ## 三项依赖全是软依赖，故它不会让宿主起不来
     *
     * | 缺席 | 表现 |
     * | --- | --- |
     * | `ondra-memory-core` | `available=false` / `reason='no-core'`，体检面板显示「记忆内核没接上」 |
     * | `ondra-memory-audit` | 少查三类（悬空钉子 / 待曝光幽灵 / 钉子偏多），在 `missing` 里点名 |
     * | `ondra-memory-dedupe` | 少查疑似重复（这一类只报告不修） |
     *
     * 三者都已在上面，所以装载即全功能。
     */
    'ondra-memory-heal',
    /*
     * `ondra-memory-dream`：**做梦与睡眠巩固**。
     *
     * 三支互斥分支（闸式 / 轻量 / 荒诞）的代码全写完了——四道闸、五类卡片
     * 的纯规则挖掘、荒诞边的「同实体」近似、三张表、记账、读回校验，
     * 连「为什么不做重写摘要」的边界都写在文件头。缺的是两样，两样都不报错：
     *
     * | 缺的 | 症状 |
     * | --- | --- |
     * | 不在本名单 | 服务不注册，`config memory-dream` 恒标「插件已停用」 |
     * | `run()` 零调用方 | 即便装上，一场梦都不会发生，`dream_log` 恒 0 行 |
     *
     * 第二行是本轮真正要修的断裂。只把 id 加进来是**最坏的做法**：
     * 配置段本来就在（`scanSections` 不要求已装载），于是「装没装」
     * 在配置列表里完全看不出来，读起来像「已经好了」。与上一轮
     * `ondra-memory-heal` 是同一形态，也是同一个教训。
     *
     * ## 为什么它此前被漏掉
     *
     * `ctx.get('ondra-memory-dream')` 全仓命中数为 0——没有任何插件消费它。
     * 静态普查据此判「装它没有收益」，而这个判据漏掉了宿主自己：做梦的
     * 读者是人（设置 → 记忆 → 做梦），不是另一个插件。第三次同族漏判
     * （前两次是 `ondra-emotion-diffuse` 与 `ondra-memory-heal`）。
     *
     * ## 五道依赖里四道是软的，故它不会让宿主起不来
     *
     * | 缺席 | 表现 |
     * | --- | --- |
     * | `ondra-memory-core` | `available=false` / `reason='no-core'` |
     * | `ondra-llm-gateway` | `mode=gate` 不可用（`no-model`），切轻量分支照跑 |
     * | `ondra-memory-dedupe` | 重复拒降级为「同批去重 + 墓碑」，`dedupeGate='local'` |
     * | `ondra-snapshot` | `report.backup='skipped'`，做梦前不备份 |
     * | `ondra-memory-graph` | 荒诞分支建不了边，梦话照常 |
     *
     * 前两个与前四个都已在上面。`ondra-snapshot` 曾缺席，于是备份那一格
     * 恒为 `skipped`——不是缺陷，是「没装就不假装备份过」。本轮它已装载，
     * 所以 `dream` 的 `after` 里也补上了它，备份那格应当第一次变成 `created`。
     */
    'ondra-memory-dream',
    /*
     * `ondra-snapshot`：**记忆快照**（`VACUUM INTO`），手册 §9.7「三道保险」的第一条。
     *
     * 它不需要新写消费方——**五个已有调用方早就在等它**：
     *
     * | 调用方 | 缺席时的表现 |
     * | --- | --- |
     * | `ondra-memory-dream` | `report.backup='skipped'`，做梦前不备份 |
     * | `ondra-forget-right` | `absent` 里多一条「快照（本来就只读）」 |
     * | `ondra-memory-git` | 少一条「真备份由 O-009 做」的路径 |
     * | `ondra-market` | 还原点建不起来 |
     * | 宿主 `src/dream.ts` | 这句注释本身就是证据：上一轮刚记下「恒 `skipped`」 |
     *
     * 所以它是本轮候选里**唯一装完立刻会改变已有行为**的一个：
     * 做梦那格从 `skipped` 变成 `created`，不需要改任何一行调用处。
     *
     * ## 为什么它没有配置段不算缺陷
     *
     * 配置项（`keep` / `verifyAfterCreate` / `snapshotBeforeMigration` /
     * `minIntervalMs`）写在 `index.ts` 里并带默认值，但**没有 `src/settings.ts`**。
     * `scanSections` 只认 `lib/settings.js`，于是 `config snapshot` 读不到这一段。
     *
     * 这不是本插件独有：`ondra-identity` / `ondra-config-schema` / `ondra-clock` /
     * `ondra-path-layout` / `ondra-store-sqlite` / `ondra-memory-vector` 六个
     * **已在名单里**的基础设施包同样没有配置段。它们属于「默认值即最佳值、
     * 不该让用户调」的那一类，与「有配置段却没接上」是两回事。
     *
     * 验收时这一条要按此口径判：**装载计数 +1、五个调用方行为改变、
     * 界面能看到快照清单**，而不是「`config snapshot` 能读到字段」。
     *
     * ## `after` 必须写全它 `apply()` 里同步取的三个
     *
     * `apply` 里 `ctx.get('ondra-store-sqlite')`、`ctx.get('ondra-path-layout')`、
     * `ctx.get('ondra-identity')` 全是**同步取值**。少写一个，
     * `SnapshotStore` 构造时就拿到 `undefined` 并把 `available` 定死——
     * 那正是上一轮 `dream` 的 `graphAvailable=false` 踩过的坑。
     *
     * `ondra-data-migrate` **不**进 `after`：它没装载，而插件自己用
     * `ctx.inject(['ondra-data-migrate'], …)` 做了延迟挂载（缺席时子 fiber 不跑，
     * 服务照旧注册）。列进来会让「迁移前备份钩子」的日志变成另一句话，
     * 但不会改变可用性——所以这里刻意不列，保持「谁真在这里等谁」的清晰。
     */
    'ondra-snapshot',
    /*
     * 声音链的第一段：`ondra-tts`（合成）与 `ondra-tts-gate`（判定）。
     *
     * 任务点名的五段链「人设 → 情绪 → 记忆 → 声音 → 通道」里，前四段已经
     * 各自跑起来，**唯独「声音」这两个包一次都没装过**。它们不缺调用方，
     * 缺的是彼此之间那一根线：
     *
     * | 包 | 自己负责 | 明写不做 |
     * | --- | --- | --- |
     * | `ondra-tts` | 三通道合成、缓存、播放 | 不判「该不该念」（`README` 第一节） |
     * | `ondra-tts-gate` | 四道闸门、连读上限、频控 | **不调它的 `speak()`**（`README` 第二节原话） |
     *
     * 于是 `admit()` 与 `speak()` 在宿主侧都是零调用方，两处都不报错——
     * 各自都「按设计」只做自己那一段。接法在 `src/voice.ts`：宿主在
     * `inference.run` 返回之后判一次、念一次，顺序固定为判定在前。
     *
     * ## 为什么两个必须一起进名单
     *
     * 只装 `ondra-tts`：`speakReply()` 取不到闸门，恒返回 `absent`，
     * 界面上「语音合成」那一段全是默认值却永远不出声。
     * 只装 `tts-gate`：闸门可用，但 `admit()` 之后没有可调用的合成服务，
     * 判定链空转。这与 `memory-dedupe` / `memory-intake` 是一对同理。
     *
     * ## 为什么它们不会让宿主起不来
     *
     * 两包都不声明插件级 `inject`（各自文件头都写了理由），所有依赖走
     * 同步 `ctx.get` + 降级路径。`ondra-tts` 只消费已经在名单里的
     * `identity` / `config-schema` / `clock` / `path-layout` 四个，
     * 因此不需要写 `after` 也不会拿到 `undefined`——但顺序上仍排在它们之后
     * （名单本身就是装载顺序）。
     *
     * ## 出声不等于装上就出声
     *
     * `enable` 在 `tts` 段默认 `true`，用户关掉就是 `enable=false`，
     * 插件自报 `reason='disabled'`，宿主据此一次净化、一次判定都不做。
     * 不另设宿主开关：两个布尔值必然漂开，而用户能改的那个通常就是漂的那个。
     */
    'ondra-tts',
    'ondra-tts-gate',
    /*
     * `ondra-oral`：**口语化塑形**（O-040，手册 §4.2）。
     *
     * 这是声音链的前半段，与后面两个包是同一件事的两头：
     *
     * | 包 | 负责 | 明写不做 |
     * | --- | --- | --- |
     * | `ondra-oral` | 改嘴上的语法：口癖、省主语、标点习惯、语气词减法 | 不发消息、不判情绪、不分条 |
     * | `ondra-tts-gate` | 判这一句值不值得念 | 不改字 |
     * | `ondra-tts` | 合成、缓存、播放 | 不改字、不判定 |
     *
     * ## 它此前为什么没装（也是本仓第四次同族漏判）
     *
     * `ctx.get('ondra-oral')` 全仓命中数为 **0**：没有任何插件消费它。
     * 静态普查据此判「装它没有收益」。但它的消费者是**用户的眼睛**——
     * 她说话的口吻改没改，只有人能判断，与 `ondra-emotion-diffuse`、
     * `ondra-memory-heal`、`ondra-memory-dream` 三个同族一样：
     * 读者是人，不是另一个插件。
     *
     * ## 它唯一的依赖是软依赖，且已在名单里
     *
     * `ondra-emotion-express`（六态表达档）缺席时它仍然可用，只是退回
     * 「默认标点、语气词不动」——`styleOf()` 会返回空对象，`baseShape()`
     * 因为 `style.particles === undefined` 而跳过减法。这是正确降级，
     * 不是缺陷，所以**刻意不写进 `after`**：写进去会让「上游缺席」
     * 变成「整个插件不加载」，而缺它时她只是少一点语感。
     *
     * 但 `after` 仍要写它真正同步取的那三个：`apply()` 里同步
     * `ctx.get('ondra-identity')` 与 `ctx.get('ondra-config-schema')`，
     * 少一个就会拿到 `undefined` 并把日志名/四层合并定死。
     *
     * ## 装上之后必须有调用方，否则等于没装
     *
     * `applyTurn()` 在宿主侧原本零调用方。接法在 `src/oral.ts`：
     * 宿主在 `inference.run` 返回之后、发 `done` 帧之前塑形一次，
     * 让「界面显示的 / 记忆存的 / 念出来的」是同一个字符串。
     * 这是本轮真正要修的东西，只加 id 是最坏的做法。
     */
    'ondra-oral',
    /*
     * `ondra-rhythm` / `ondra-rhythm-typing`：**分条与计时**（O-038 / O-039）。
     *
     * `ondra-oral` 改的是「一个句子里怎么说话」，这两个包改的是
     * 「一整段话怎么分成几条、每条之间等多久」：
     *
     * | 包 | 负责 | 明写不做 |
     * | --- | --- | --- |
     * | `ondra-rhythm` | 纯函数：切句、装箱、算延迟、判深夜 | 连 `setTimeout` 都不 import |
     * | `ondra-rhythm-typing` | 时间线：等、发、取消、报阶段 | 不分条、不算延迟、不画界面 |
     *
     * ## 它们此前为什么没装：第五次同族漏判
     *
     * `ctx.get('ondra-rhythm')` 的唯一消费方是 `ondra-rhythm-typing`，
     * 而 `ctx.get('ondra-rhythm-typing')` 的唯一消费方是 `ondra-breath`——
     * 三个包互相指认，**圈外人一个都没有**。静态普查从任一包出发看，
     * 都会得出「消费方未装载 → 装了空转」，于是三个一起被判为无效。
     *
     * 这与前四次（`emotion-diffuse` / `memory-heal` / `memory-dream` /
     * `oral`）是同一个坑：**读者是用户的感官，不是另一个插件**。
     * 「她说话像不像人」这件事，分成几条、每条间隔多久、深夜会不会更慢，
     * 只有坐在对面的人能判断。
     *
     * ## 三者必须一起进名单
     *
     * | 只装 | 症状 |
     * | --- | --- |
     * | `rhythm` | `plan()` 零调用方，`stats().turns` 恒 0 |
     * | `rhythm` + `typing` | 时间线能排出来，但宿主没有地方去问它 |
     * | 三个都装（本轮） | 宿主 `src/rhythm.ts` 在**第一帧正文之前**停半拍、
     *   并在正文到达后数一次分条 |
     *
     * ## 为什么 `breath` 也在这一批
     *
     * 它是这条链上唯一「减」而不是「加」的一环：长停顿期间**必须**
     * 不显示「正在输入」。少了它，界面在 3–9 秒的沉默里一直亮着指示器，
     * 比不亮更假。而它自己没有配置之外的状态，装了就跟着 `typing` 的阶段走。
     *
     * ## `breath.presence()` 必须由宿主**显式传阶段**
     *
     * 它不传阶段时读的是 `typing.phaseOf()`，而那张 `active` 表只在
     * `run()` 期间有值。本宿主走 `schedule()` 预览路径，`active` 恒空 →
     * `phaseOf` 恒 `idle` → `presence()` 恒 `show:false`。也就是说：
     * 三个包全装、`available` 全 true，界面仍永远不显示她在打字。
     * 所以 `presenceOf(ctx, id, phase)` 统一带第三参，判定表仍归插件。
     */
    'ondra-rhythm',
    'ondra-rhythm-typing',
    'ondra-breath',
    /*
     * `ondra-filter-chain`：**表达层的闸门**（O-037，手册 §4.1）。
     *
     * 九步：草稿腔 → AI 自曝 → 硬红线 → 关系越线 → 阶段越线 → 旁白叙述
     * → 4-gram 复读 → 客服腔 → 长度兜底。手册把这一条列进自研档 P0，
     * 原话是「输出过滤九步——复读/旁白/客服腔逐条剥离」。
     *
     * ## 它此前为什么没装：第十次同族漏判，但这次是「反向」的
     *
     * 前九次漏判都是「插件没消费方」。这一次相反——**它的四个上游全在名单里**：
     *
     * | 上游 | 在不在 | 缺了少哪一步 |
     * | --- | --- | --- |
     * | `ondra-persona-core` | 在 | 硬红线、关系越线 |
     * | `ondra-emotion-stage` | 在 | 阶段越线 |
     * | `ondra-emotion-express` | 在 | 困 / 炸毛时收紧长度 |
     * | `ondra-llm-gateway` | 在 | 事后评审那一次打分 |
     *
     * 而 `ctx.get('ondra-filter-chain')` 全仓命中数为 **0**，
     * 静态普查据此判「没有消费方 → 装了空转」。漏掉的仍然是同一件事：
     * **读者是用户的眼睛**。她会不会突然冒出「作为一个 AI」、
     * 会不会重复上一轮那句、会不会端着客服腔说「您」——这些只有人能判。
     *
     * ## 装上之后必须有调用方，否则等于没装
     *
     * 接法在 `src/filter.ts`，挂在 `inference.run` 返回之后、**塑形之前**：
     *
     * ```
     * 模型原文 ─→ 九步过滤 ─→ 口语化塑形 ─→ 分条记账 ─→ done
     * ```
     *
     * 顺序两条都不能挪，理由写在 `src/filter.ts` 的文件头：
     * 过滤靠句号断句（塑形会去句号）、界面用 `done` 覆盖正文。
     *
     * ## 为什么 `ok=false`（判删空）时放行原文
     *
     * 插件明写「删空不编话」，但重新生成只有对话链能做，而此刻模型已经跑完。
     * 宿主若真拒收，用户看到的是**空白气泡**——比那句旁白糟得多。
     * 所以放行原文 + stderr 一行 + 探针计一次，理由与 `tts` 的 `held` 同一条。
     */
    'ondra-filter-chain',
    /*
     * `ondra-dialogue`：**对话链**（O-033）。通道层要的「她怎么回这句话」全在这里。
     *
     * `channel-kit.callPersona()` 的实现是 `dialogue.turn()`——它刻意不自己
     * 拼提示词（理由写在 `plugins/ondra-channel-kit/src/call.ts` 的文件头：
     * 自己拼就会有第二条对话通路，两条路的历史不一致）。
     *
     * 于是没有 `ondra-dialogue` 时，8 个适配器全部只能回 `no-dialogue`：
     * 通道能收、能记账、能排队，**就是没人说话**。而这处缺席只在
     * `callPersona()` 的返回值里看得见，日志里一个 error 都没有。
     *
     * ## 它提供的三件事，本仓此前一件都没有
     *
     * | 能力 | 缺了之后的真实症状 |
     * | --- | --- |
     * | 会话内**冻结前缀** | 每轮重拼 system prompt，缓存命中率归零（手册 §8.5 实测差 44 倍成本） |
     * | 历史只追加、整轮事务提交 | 中断留下半轮，她下一轮接着半句往下说 |
     * | `abort()` 的取消语义 | 用户按停止，请求还在烧 token 且仍写进历史 |
     *
     * ## 它不建 Session、不写 `app_session_log`
     *
     * 那是产品红线（master-plan §6 禁令 5），与「界面上的会话列表」是两件事。
     */
    'ondra-dialogue',
  ]
  const enableList = [...new Set([...DEFAULT_CORE_ENABLE, ...parseEnableList(process.env.ONDRA_CORE_ENABLE)])]
  /*
   * 用户在扩展抽屉里关掉的包。
   *
   * 名单来自代码常量 + 环境变量，两者用户都不方便改；扩展抽屉的开关就是
   * 第三条、也是唯一一条运行时可达的入口。它只影响**本次启动的装载名单**，
   * 在已装载之后再改不会卸载插件——理由见 `src/plugins.ts` 的文件头。
   */
  const pluginSwitchFile = join(dataDir, 'plugins.json')
  const pluginSwitches = await readPluginSwitches(pluginSwitchFile)
  /*
   * 三份名单合成最终的装载名单：
   *   默认常量（核心链）+ 环境变量（临时调试）+ 用户在扩展抽屉里额外打开的
   *   − 用户在扩展抽屉里停用的。
   *
   * 顺序不能换：`extra` 必须在 `disabled` 之前，否则「先关掉、再打开」
   * 同一个包会命中停用名单——用户看到的开关是开的，实际却没装载。
   */
  const enabledPlugins = new Set(
    [...enableList, ...pluginSwitches.extra].filter((id) => !pluginSwitches.disabled.has(id)),
  )

  /*
   * 宿主级常驻：**不受装载名单约束**，无条件可用。
   *
   * 前两个包在第 1、2 段里就已经 `ctx.plugin(...)` 挂好了（见上方
   * 「桌面能力桥」与「dsh 内核客户端」），它们不在 `enabledPlugins` 里——
   * 那份名单只描述「核心链成员」，而这两个是宿主自己的地基。
   *
   * 第三个 `ondra-core` 是**装配器本身**：宿主在下面直接 `corePlugin.loadCore()`
   * 用它装那 75 个成员，它自己从来没被 `ctx.plugin()` 挂过，也不在成员清单里。
   *
   * ## 为什么它必须进这个集合（第 12 轮补）
   *
   * 它是个真包，所以扩展抽屉照目录把它列了出来；而它的 `loaded` 来自
   * `enabledPlugins`——用户在抽屉里点一次「启用」，它就进了 `plugins.json`
   * 的 `extra`，界面于是显示「已装载」。反过来点「停用」，它被写进 `disabled`，
   * 下次启动界面显示「未启用 · 未装载」，**而那 75 个成员照装不误**。
   *
   * 也就是说：这个开关从任何一侧看都是空的，且两侧的显示都是假的。
   * 装配器没有「停用」这个动作可实现（宿主不用它就什么也装不起来），
   * 所以它与前两个同属「不可停用」，一并进 `core` 让开关置灰。
   *
   * 顺带把两个数字对上了：`核心链装载 75 + 宿主常驻 3 = 78`，与
   * `GET /api/plugins` 的 78 个包一致，不再差一个。
   *
   * ## 为什么必须单独说出来
   *
   * 扩展抽屉的 `loaded` 判据只有 `enabledPlugins` 一处。常驻包不在里面，
   * 于是界面上稳定显示：
   *
   * ```
   * dsh-client      未启用 · 未装载      ← 实际每次启动都在跑
   * desktop-bridge  未启用 · 未装载      ← 实际每次启动都在跑
   * ```
   *
   * 更糟的是 `desktop-bridge` 曾被写进 `plugins.json` 的 `disabled`：
   * 用户以为关掉了，重启后它照装不误，而界面还配合着显示「已关」——
   * **关闭动作无效与状态谎报互相盖章**，两边都不会报错。
   *
   * 判据是日志而不是推断：每次启动都有 `dsh-client dsh 内核就绪：2.1.2`，
   * 而 `GET /api/plugins` 同一时刻说它没装载。同一份事实两种说法，
   * 那就一定是其中一处写错了。
   *
   * ## 为什么并入 `core` 而不是只改 `loaded`
   *
   * `core` 的语义是「**不允许停用**」，界面据此把开关置灰、toggle 接口据此
   * 回 409。常驻插件本来就没有「停用」这个动作可实现（挂载点在装载名单之外），
   * 若只把 `loaded` 改成 true 而 `core` 留空，开关会变成可点、点了却什么也
   * 不会发生——把「谎报」换成了「空响」，一样是失信。
   */
  const RESIDENT_PLUGINS = ['desktop-bridge', 'dsh-client', 'ondra-core'] as const
  /** 展示用的装载集合：核心链 + 宿主常驻。判据只此一处。 */
  const loadedPlugins = new Set<string>([...enabledPlugins, ...RESIDENT_PLUGINS])
  /** 展示用的「不可停用」集合：核心链 + 宿主常驻。 */
  const protectedPlugins = new Set<string>([...DEFAULT_CORE_ENABLE, ...RESIDENT_PLUGINS])

  // --- 3.5 插件设置段 -------------------------------------------------------
  // 必须**早于** `loadCore`：用户改的设置要作为配置递进插件（见 `buildMemberConfigs`）。
  // 原先这里在 loadCore 之后打开，于是装载时根本无从读到用户层——插件永远跑默认值，
  // 而设置页照常显示并保存，两侧都不报错。1168 个字段同时失效，且极难察觉。
  //
  // 用户层单独一个文件（`settings.json`），不与模型密钥混存：前者是偏好、
  // 后者是凭据，混在一起会让「只带走偏好」或「只重置密钥」都做不到。
  const settings = await SettingsStore.open(join(dataDir, 'settings.json'))

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
    + `字段 ${String(settingsSections.reduce((sum, section) => sum + section.fields.length, 0))} 个`,
  )

  /*
   * 扩展清单：**扫目录**，不复用设置段。
   *
   * 十几个包没有任何设置字段（时钟、身份、路径布局），它们在设置面板里
   * 不存在，但确实是运行中的扩展。用设置段当清单会让扩展抽屉漏掉它们，
   * 用户看到的是「装了 60 个」，实际 78 个。理由同 `src/plugins.ts` 文件头。
   */
  const pluginRows = await scanPlugins(
    resolvePluginsRoot(),
    loadedPlugins,
    protectedPlugins,
    settingsSections,
  )
  logInfo(
    ctx,
    `扩展 ${String(pluginRows.length)} 个（本次装载 ${String(pluginRows.filter((row) => row.loaded).length)}，`
    + `用户额外启用 ${String(pluginSwitches.extra.size)}，停用 ${String(pluginSwitches.disabled.size)}）`,
  )

  // --- 3.6 装载核心 ---------------------------------------------------------
  const coreConfigs = buildMemberConfigs(settings.read(), settingsSections)
  /*
   * 数据根**由宿主告知**，不让插件自己猜。
   *
   * `ondra-path-layout` 的 `root` 默认为空，空时它自己退到 `$ONDRA_HOME`
   * 或 `~/.ondra`——而宿主的数据目录是 `resolveDataDir()`（macOS 上是
   * `~/Library/Application Support/com.ntars.ondra`）。两者不是同一个地方，
   * 于是同一个应用会把数据写在两处：`config.json` / `sessions/` 在这里，
   * `ondra.db` 在那里，备份与迁移都只带得走一半。
   *
   * 为什么它必须是**注入**而不是环境变量：这个插件没有 `lib/settings.js`，
   * 因此不进设置段、用户在界面上改不到它。宿主在这里注入是它拿到数据根的
   * 唯一途径，也顺带保证「宿主说数据在哪，库就在哪」这个唯一真源。
   *
   * 注意 `ONDRA_DATA_DIR` 在上面已被改写成 `sessionsDir`（那是给 dsh 内核的），
   * 所以这里必须用早先算好的 `dataDir` 常量，不能重读环境变量。
   */
  coreConfigs['ondra-path-layout'] = { root: dataDir }
  /*
   * 网关的来源清单**由用户配好的供应商派生**，不让用户填第二遍。
   *
   * `ondra-llm-gateway` 的 `sources` 默认为空，且它刻意不猜 `provider`
   * （那是上游适配器路由键，编一个就是假开关）。旧项目那套多适配器架构下
   * 这个决定成立，但本仓只有一个上游：内核的 `ChatAdapter`。于是
   * 「用户配了几个供应商」与「网关该有几条来源」是同一件事，让用户在
   * 两个界面各填一遍才是真正的第二份真源。
   *
   * 用户若在设置里手填了 `sources`，**以用户为准**——派生值只补空缺，
   * 不覆盖。手填是逃生口：将来出现内核之外的来源时不必改代码。
   */
  const derivedSources = sourcesFromProfiles(config.read().profiles)
  if (derivedSources.length > 0) {
    const existing = coreConfigs['ondra-llm-gateway']
    const hasUserSources = typeof existing === 'object'
      && existing !== null
      && Array.isArray((existing as Record<string, unknown>)['sources'])
      && ((existing as Record<string, unknown>)['sources'] as unknown[]).length > 0
    if (!hasUserSources) {
      coreConfigs['ondra-llm-gateway'] = {
        ...(typeof existing === 'object' && existing !== null ? existing as Record<string, unknown> : {}),
        sources: derivedSources,
      }
      logInfo(ctx, `模型来源由供应商派生 ${String(derivedSources.length)} 条`)
    }
  } else {
    // 一条都没有不是错误：用户还没配供应商。提炼会走 no-source 降级，
    // 这里如实说一句，免得下一个人又去查「为什么 memory_fact 是 0」。
    logInfo(ctx, '还没有配置任何供应商：模型来源清单为空，事实提炼会跳过（原文照常落盘）')
  }
  /*
   * 传给 `loadCore` 的必须是**合成后的名单** `enabledPlugins`，不是 `enableList`。
   *
   * `enableList` 只有两来源：代码常量 `DEFAULT_CORE_ENABLE` 与环境变量
   * `ONDRA_CORE_ENABLE`。用户在扩展抽屉里点「启用」写的是 `plugins.json`
   * 的 `extra`，点「停用」写的是 `disabled`——两者都只进 `enabledPlugins`。
   *
   * 这里原先传的是 `enableList`，于是同一次启动里出现两套事实：
   *
   * | 读的地方 | 判据 | 说法 |
   * | --- | --- | --- |
   * | `/api/plugins` 的 `loaded` | `enabledPlugins` | 「已装载」 |
   * | 真正装没装 | `loadCore` 收到的名单 | 「没装」 |
   *
   * 后果有两层，而且都不报错：
   *
   * 1. **开关是空响。** 用户打开一个出厂关闭的包，重启后它照样不装，界面
   *    却已经从「未装载」翻成「已装载」——「关闭无效」与「状态谎报」
   *    互相盖章，这正是本仓反复踩的那一类。
   * 2. **停用也是空响。** 停用一个非核心包只会把它从 `enabledPlugins` 里
   *    摘掉，而 `enableList` 里本来就没有它，于是什么都没发生（这一层
   *    恰好因为「本来就不装」而看不出问题，掩盖了上面那层）。
   *
   * 换成 `enabledPlugins` 之后，「展示的装载集合」与「实际装载的集合」
   * 只差两个常驻包（它们本来就在链外挂载，见 `RESIDENT_PLUGINS`）。
   */
  const coreResult = await corePlugin.loadCore(ctx, { enable: [...enabledPlugins], configs: coreConfigs })
  /*
   * 括号里那句「另有 N 项宿主常驻」不是废话。
   *
   * `coreResult.loaded` 只含核心装载链，而 `desktop-bridge` / `dsh-client`
   * 是在链外挂的。三处数字（这行日志、`ondra status`、插件抽屉）此前各报
   * 各的（46 / 46 / 48），排查时第一眼就会怀疑「到底装了几个」。
   * 现在这行把两个口径一次说清。
   */
  logInfo(
    ctx,
    `空谷核心：清单 ${String(corePlugin.MIGRATED_PLUGIN_COUNT)} 项，`
    + `核心链装载 ${String(coreResult.loaded.length)} 项`
    + `（另有 ${String(RESIDENT_PLUGINS.length)} 项宿主常驻，合计 ${String(coreResult.loaded.length + RESIDENT_PLUGINS.length)} 项），`
    + `禁用 ${String(coreResult.skipped.length)} 项，`
    + `带入用户配置 ${String(Object.keys(coreConfigs).length)} 项`,
  )
  // 跳过项只在「有启用名单」时逐条打原因。默认全禁的情况下逐条打 134 行
  // 只会把日志刷满，而那 134 行说的是同一件事：「这是默认策略」。
  if (enableList.length > 0) {
    for (const item of coreResult.skipped) {
      // 只报「本该装载却失败」的。默认禁用不是事件，不值得占一行日志。
      if (item.reason === '默认禁用') continue
      process.stderr.write(`[host] 未装载 ${item.id}：${item.reason}\n`)
    }
  }

  // --- 4. 把已存的配置推给内核 -----------------------------------------------
  // 内核启动时还不知道用户配过什么，这里补一次。失败不阻断启动：
  // 配置推送失败时内核仍有本地演示模型可用，界面不会完全不能用。
  await syncConfigToKernel(ctx, config.read())

  // --- 5. HTTP 服务 ----------------------------------------------------------
  /*
   * 调试接口：默认关闭，只有 `ONDRA_DEBUG=1` 或数据目录存在 `debug.enable`
   * 时才装配。关闭时 `debugEnvironment` 是 undefined，路由表与加这套接口之前
   * 完全一致——正式包不该因为多了个调试功能而多出任何可探测的路径。
   *
   * 判定放在这里而不是 buildRoutes 内部：开关只该有一个决定点，
   * 将来要加第三种开启方式（比如设置页里的开关）只改这一处。
   */
  const version = await readPackageVersion()
  const workspaceRoot = resolveWorkspaceRoot()
  /*
   * 复用上面那一个 `hostLog`，不 new 第二个。
   *
   * `DebugLog` 在内存里持一份 `buffer` 供 `tail()` 直接读。建两个实例的话，
   * `/api/debug/logs` 读到的是**第二个**那份——只有启动之后的显式写入，
   * 而日志导出器写进的是第一个。两边各写各的，`tail` 就永远看不见插件日志
   * （这正是「接好了却查不到」最容易长出来的第二种形态）。
   */
  const debugLog = hostLog
  const debugEnabled = debugEnabledEarly
  const debugEnvironment: DebugEnvironment | undefined = debugEnabled
    ? {
        dataDir,
        version,
        startedAt,
        workspaceRoot,
        settings,
        sections: settingsSections,
        bridge: new UiBridge(),
        log: debugLog,
        /*
         * 展示用的装载集合，与 `/api/plugins` 同源。
         *
         * 这里原来报的是 `coreResult.loaded`——只含核心装载链装上的包，
         * 于是 `ondra status` 说「46 个已装载」、插件抽屉说「48 个」，
         * 差的正是 `desktop-bridge` / `dsh-client` 两个**在核心链之外挂载**的
         * 常驻插件。两个数字都「不算错」，但同一个人在两处看到不同答案时，
         * 只会得出「有一个在骗我」的结论。第 6 轮修 `/api/plugins` 时漏了这里。
         */
        loadedPlugins: [...loadedPlugins],
      }
    : undefined

  const routes = buildRoutes(ctx, config, settings, settingsSections, debugEnvironment, {
    rows: pluginRows,
    loaded: loadedPlugins,
    core: protectedPlugins,
    switchFile: pluginSwitchFile,
    /*
     * 可变引用而不是值拷贝：开关写入后要立刻反映到「下次启动」的状态里，
     * 而 `rows` 与 `sections` 都是启动时扫的静态清单，不该为一次开关重扫
     * 78 个目录。这里让路由层读这一份，状态只有一处。
     */
    switches: pluginSwitches,
  })
  // 端口策略：默认 9060 起，被占用则逐个顺延（见 src/server.ts 的 listenWithFallback）。
  // 允许用 ONDRA_PORT 覆盖，方便调试时指定别的起点；传 0 则退回系统随机分配。
  //
  // 这里不能写成 `{ port: parsePort(...) }`：项目开了 exactOptionalPropertyTypes，
  // 显式传 undefined 与"不传"是两回事，前者通不过类型检查。
  // 解析出 undefined 时就整个省掉这个字段，让 startWebServer 用它的默认值。
  const portOverride = parsePort(process.env.ONDRA_PORT)
  const server = await startWebServer(routes, {
    ...(portOverride === undefined ? {} : { port: portOverride }),
    channels: channelWebServer,
  })

  // --- 6. 报告就绪 -----------------------------------------------------------
  sendToShell({ type: 'ready', url: `${server.protocol}://127.0.0.1:${String(server.port)}`, token: server.token, port: server.port })
  logInfo(ctx, `宿主已就绪，监听 127.0.0.1:${String(server.port)}，数据目录 ${dataDir}`)
  logInfo(ctx, `工作区根目录 ${workspaceRoot}`)

  /*
   * 调试握手文件。
   *
   * 必须在 server 起来之后写：端口可能因占用而顺延，先写会给出错误的地址。
   * 只有调试开启时才写——关闭时不留下任何能被外部发现的入口。
   */
  if (debugEnvironment !== undefined) {
    const handshake = await writeDebugHandshake(dataDir, {
      url: `${server.protocol}://127.0.0.1:${String(server.port)}`,
      token: server.token,
      port: server.port,
      version,
      pid: process.pid,
    })
    debugEnvironment.log.write(`握手文件 ${handshake}；版本 ${version}；端口 ${String(server.port)}`)
    logInfo(ctx, `调试接口已开启：${handshake}`)
  }

  // --- 7. 优雅关闭 -----------------------------------------------------------
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => stopping ??= (async () => {
    await server.close()
    /*
     * 删掉握手文件。
     *
     * 留着它会指向一个已经关掉的端口：命令行连上去只会得到 ECONNREFUSED，
     * 而「连接被拒」看起来像应用崩了，实际是应用正常退出。删掉之后
     * `ondra status` 能直接说「应用没在运行」，这才是准确的话。
     */
    if (debugEnvironment !== undefined) {
      debugEnvironment.log.write('调试接口随宿主退出而关闭')
      await clearDebugHandshake(dataDir)
    }
    /*
     * 把攒着的日志立刻落盘。
     *
     * `DebugLog` 现在是 250ms 批量追加（理由见 `src/debug.ts` 的 `pending` 注释），
     * 正常退出时不主动 flush 就会丢掉最后那批——而那批恰好是「退出前发生了什么」，
     * 排查崩溃收尾时最需要的一段。
     */
    hostLog.flush()
    // 销毁根 Fiber 会触发全部插件的清理动作（含关闭内核子进程）。
    // 用 fiber.dispose 而不是某个事件名：Cordis 4 的事件表里没有 'dispose'，
    // 只有 internal/* 内部事件。
    await ctx.fiber.dispose()
  })()

  /*
   * 父进程关闭管道即表示壳退出了，此时必须跟着退出，否则成为孤儿进程。
   *
   * ## `resume()` 不是可有可无的一行
   *
   * Node 的 `process.stdin` 默认是**暂停**的可读流：只挂 `end` 监听不会让它
   * 开始读，EOF 就永远到不了。于是「壳死了、管道关了、宿主还在跑」——
   * 这条监听写了等于没写（实测：`kill` 掉壳之后宿主与内核都还活着）。
   *
   * 而这条通道是**唯一**在壳被强杀时还起作用的一条：`kill -9`、活动监视器
   * 的「强制退出」、系统注销都不给任何进程执行清理代码的机会，能依靠的只剩
   * 管道 EOF。`SIGTERM` 那条监听在 `kill -9` 面前同样无效，所以两者都要有。
   */
  process.stdin.resume()
  process.stdin.on('end', () => { void stop().finally(() => { process.exit(0) }) })
  process.stdin.on('close', () => { void stop().finally(() => { process.exit(0) }) })
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
  // 同时进系统日志环形缓冲：界面「日志 → 系统日志」读的就是这一份。
  // 只写 stderr 的话，用户在界面上永远看不到启动期发生了什么。
  pushSystemLog('info', message)
  const logger = (ctx as unknown as { logger?: { info?: (msg: string) => void } }).logger
  if (logger?.info !== undefined) logger.info(message)
  else process.stderr.write(`[host] ${message}\n`)
}

/**
 * 把用户层设置翻成「成员目录名 → 配置」，供 `loadCore` 注入。
 *
 * ## 为什么需要这个映射
 *
 * 三处用的是**两套键**，而它们本来就不同源：
 *
 * | 处 | 键 | 例 |
 * | --- | --- | --- |
 * | `enable` 名单 / 成员 id | 目录名 | `ondra-proactive-quota` |
 * | `settings.json` 的段键 | 段 id | `proactive-quota` |
 *
 * 段 id 是插件自己声明的（122 段里 12 个与目录名不同），所以**不能靠
 * 去前缀猜**。这里反过来用 `scanSections` 已经算好的 `dir`，那是唯一
 * 权威的对应关系；只按目录名匹配会把那 12 段静默漏掉。
 *
 * ## 为什么只给「已装载」的成员
 *
 * 没装载的成员拿到配置也无处可去。过滤掉可以让日志里那个数字有意义：
 * 「带入用户配置 N 项」应当等于「真的有插件吃到了配置」，而不是
 * 「settings.json 里有几段」。
 *
 * @param user 用户层：段键 → 字段键 → 值。
 * @param sections 扫描结果，用来查段键对应的插件目录名与装载状态。
 */
function buildMemberConfigs(
  user: Record<string, Record<string, unknown>>,
  sections: readonly SettingsSection[],
): Record<string, unknown> {
  const dirOf = new Map<string, string>()
  for (const section of sections) {
    // 只认已装载的：未装载成员拿不到配置，也不需要被算进注入数。
    if (section.active) dirOf.set(section.id, section.dir)
  }

  const out: Record<string, unknown> = {}
  for (const [sectionId, values] of Object.entries(user)) {
    const dir = dirOf.get(sectionId)
    if (dir === undefined) continue
    // 空对象也照传：它表示「用户没改过这段」，插件据此走自己的默认值，
    // 与「配置缺失」等价。不传会让下游多一个分支去猜。
    out[dir] = camelizeKeys(values)
  }
  return out
}

/**
 * 段字段键（kebab）→ 插件配置键（camel）。
 *
 * ## 为什么必须在这一处归一
 *
 * `settings.json` 里存的是段字段键（`quiet-start`），而**每个插件的
 * `completeConfig()` 只读 camel 键**（`quietStart`）——64 个 `settings.ts`
 * 逐个查过，没有一个读 kebab。
 *
 * 不归一的话，配置会死在两步之外：
 * ① cordis 装载插件时先用插件导出的 `Config['~standard'].validate(config)`
 *   过一遍，而那里就是 `completeConfig(value)`——kebab 喂进去，字段一个都
 *    对不上，于是**整份配置被打回出厂默认**；
 * ② `apply(ctx, config)` 收到的已经是默认值，插件内部再怎么合并都救不回来。
 *
 * 症状不是报错，是「设置页每一个滑杆都拨得动、存得下、重启后读得回，
 * 但插件行为永远停在默认值」——两侧都不报错，最难查的一类。
 *
 * ## 为什么只转顶层键
 *
 * 配置值的内部结构（数组、对象）属于插件自己的数据，宿主不碰。
 * 只把「段字段键」这一层的连字符转成驼峰，与插件侧 `KEY_PAIRS` 的
 * 映射方向一致。
 *
 * @param values 段字段键 → 值。
 * @returns 插件配置键 → 值。
 */
function camelizeKeys(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    const camel = key.replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase())
    out[camel] = value
  }
  return out
}

/**
 * 扩展抽屉要用的运行态。
 *
 * `rows` 是启动时扫一次的静态清单（名称、版本、配置段），
 * `disabled` 是可变的那一份——用户点开关改的就是它，改完立刻落盘。
 * 两者分开而不是把状态塞进 `rows`：清单不需要每次开关都重扫 78 个目录，
 * 而「停用与否」只存在一个地方，界面读到的不会被两份数据撕开。
 */
interface PluginRuntime {
  rows: readonly PluginRow[]
  /** 本次启动实际装载的名单。与开关算出的名单不同时，界面要提示「重启后生效」。 */
  loaded: ReadonlySet<string>
  /** 核心链成员。它们的开关置灰。 */
  core: ReadonlySet<string>
  /** 开关文件路径。 */
  switchFile: string
  /** 用户的额外启用与停用两份名单。路由层直接改它。 */
  switches: PluginSwitches
}

/** 组装 HTTP 路由表。 */
function buildRoutes(
  ctx: Context,
  config: ConfigStore,
  settings: SettingsStore,
  sections: readonly SettingsSection[],
  /** 调试环境。`undefined` 表示调试接口关闭，此时路由表里不会多出一条路径。 */
  debug: DebugEnvironment | undefined,
  /** 扩展清单与启停状态。 */
  plugins: PluginRuntime,
): ReadonlyMap<string, RouteHandler> {
  const routes = new Map<string, RouteHandler>()

  /**
   * 本进程内已结算过弥散的轮次序号。
   *
   * 边界键要「每轮唯一但不能每轮都算」：唯一靠这个单调序号，
   * 「不能每轮都算」靠插件的 `minGapMinutes` 那道闸（它判的是**时间**，
   * 不是序号）。序号只负责让同一个会话里第二次、第三次进来时
   * 幂等闸（`boundaryKey` 相同）不误判成重复。
   */
  let diffuseSeq = 0

  /**
   * 真正**调用到** `diffuseAcrossSessions()` 的次数。
   *
   * ## 为什么不复用 `diffuseSeq`
   *
   * 第一版诊断路由报的就是 `diffuseSeq`，做反向验证时发现它抓不到缺陷：
   * 把调用整段删掉、只留 `diffuseSeq += 1`，`asked` 照样涨、诊断照样说
   * 「问过了」——因为那个自增写在调用之外。这正是本仓反复踩的那一类：
   * **判据指向了「文件里出现过」，而不是「唯一那一处真的执行了」**。
   *
   * 现在这个数只在调用真正发生之后才加，于是
   * 「计划要问」与「问过了」是两个不同的数，诊断能分开它们。
   */
  let diffuseAsked = 0

  /**
   * 「这一轮的系统提示词里真的有情绪块」的轮数。
   *
   * 它与插件自己的 `counters.projects` 是**两个数**，这是刻意的：
   * 前者说「装配那一处真的用了」，后者只说「投影被产出过」。
   * 删掉装配那一行，前者停住而后者照涨——正是靠这个差，才能把
   * 「算得出但没生效」与「接好了」分开。同族教训见 `diffuseAsked`。
   */
  let emotionApplied = 0

  /*
   * 「这一轮的上下文段真的拼进系统提示词」的轮数。
   *
   * 与 `emotionApplied` 同一条纪律，也必须与插件侧的两个数并排看：
   *
   * | 数 | 说明 | 读到 0 时的结论 |
   * | --- | --- | --- |
   * | `contextRegistered` | 注册表里登记了几段 | 0 → 插件没挂上（查 provide 顺序） |
   * | `contextApplied` | 其中几轮真的产出了正文 | 0 而登记 >0 → **库是空的**，不是接线断了 |
   *
   * 这两格分开是本轮最要紧的一件事：记忆为空时插件照常登记、这一轮却产不出
   * 正文。若只报一个数，「插件没挂上」与「挂上了但没东西可说」会完全同形——
   * 而它们的修法相反（前者改代码，后者对用户说一句「先聊两句」）。
   */
  let contextApplied = 0

  /** 健康检查。壳用它确认宿主仍在响应。 */
  routes.set('GET /api/health', () => ({ body: { ok: true, at: Date.now() } }))

  /**
   * 当前会话（单会话制）。
   *
   * ## 为什么返回一条而不是数组
   *
   * 单会话之后「列表」这个概念在协议上已经不存在了。继续返回数组会让每个
   * 调用方都写 `list[0]`，而那个 `[0]` 是隐式的第二份判据：一旦有历史归档
   * 混进来，取第一个就会取错。返回 `null` 或一个对象，语义在类型上就是确定的。
   *
   * ## 「当前」怎么认
   *
   * 内核按 `updatedAt` 倒序给出活跃会话，取第一条。清空全部会归档旧段并新建
   * 一段，于是活跃集合里恒为一条；若用户手工往数据目录塞了第二份会话文件，
   * 这里也只认最近更新的那条——单会话是产品口径，不是数据结构约束。
   */
  routes.set('GET /api/sessions', async () => {
    return { body: await readCurrentSession(ctx) }
  })

  /**
   * 新建会话：明确拒绝。
   *
   * 保留这条路由而不是删掉，是为了让「按旧路径建会话」得到一个可读的结论。
   * 回 404 会让人以为端口错了或版本没更新；409 加一句人话，产品口径才是
   * 明确的：不能新建，要清空就清空全部。
   */
  routes.set('POST /api/sessions', () => ({
    status: 409,
    body: { error: '单会话模式下不能新建会话；需要重开一段时用「清空全部」' },
  }))

  /** 单个会话详情。 */
  routes.set('GET /api/sessions/:id', async (request: RouteRequest) => {
    const client = getDsh(ctx)
    const meta = await client.call('session.get', { id: request.params.id })
    return { body: meta }
  })

  /** 会话消息。界面首屏与删除一条之后读它。 */
  routes.set('GET /api/sessions/:id/messages', async (request: RouteRequest) => {
    const client = getDsh(ctx)
    const messages = await client.call('session.messages', { sessionId: request.params.id })
    return { body: messages }
  })

  /**
   * 删除一条消息。
   *
   * ## 为什么这里收 messageId，内核收 seq
   *
   * 界面手里只有消息 id（React key 就是它）。让它维护一份「id → 下标」的
   * 映射，就要在每条乐观消息上多存一个字段，而那个字段在删除别的消息之后
   * 会整体错位。换算放在这一层：读一次消息、找一次下标、立刻删，
   * 中间只有一次进程内等待，比前端维护映射更不容易错。
   *
   * 找不到这条消息时回 404 而不是静默成功：用户点的那条已经不在了
   * （多半是另一个窗口或上一次刷新），如实告诉他，界面才好重拉消息。
   */
  routes.set('POST /api/sessions/:id/messages/delete', async (request: RouteRequest) => {
    const client = getDsh(ctx)
    const body = (request.body ?? {}) as Record<string, unknown>
    const messageId = typeof body.messageId === 'string' ? body.messageId : ''
    if (messageId === '') return { status: 400, body: { error: '缺少 messageId' } }

    const rows = await client.call('session.messages', { sessionId: request.params.id })
    const list = Array.isArray(rows) ? rows as Array<{ id?: unknown }> : []
    const index = list.findIndex((row) => row.id === messageId)
    if (index < 0) return { status: 404, body: { error: '这条消息已经不在了' } }

    const result = await client.call('session.deleteMessage', {
      sessionId: request.params.id,
      seq: index,
    }) as { removed?: unknown }
    return { body: { removed: result.removed === true } }
  })

  /**
   * 清空全部。
   *
   * ## 默认「归档成段」，而不是直接删正文
   *
   * 单会话意味着「重开一段」时用户没有第二个容器可放旧内容。直接抹掉会
   * 让一次误点变成永久损失，而归档把旧段留在数据目录里、只是不出现在界面上
   * ——代价只有磁盘上几个文件，换来的是可挽回。
   *
   * `archive: false` 才是真的删（调内核 `session.clear`），留给将来「彻底
   * 清空」那条更明确的操作，不在界面上默认暴露。
   *
   * ## 为什么在这里重置语音与口癖的计数
   *
   * 与「建新会话」同一时刻、同一理由：插件的账本按 `sessionId` 分桶，
   * 却不知道什么算一场会话。宿主知道，所以在这一处替它们归零。
   */
  routes.set('POST /api/sessions/:id/clear', async (request: RouteRequest) => {
    const client = getDsh(ctx)
    const body = (request.body ?? {}) as Record<string, unknown>
    const archive = body.archive !== false
    const id = request.params.id

    if (!archive) {
      const result = await client.call('session.clear', { sessionId: id }) as { cleared?: unknown }
      const cleared = typeof result.cleared === 'number' ? result.cleared : 0
      return { body: { archived: false, cleared, sessionId: id } }
    }

    let workspace = ''
    try {
      workspace = await ensureWorkspace(Date.now())
    } catch (error) {
      process.stderr.write(`[host] 建立工作区失败：${String(error)}\n`)
    }
    await client.call('session.archive', { id })
    const meta = await client.call('session.create', { title: '', workspace })
    const createdId = (meta as { id?: unknown }).id
    if (typeof createdId === 'string') {
      resetVoiceGate(ctx)
      beginOralSession(ctx, createdId)
    }
    return { body: { archived: true, cleared: 0, sessionId: createdId ?? '', session: meta } }
  })

  /** 归档当前段（保留数据，不出现在界面上）。 */
  routes.set('POST /api/sessions/:id/archive', async (request: RouteRequest) => {
    const client = getDsh(ctx)
    await client.call('session.archive', { id: request.params.id })
    return { body: { ok: true } }
  })

  /*
   * -------------------------------------------------------------------------
   * 导出与导入（迁移 / 恢复）
   * -------------------------------------------------------------------------
   *
   * ## 会话本来就是明文
   *
   * 落盘是 `sessions/<uuid>.json`，一个会话一个文件、内容是未压缩的 JSON
   * （见 `FileSessionStore`）。也就是说"迁移"本来只需要拷目录。界面缺的
   * 不是"明文"，而是**两个可执行的出口**：一份人能读的 Markdown（贴给别人、
   * 存档、search），和一份能原样倒回来的 JSON（恢复）。
   *
   * 所以这两条路由不加密、不打包、不加专有字段——导出的 JSON 就是会话
   * 文件本身的形状，用户用文本编辑器打开能直接看懂。
   *
   * ## 为什么格式化在宿主做
   *
   * 界面手里只有当前这一段的消息，归档段它根本没见过。要让"导出全部"
   * 成立，格式化必须发生在能列出全部会话的地方，也就是这里。
   */

  /** 会话导出（JSON + Markdown 同时给，界面按需保存一种）。 */
  routes.set('GET /api/export/session/:id', async (request: RouteRequest) => {
    const client = getDsh(ctx)
    const id = request.params.id ?? ''
    const meta = await client.call('session.get', { id }) as SessionExportMeta
    const rows = await client.call('session.messages', { sessionId: id })
    const messages = normalizeExportMessages(rows)
    const payload: SessionPayload = {
      format: 1,
      exportedAt: Date.now(),
      id: typeof meta.id === 'string' ? meta.id : id,
      title: typeof meta.title === 'string' ? meta.title : '',
      createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : 0,
      updatedAt: typeof meta.updatedAt === 'number' ? meta.updatedAt : 0,
      workspace: typeof meta.workspace === 'string' ? meta.workspace : '',
      messages,
    }
    return { body: { session: payload, markdown: renderSessionMarkdown(payload) } }
  })

  /** 全部会话导出（含归档段）。一条 JSON，能整包倒回来。 */
  routes.set('GET /api/export/all', async () => {
    const client = getDsh(ctx)
    const list = await client.call('session.list', { includeArchived: true })
    const metas = Array.isArray(list) ? list as SessionExportMeta[] : []
    const sessions: SessionPayload[] = []
    for (const meta of metas) {
      if (typeof meta.id !== 'string') continue
      const rows = await client.call('session.messages', { sessionId: meta.id })
      sessions.push({
        format: 1,
        exportedAt: Date.now(),
        id: meta.id,
        title: typeof meta.title === 'string' ? meta.title : '',
        createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : 0,
        updatedAt: typeof meta.updatedAt === 'number' ? meta.updatedAt : 0,
        workspace: typeof meta.workspace === 'string' ? meta.workspace : '',
        messages: normalizeExportMessages(rows),
      })
    }
    return { body: { format: 1, exportedAt: Date.now(), sessions } }
  })

  /**
   * 导入一段对话。
   *
   * ## 为什么先归档当前段
   *
   * 单会话制：应用里同时只有一段对话。恢复一份旧对话必然要给它腾位置，
   * 而**直接清空等于销毁**。归档是唯一既不丢数据、又让旧段不出现在界面上
   * 的做法——用户后悔时还能在数据目录里找到那一份。
   *
   * ## 为什么接受 `session` 也接受裸对象
   *
   * 用户可能保存的是导出接口的整个响应（`{session, markdown}`），也可能
   * 只保存了其中一个文件。两种都认，比让用户猜"该存哪个"友好。
   */
  routes.set('POST /api/import', async (request: RouteRequest) => {
    const client = getDsh(ctx)
    const body = (request.body ?? {}) as Record<string, unknown>
    const candidate = body.session ?? body
    const payload = normalizeImportPayload(candidate)
    if (payload === undefined) {
      return { status: 400, body: { error: '这个文件里没有可恢复的会话（需要 messages 数组）' } }
    }

    const current = await readCurrentSession(ctx)
    let archivedId = ''
    if (current !== null && typeof current.id === 'string') {
      await client.call('session.archive', { id: current.id })
      archivedId = current.id
    }

    let workspace = ''
    try {
      workspace = await ensureWorkspace(Date.now())
    } catch (error) {
      process.stderr.write(`[host] 导入时建立工作区失败：${String(error)}\n`)
    }

    const result = await client.call('session.import', {
      title: payload.title,
      workspace,
      messages: payload.messages,
    }) as { session?: { id?: unknown }; imported?: unknown }
    const createdId = typeof result.session?.id === 'string' ? result.session.id : ''
    if (createdId !== '') {
      resetVoiceGate(ctx)
      beginOralSession(ctx, createdId)
    }
    return {
      body: {
        session: result.session ?? null,
        imported: typeof result.imported === 'number' ? result.imported : 0,
        archivedId,
      },
    }
  })

  /**
   * 会话统计。会话抽屉的四项读数都从这里来。
   *
   * ## 为什么统计在宿主算，不在界面算
   *
   * 「已归档段数」只有内核的 `session.list({includeArchived:true})` 知道，
   * 界面手里只有当前这一段。若让界面去拉全量列表再数，它就必须知道
   * 「哪些算归档段」——那是存储语义，不该泄露到视图层。
   *
   * 四个数的口径：
   * - `rounds`：用户消息条数。与日志里「第 N 轮」同一口径，用户数自己说了几句；
   * - `startedAt`：会话创建时间，不是第一条消息的时间（首轮之前就有会话）；
   * - `totalChars`：用户与助手正文的字符总数，不含工具与系统消息；
   * - `archivedSegments`：已归档的会话段数，即「清空过几次」。
   */
  routes.set('GET /api/sessions/:id/stats', async (request: RouteRequest) => {
    const client = getDsh(ctx)
    const id = request.params.id
    const meta = await client.call('session.get', { id }) as { createdAt?: unknown; title?: unknown; workspace?: unknown } | null
    const rows = await client.call('session.messages', { sessionId: id })
    const list = Array.isArray(rows)
      ? rows as Array<{ role?: unknown; content?: unknown }>
      : []

    let rounds = 0
    let totalChars = 0
    for (const row of list) {
      if (typeof row.content !== 'string') continue
      if (row.role === 'user') {
        rounds += 1
        totalChars += row.content.length
      } else if (row.role === 'assistant') {
        totalChars += row.content.length
      }
    }

    const all = await client.call('session.list', { includeArchived: true })
    const archivedSegments = Array.isArray(all)
      ? (all as Array<{ archived?: unknown }>).filter((item) => item.archived === true).length
      : 0

    return {
      body: {
        sessionId: id,
        rounds,
        startedAt: typeof meta?.createdAt === 'number' ? meta.createdAt : 0,
        totalChars,
        archivedSegments,
        messages: list.length,
        title: typeof meta?.title === 'string' ? meta.title : '',
        workspace: typeof meta?.workspace === 'string' ? meta.workspace : '',
      },
    }
  })

  // ---------------------------------------------------------------------------
  // 日志（三类分区）
  // ---------------------------------------------------------------------------

  /**
   * 会话日志：从落盘消息派生。
   *
   * ## 为什么由服务端派生，而不是让界面自己推
   *
   * 界面已经有一份推导（`useAppState` 的 `deriveLogs`）。两份推导必然漂移：
   * 一处把「一轮」按用户消息切、另一处按时间切，同一个会话在两个地方就会
   * 得到不同的轮数。现在只有服务端这一份，界面只负责渲染。
   *
   * ## 缺的信息就留空
   *
   * 历史轮次只有最终正文，没有思考时长，因此没有「想完了」那一条。
   * 不补假数据——日志的价值在于可信。
   */
  routes.set('GET /api/logs/session', async (request: RouteRequest) => {
    const sessionId = request.query['sessionId'] ?? ''
    if (sessionId === '') return { body: { sessionId: '', items: [] } }
    const client = getDsh(ctx)
    const rows = await client.call('session.messages', { sessionId })
    return { body: { sessionId, items: deriveSessionLog(rows) } }
  })

  /**
   * 系统日志：进程内环形缓冲。
   *
   * 读的是宿主自己的运行记录（插件装载、配置扫描、启动失败），与她的
   * 对话无关。容量与丢弃策略见 `src/system-log.ts`。
   */
  routes.set('GET /api/logs/system', (request: RouteRequest) => {
    const raw = Number(request.query['limit'] ?? '')
    const limit = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 200
    return { body: { items: readSystemLog(limit), size: systemLogSize() } }
  })

  /**
   * 通道日志：恒为空态。
   *
   * 八个 IM 适配器已随插件精简一并删除，通道这条链路在本版本不存在。
   * 返回一句明确的「无通道接入」，而不是一个空数组——空数组会被读成
   * 「通道在，只是最近没有消息」，两者对用户的含义完全不同。
   */
  routes.set('GET /api/logs/channel', () => ({
    body: { items: [], note: '无通道接入' },
  }))

  // ---------------------------------------------------------------------------
  // 扩展
  // ---------------------------------------------------------------------------

  /**
   * 扩展清单。
   *
   * ## 三个状态分开给，界面才说得清
   *
   * - `loaded`：**本次进程**真的装着。改开关不会改它；
   * - `enabled`：按开关算出的**下次启动**名单；
   * - `pendingRestart`：两者不一致，界面上要挂一句「重启后生效」。
   *
   * 只给其中两个，用户就会看到「开关是关的，但它还在跑」而没有任何解释。
   */
  routes.set('GET /api/plugins', () => ({
    body: {
      items: plugins.rows.map((row) => {
        /*
         * `core` 优先于 `disabled`：核心链成员与宿主常驻插件**恒为启用**。
         *
         * 这两类本来就没有「停用」这个动作可实现——核心成员的服务键在别人
         * 启动时就被 `ctx.get` 走了，常驻插件的挂载点在装载名单之外。toggle
         * 接口对它们回 409，界面把开关置灰。若这里仍让 `disabled` 说最后一句话，
         * 历史残留的一条停用记录就能让界面显示「已关」而进程里照跑——
         * 正是这一处要修的谎报。
         */
        const enabled = plugins.core.has(row.id)
          || (!plugins.switches.disabled.has(row.id)
            && (row.loaded || plugins.switches.extra.has(row.id)))
        return {
          ...row,
          enabled,
          pendingRestart: enabled !== row.loaded,
        }
      }),
      totals: {
        all: plugins.rows.length,
        loaded: plugins.rows.filter((row) => row.loaded).length,
        pending: plugins.rows.filter((row) => {
          const enabled = plugins.core.has(row.id)
            || (!plugins.switches.disabled.has(row.id)
              && (row.loaded || plugins.switches.extra.has(row.id)))
          return enabled !== row.loaded
        }).length,
      },
    },
  }))

  /**
   * 启用或停用一个扩展。
   *
   * ## 「启用」为什么要写进额外名单
   *
   * 默认装载名单是代码常量。对一个**本来没装**的包，把开关打开只删掉
   * 停用记录是不够的——它仍然不在装载名单里，下次启动照样不装，用户会
   * 看到开关开着、能力没有。所以「打开」必须同时写进 `extra`。
   *
   * ## 为什么核心链成员不能停
   *
   * 它们提供的是别的包在**启动时**就 `ctx.get` 的服务键。停掉不会报错，
   * 只会让一批能力静默降级——那是最难归因的一类故障。这里直接回 409，
   * 并把原因写清楚；界面同时把那个开关置灰。
   *
   * ## 为什么返回 `restartRequired: true`
   *
   * 本次进程不卸载插件（理由同上）。如实说出来，比让用户以为「关了但没用」
   * 或者「关了却还在跑」都好。
   */
  routes.set('POST /api/plugins/:id/toggle', async (request: RouteRequest) => {
    // `params` 的值在类型上是 `string | undefined`（开了 noUncheckedIndexedAccess）。
    // 模式匹配保证了它存在，但类型层要显式兜一下，避免把 undefined 传进 Set。
    const id = request.params['id'] ?? ''
    if (id === '') return { status: 400, body: { error: '缺少扩展 id' } }
    const row = plugins.rows.find((item) => item.id === id)
    if (row === undefined) return { status: 404, body: { error: `没有这个扩展：${id}` } }

    const body = (request.body ?? {}) as Record<string, unknown>
    const enabled = body.enabled !== false
    if (!enabled && plugins.core.has(id)) {
      return { status: 409, body: { error: '核心链成员不能停用：停掉不会报错，只会让一批能力静默降级' } }
    }

    if (enabled) {
      plugins.switches.disabled.delete(id)
      // 已经装着的（或核心成员）本来就在名单里，不必再写进额外名单。
      if (!row.loaded && !plugins.core.has(id)) plugins.switches.extra.add(id)
    } else {
      plugins.switches.extra.delete(id)
      plugins.switches.disabled.add(id)
    }
    await writePluginSwitches(plugins.switchFile, plugins.switches)
    pushSystemLog('info', `扩展 ${id} → ${enabled ? '启用' : '停用'}（下次启动生效）`)
    return { body: { ok: true, id, enabled, restartRequired: true } }
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
    /*
     * `proactive: true` 表示这一轮是**她主动开口**，用户没有输入。
     *
     * 与普通回话走同一条链路（同一个 RPC、同一套事件、同一份落盘），
     * 差别只有两点：① 不追加用户消息；② 多带一句只有本次运行存在的
     * 临时提示（`nudge`），否则模型会接着自己上一句自说自话。
     *
     * 为什么把判据放在宿主而不是界面：界面拿到的只是一句「可以了」，
     * 它没有理由知道九道闸。反过来，界面上任何一处 `if (可以)` 都是
     * 一份会漂移的旁路判据。
     */
    const proactive = body.proactive === true

    /*
     * 由头：界面从 `POST /api/proactive/check` 拿到的 `text`，原样带回来。
     *
     * 为什么不在这里自己再取一次话由：那会出现「判定时说的是 A，生成时
     * 由头成了 B」——`plan()` 每次调用都可能因为新的待办而选出不同的候选。
     * 界面已经把判定那一刻的由头拿到了，就该用同一句。
     *
     * 长度夹到 120 字：它进模型上下文，一句由头不该比一轮对话还长。
     */
    const nudgeHint = typeof body.nudge === 'string' ? body.nudge.trim().slice(0, 120) : ''

    const input_ = input.trim()
    if (input_ === '' && !proactive) {
      return { status: 400, body: { error: '内容不能为空' } }
    }

    let sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    /*
     * 主动开口必须已有会话：没有历史时「她主动开口」没有任何上下文，
     * 说出来的必然是空话，而且会凭空造出一个用户没打开的会话。
     */
    if (sessionId === '' && proactive) {
      return { status: 400, body: { error: '还没有对话，她没法主动开口' } }
    }
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

    /*
     * 结算一次「换了一场会话，上一场的心情还剩多少」。
     *
     * ## 为什么在这里，在装配系统提示词之前
     *
     * 顺序错了会把刚发生的事一起衰减掉，也会让她拿旧语气说话：
     *
     * ```
     * 错：这一轮的情绪事件 → 弥散 ×0.4        （这轮的起伏被抹平）
     * 错：装配提示词 → 弥散                    （这轮的语气用的是上一场的余温）
     * 对：弥散 → 装配提示词 → 这一轮的情绪事件
     * ```
     *
     * 六态、语域、句长系数都从心情读（§3.2 → §4.3），所以弥散必须是
     * **这一轮读心情之前的最后一次写**。
     *
     * ## 为什么每轮调用一次，而不是「检测到换了会话才调」
     *
     * 宿主这一层**不知道**什么算一场会话。那个判断归插件的 `minGapMinutes`
     * （默认 30 分钟，手册未给数，是工程取值）：不足 30 分钟算同一场、
     * 返回 `no-gap` 什么都不做；超过才真弥散。若在这里再写一份「多久算换场」，
     * 设置页里那个 `min-gap-minutes` 就只能改得动其中一处——两处真源里
     * 通常漂的那一处，恰好是用户能改的那一处。
     *
     * 也就是说：**每轮问一次，绝大多数轮次得到的答案是「不用弥散」。**
     * 那不是浪费，那是把判据留在它该在的地方。
     *
     * ## 为什么吞掉异常
     *
     * 弥散是附带动作。它的服务缺席、算不出、写不进，都不该让这一轮对话
     * 发不出去——`diffuseAcrossSessions()` 内部已经做过一层兜底，
     * 这里再兜一层是防它自己出意外（比如 `ctx.get` 抛）。
     */
    diffuseSeq += 1
    try {
      diffuseAsked += 1
      const outcome: DiffuseOutcome = diffuseAcrossSessions(
        ctx,
        boundaryKeyOf(finalSessionId, diffuseSeq),
      )
      /*
       * 只报「真的发生了什么」。
       *
       * `no-gap` / `already` 是每分钟都在发生的正常状态，逐个打日志会把
       * stderr 淹掉，于是真正该看的那一行也没人看（本仓在配额那一支踩过：
       * `放行（今日主动 0/3）` 这类内部账本刷满日志，判据反而看不见）。
       */
      if (outcome.written) {
        process.stderr.write(
          `[host] 情绪弥散：心情 ${outcome.moodBefore.toFixed(3)} → ${outcome.moodAfter.toFixed(3)}`
          + `（${outcome.note}）\n`,
        )
      } else if (outcome.status === 'absent' || outcome.status === 'write-failed') {
        // 这两种是「本该弥散却没能弥散」，必须说得出来。
        process.stderr.write(`[host] 情绪弥散没做成：${outcome.note}\n`)
      }
    } catch (error) {
      process.stderr.write(`[host] 情绪弥散异常（本轮跳过）：${String(error)}\n`)
    }

    /*
     * 装配本轮的系统提示词（人格 + 器官片段）。
     *
     * ## 为什么在这里装配，而不在 `stream` 回调里
     *
     * `stream` 是响应体真正开始写出去之后才调用的。装配要读两个插件服务，
     * 其中人格装配是**每次几百字符的字符串拼接**，放在 `stream` 里会让
     * 「已经发出 200、却迟迟没有第一个字节」的空窗变长——用户看到的是
     * 点了发送之后界面先卡一下。
     *
     * 更重要的是：装配失败不该让整轮对话发不出去。`assembleSystemPrompt`
     * 吞掉插件异常并记进 `missing`，返回空串时内核就不加 system 消息——
     * 退化成「没有人格但能说话」，而不是「报错、一个字都不回」。
     *
     * ## 为什么每轮都重取，不缓存
     *
     * 预算、浓度、关系、执念都可能在两轮之间变化。缓存会让「改了设置没反应」
     * 以一种最难查的方式复现：不报错、界面照常、只是她说话不像她了。
     */
    const systemPrompt = assembleSystemPrompt(ctx, input_ === '' ? undefined : input_)
    /*
     * 数一数「这一轮的情绪块真的拼进去了」。
     *
     * ## 为什么要在调用点另记一个数
     *
     * 插件自己的 `counters.projects` 只说「`project()` 被调过几次」，
     * 它**证明不了那段文本进了提示词**——装配那一处完全可能取到投影、
     * 然后把它丢掉。本仓在 `asked` 那一格栽过一次同族（计数器统计在调用
     * 之外，删掉调用它照涨），所以这里两个数分开：
     *
     * - `project.counters.projects`：投影产出了几次（插件报的）；
     * - `emotionApplied`：其中有几次**真的成了系统提示词的一段**（宿主报的）。
     *
     * 两者长期不等，说明装配线断了——而这两种情形的日志完全一样。
     */
    if (systemPrompt.parts.some(part => part.id === 'emotion')) emotionApplied += 1
    if (systemPrompt.parts.some(part => part.id === 'context')) contextApplied += 1
    if (systemPrompt.missing.length > 0) {
      // 写 stderr 而不是 stdout：stdout 是壳的协议通道，混进去壳就解析不了。
      process.stderr.write(`[host] 系统提示词缺项：${systemPrompt.missing.join('；')}\n`)
    }
    if (systemPrompt.truncated) {
      /*
       * 人格被预算裁过。这不是错误，但必须说出来。
       *
       * 默认预算已调到 12000（2026-11-08 第二十段），出厂人设不再触发这一行。
       * 它现在只在两种情况下出现：① 用户自己把预算调低了；② 换了一个远超
       * 12000 字的人设包。两种情况下用户能感知到的都只有「说话不像」，
       * 而装配代码全都不报错——这一行日志是唯一的线索。
       */
      process.stderr.write(
        `[host] 人格未完整加载（${String(systemPrompt.chars)} 字，已被预算裁剪）：`
        + '可在设置里把「人格预算」调高，或换一份更短的人设包\n',
      )
    }

    return {
      stream: async (emit: StreamEmitter) => {
        emit.send('session', { sessionId: finalSessionId })

        /*
         * 开口前的半拍。
         *
         * ## 为什么算在**第一帧正文之前**
         *
         * `firstDelay()` 的语义是「她读完了，过多久开始回」，与正文长度无关——
         * 它该被问的时刻就是第一个字出现之前。
         *
         * 上一版在 `inference.run` 返回之后才睡这半拍：那时全部正文早已
         * 流式显示完，再停两秒不是「她想了想才开口」，而是「最后一句卡住了」。
         * 观感正好相反。详见 `src/rhythm.ts` 的 `planFirstWord()`。
         */
        const firstWord = planFirstWord(ctx)
        /** 首帧是否已经放过（半拍走完）。 */
        let firstWordSent = false
        /**
         * 首帧之后的排队链。
         *
         * `onEvent` 是同步回调，`await` 会阻塞内核的事件派发（思考帧也会
         * 跟着卡住）。所以把「等半拍 → 发首帧」丢进这条链，
         * 后续帧挂在链尾——顺序与内容都保持原样。
         */
        let deltaChain: Promise<void> = Promise.resolve()

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
          /*
           * 首帧**先压住**，等半拍走完再放出去。
           *
           * ## 为什么是「压住」而不是「丢掉」
           *
           * 丢掉会让她少说第一个字——那是最难被发现的一类错（读起来通顺，
           * 只是少一个字）。这里只延后发出，内容一个字不少。
           */
          const frame = { text: params.text }
          if (!firstWordSent) {
            firstWordSent = true
            deltaChain = (async () => {
              /*
               * 先报阶段、再等。
               *
               * ## 为什么必须按这个顺序
               *
               * 反过来的话，那半拍里界面什么都没有：气泡是空的、三点也没亮
               * （正文还没来，`pending` 的那条消息还没有内容可显示）。
               * 用户看到的是「按了发送，一秒半毫无反应」。
               *
               * 先发 `presence` 帧，界面立刻把她标成「正在打字」，
               * 这一秒半就成了「她在想怎么回」——同一段等待，两种观感。
               */
              if (firstWord.status === 'planned' && firstWord.holdMs > 0) {
                emit.send('presence', presenceOf(ctx, finalSessionId, 'thinking'))
                await pause(firstWord.holdMs)
              }
              emit.send('delta', frame)
              emit.send('presence', presenceOf(ctx, finalSessionId, 'typing'))
            })()
            return
          }
          deltaChain = deltaChain.then(() => {
            emit.send('delta', frame)
          })
        })
        try {
          const result = await client.call('inference.run', {
            sessionId: finalSessionId,
            ...(input_ === '' ? {} : { input }),
            /*
             * 系统提示词每轮都传。空串时不传——内核据此不加那条 system 消息，
             * 而不是加一条空的（空 system 消息会让某些供应商直接 400）。
             */
            ...(systemPrompt.text === '' ? {} : { system: systemPrompt.text }),
            ...(proactive ? { nudge: nudgeFor(nudgeHint) } : {}),
          }) as {
            text?: unknown
            aborted?: unknown
          }
          const raw = typeof result.text === 'string' ? result.text : ''
          /*
           * 先过九步过滤，再塑形。**顺序不能反。**
           *
           * ## 为什么过滤必须在塑形之前
           *
           * 九步里有八步靠 `splitSentences()` 断句，句号是它唯一的边界依据；
           * 而 `ondra-oral` 干的第一件事就是「去掉句末句号、省主语」。
           * 先塑形再过滤，过滤看到的是一段没有句号的文本——
           * 「删掉第三句旁白」无从判起，`strip-draft` / `service-tone` 也跟着失准。
           * 症状极具误导：过滤链装了、`runs` 在涨、几乎从不命中，
           * 面板上读起来像「她本来就很干净」。
           *
           * ## 为什么在中止的轮次里也不过滤
           *
           * 与塑形同一条判据：用户按了停止，他要的是「就到这里」。
           * 被截断的半句再过一遍删句，会删得更碎。
           *
           * ## 为什么用 `filtered.text` 而不是 `raw` 喂塑形
           *
           * 三条下游（`done` / `publishTurn` / `speakReply`）必须共用同一个值：
           * 用原文写库、用过滤后的念，就是「她记得自己说过那句旁白」。
           */
          const filtered = raw === '' || result.aborted === true
            ? undefined
            : filterReply(ctx, raw, input)
          /*
           * 塑形一次，之后三条路共用同一个字符串。
           *
           * ## 为什么必须在这里（发 `done` 之前）
           *
           * 界面用 `done` 里的完整文本**覆盖**流式正文（`useAppState.ts` 的
           * `onDone`）。塑形放在 `done` 之后，就会出现「界面上是原文、
           * 记忆里和耳朵里是改过的」——两处不一致，且谁都看不出来。
           *
           * ## 为什么 `publishTurn()` 与 `speakReply()` 也必须用塑形后的那句
           *
           * 它们描述的是「她说了什么」。用原文写库、用改过的念，就会变成
           * 「她记得自己没说过的话」；而我们刚刚才把记忆链接上，不能在这里
           * 埋一个反向偏差。三条路共用一个值是这件事唯一正确的形态。
           *
           * 中断的轮次不塑形：半句话被省掉主语会更难读，而且用户按了停止键，
           * 他要的正是「就到这里」。
           */
          const base = filtered?.text ?? raw
          const shaped = base === '' || result.aborted === true
            ? undefined
            : shapeReply(ctx, base, finalSessionId)
          const reply = shaped?.text ?? base
          /*
           * 只**数**分几条，不再在这里停。
           *
           * ## 为什么这一格只剩记账
           *
           * 分条的本义是发多条消息，而本应用是单窗单气泡、正文早已流式
           * 显示完——把显示过的字收回去再重打一遍是纯粹的倒退
           * （40 字/条、6 字/秒，一段 200 字要多等 20 秒）。
           *
           * 但「不拆发」不等于「不计算」：`rhythm.stats().turns` 与
           * `typing.schedule()` 的分条账是她会不会分条说话的唯一证据。
           * 不算的话面板上永远 0，读起来像插件没接线——而其实接得很好，
           * 只是这个形态不拆气泡。详见 `src/rhythm.ts` 的 `planPieces()`。
           */
          if (raw.trim() !== '' && result.aborted !== true) planPieces(ctx, reply)
          /*
           * 先把正文队列排空，再发 `done`。
           *
           * ## 为什么必须等
           *
           * 首帧被压在那条链上时，`done` 完全可能先发出去——`inference.run`
           * 返回不等 `onEvent` 的异步尾巴。界面收到 `done` 就用完整文本
           * 覆盖正文、把 `pending` 关掉；随后迟到的那一帧 delta 会追加到
           * 已经定稿的气泡上，正文变成「完整回复 + 第一个字」。
           *
           * 顺序错乱只在「首帧半拍还没走完、而模型已经吐完」时出现，
           * 短回复 + 慢模型时最明显，因此线上极难复现。等一次链尾最稳。
           */
          await deltaChain
          emit.send('presence', presenceOf(ctx, finalSessionId, 'idle'))
          emit.send('done', {
            text: reply,
            aborted: result.aborted === true,
          })
          /*
           * 把这一轮交给插件总线（`session/event`）。
           *
           * ## 为什么必须在这里，且必须在 `emit.send('done')` 之后
           *
           * `session/event` 在整仓里长期只有订阅方、没有发出方，于是
           * `ondra-memory-intake` 的草稿永远是空的——六张表从建库起一直是 0 行，
           * 而所有单元级检查都绿（它们各自直接调 `intake.ingest()`，绕过了
           * 「谁触发」这一环）。这是「A 写、B 读、中间少根线」的又一次实证。
           *
           * 放在 `done` 之后：用户先看到她的回答，记忆落库是附带动作。
           * 放之前会让首字节后的收尾多等一次同步派发（监听器是同步跑的）。
           *
           * ## 为什么 `input` 为空时不发
           *
           * 主动开口那一轮用户没说话，只有她自己的一句。照发的话记忆链会把
           * 她的自言自语当成用户交代的事去提炼——`SELF` 来源的事实在召回时
           * 会变成「她记得自己说过什么」。判据交给 `publishTurn` 内部判，
           * 这里不写第二份。
           */
          publishTurn(ctx, {
            sessionId: finalSessionId,
            input,
            reply,
          })
          /*
           * 念出来。
           *
           * ## 为什么在 `publishTurn()` 之后
           *
           * 记忆落库是这一轮真正的收尾；朗读是附加层。顺序颠倒的话，
           * 一句要念三秒的话会把记忆写入推后三秒，而记忆写入的时序
           * 又被召回链依赖——两件事不该互相排队。
           *
           * `speak()` 本身会等播放结束才 resolve（`Player.play` 是阻塞的），
           * 所以这里**必须**用 `void` 起一条独立的异步支路：不 await，
           * 否则整个 `stream()` 回调会多等三五秒，而 `done` 帧早就发出去了，
           * 界面那头表现为「说完了但不让我继续打字」。
           *
           * ## 为什么只念「用户真说了话」的那一轮
           *
           * 主动开口那一轮（`input` 为空）也有 `reply`，念它是对的——
           * 她主动开口时更需要出声，否则用户根本没注意到。所以这里不跟
           * `recordTurn` 用同一条判据，只要求 `reply` 非空。
           *
           * 异常已在 `speakReply()` 内部吞掉并记 stderr；外面再兜一层是防
           * 它自己出意外（`ctx.get` 抛、Promise 被拒）。
           */
          if (reply.trim() !== '') {
            void speakReply(ctx, reply).then(
              (outcome) => {
                /*
                 * 只报「本该出声却没出声」。
                 *
                 * `held`（闸门拦下）是每分钟都在发生的正常状态，逐条打日志
                 * 会把 stderr 淹掉，于是真正该看的那几行也没人看。`off`
                 * 是用户自己的选择。只有 `failed` 与「服务缺席」值得一行。
                 */
                if (outcome.status === 'failed') {
                  process.stderr.write(`[host] 朗读没做成：${outcome.reason ?? 'unknown'}\n`)
                } else if (outcome.status === 'absent') {
                  process.stderr.write('[host] 朗读跳过：语音插件没装载\n')
                }
              },
              (error: unknown) => {
                process.stderr.write(`[host] 朗读异常（本轮跳过）：${String(error)}\n`)
              },
            )
          }
          /*
           * 推进一轮关系（记互动 + 判升阶）。
           *
           * ## 为什么也在这一个位置，且同样只在「用户真说了话」时
           *
           * `ondra-emotion-stage` 的三个写入口（`touch` / `adjust` / `observe`）
           * 此前**全仓零调用方**：`interactions` 恒 0 → `familiarity` 恒 0 →
           * 弥散公式里 `(1 − familiarity × 0.5)` 那段白写；七阶永远停在敌意。
           * 而 0 是「陌生人」这个合法取值，所以没有任何一处会报错。
           *
           * 主动开口那一轮不算「相处了一轮」：判据与 `publishTurn` 同一条，
           * 由 `recordTurn` 的调用点承担（这里不传空 input 的轮次）。
           *
           * 顺序也重要：必须先 `touch()` 再 `observe()`。反过来第一轮会因为
           * 「互动 0 次」卡在二阶闸上，症状是「升阶总慢一轮」。
           *
           * 异常吞掉：关系推进是附带动作，不该让一次成功的对话变成失败。
           */
          if (input.trim() !== '') {
            try {
              const relation = recordTurn(ctx)
              if (!relation.present && relation.note !== '') {
                // 「本该推进却没推进」必须说得出来，否则又是静默降级。
                process.stderr.write(`[host] 关系推进没做成：${relation.note}\n`)
              }
            } catch (error) {
              process.stderr.write(`[host] 关系推进异常（本轮跳过）：${String(error)}\n`)
            }
            /*
             * 把「相处了多久」对齐给人格演化。
             *
             * ## 为什么必须在 `recordTurn()` 之后
             *
             * 真源是关系插件的 `touch()`，它刚刚在这一轮 +1。排在前面的话
             * 每轮都会差 1，而差额对齐是**每次补到真源**，于是每轮补一次
             * 上一次的量——镜像永远落后一轮，症状是「阈值总比关系慢一拍」。
             *
             * ## 为什么不是每轮 `noteInteraction(1)`
             *
             * 那样两处从不同起点各自累加，历史（关系可能已经记了 200 轮，
             * 而演化刚从 0 起步）永远补不上，且两处迟早漂开。差额对齐让
             * 「装上的那一刻」就把历史补齐，之后差额自然是 0 或 1。
             *
             * 异常吞掉：对齐是附带动作，不该让一次成功的对话变成失败。
             */
            try {
              const synced = syncEvolveInteractions(ctx)
              if (synced.drifted) {
                // 镜像超前是真源被换过 / 重建过的信号，必须说得出来。
                process.stderr.write(`[host] 人格演化计数异常：${synced.note}\n`)
              }
            } catch (error) {
              process.stderr.write(`[host] 人格演化对齐异常（本轮跳过）：${String(error)}\n`)
            }
          }
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

  /**
   * 主动开口：判一次「此刻能不能说」。
   *
   * 判据全部来自 `ondra-proactive-gate`（九道闸的唯一真源），这里只做
   * 形状翻译与缺席说明。为什么是 `POST` 而不是 `GET`：它会**消耗额度**
   * （放行即记账），不是幂等读取。写成 `GET` 会让任何预取、重试、
   * 浏览器历史回放都悄悄吃掉一次额度。
   */
  routes.set('POST /api/proactive/check', async (request: RouteRequest) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    /*
     * 先取话由，再把由头当正文交给门控。
     *
     * 两件事必须按这个顺序：
     * ① 门控的**内容闸**与**去重闸**看的都是正文。若先判定、后换正文，
     *    去重看到的是一个永远相同的占位串，于是第一条之后全部判成重复——
     *    症状是「她只主动说过一次」。
     * ② 用户看到的那行「她主动开口 · {判据}」应当说清**为什么是这件事**，
     *    而不是「放行（今日主动 1/3）」。后者是内部记账，不是解释。
     *
     * 拿不到话由时不编兜底句：没由头就不开口，比为了开口随便说一句好。
     */
    const reason = ctx.get('ondra-proactive-reason') as ReasonLike | undefined
    const idle = typeof body.idleMinutes === 'number' && Number.isFinite(body.idleMinutes)
      ? Math.max(0, Math.trunc(body.idleMinutes))
      : undefined

    /*
     * 先问一次「心里那件事压得住吗」，再把结论递给话由。
     *
     * ## 为什么这一问必须在这里，且必须在 `takeReason` 之前
     *
     * 「执念」在话由优先级里排第一，且排序是字典序——只要池里有一条 open，
     * 它就压过所有承诺与待办。而 `open()` 默认张力 40，离唤醒线 80 差一半。
     * 不先问这一句，症状是：用户刚说了一句让她答不上来的话，她立刻拿这件
     * **刚出生、并不压人**的事开口，把「答应过明天打印合同」全压到后面。
     *
     * 判据本身不在这里写（那是 `ondra-drive-gap` 的四条件），这里只递结论。
     */
    const gap = ctx.get('ondra-drive-gap') as DriveGapLike | undefined
    const gapEligible = gapEligibleFor(gap, idle)
    const taken = takeReason(reason, gapEligible)

    /*
     * 没有由头、调用方也没给正文时，正文就是**空串**——不编兜底句。
     *
     * 以前这里兜一句「想找你聊聊」。代价不是「多说了一句废话」，而是
     * 它是一个**常量**：去重闸（30 分钟窗口、最短 4 字）会把它当成
     * 同一句话，于是半小时内的第二次主动开口一律判重复，症状正是
     * `checkProactive()` 契约里写的那种「她只主动说过一次」。同时那句
     * 占位还会被当成由头塞进模型上下文（`nudgeFor()` 拼在「这次想提的事」后面），
     * 让她照着「想找你聊聊」这句空话去组织语言。
     *
     * 空串交给门控自己判：它按 `content-empty`（空气泡）拒掉，
     * 但额度、剩余、冷却这些真实数值仍照常回给界面——界面拿到的
     * 结论与我在这里拍一个 `allow:false` 相同，数字却是真的。
     */
    const text = taken?.text
      ?? (typeof body.text === 'string' ? body.text.trim() : '')

    const gate = ctx.get('ondra-proactive-gate') as GateLike | undefined
    const quota = ctx.get('ondra-proactive-quota') as QuotaLike | undefined
    const verdict = checkProactive(gate, quota, sessionId, idle, text)

    /*
     * 放行即记冷却。
     *
     * 为什么在宿主记而不是在插件里：只有宿主知道「这一次真的要说出去了」。
     * 插件内部记的话，任何一次 `plan()` 都会把候选打进冷却——而 `plan()`
     * 是可以被面板反复调的。
     */
    if (verdict.allow && taken !== undefined && reason !== undefined) {
      try {
        reason.markUsed(taken.topic)
      } catch {
        // 冷却记不上只影响「三天内可能再说一次」，不该让这条消息发不出去。
      }

      /*
       * 执念这一支还要回写池子：`picks + 1`、刷新 `lastWakeAt`。
       *
       * 为什么单独一处而不是合并进 `markUsed`：两者记的**不是同一件事**。
       * 话由的冷却防「同一件事三天内说两遍」，是内容维度；
       * 执念的 `lastWakeAt` 防「一分钟内被同一件事叫醒两次」，是节律维度。
       * 合并成一处，就会出现「换了一条由头，唤醒冷却也跟着清零」——
       * 于是她在一小时里说了四件不同的事，全都不受节律约束。
       *
       * 只在 `kind === 'gap'` 时写：`taken.key` 对其他种类是承诺 id / 待办 id，
       * 拿去 `markDelivered` 会被池子当成「没有这条」而静默返回 false。
       */
      if (taken.kind === 'gap' && gap !== undefined) {
        try {
          gap.markDelivered(taken.key)
        } catch {
          // 记不上只影响下次被判「还没说过」，不该让这条消息发不出去。
        }
      }
    }

    /*
     * 把由头一并回给界面。
     *
     * `reason` 字段原本透传门控的 `detail`（「放行（今日主动 1/3）」）。
     * 有由头时换成**由头本身**，因为界面那行字问的是「她为什么此刻开口」，
     * 不是「额度还剩几条」。没有由头时才退回门控的说明——那时它确实是
     * 唯一能解释「为什么放行/为什么拦」的信息。
     */
    return {
      body: taken === undefined
        ? verdict
        : Object.freeze({
            ...verdict,
            reason: taken.label,
            text: taken.text,
          }),
    }
  })

  /** 主动开口：用户点了「这次不用」。 */
  routes.set('POST /api/proactive/decline', (request: RouteRequest) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const gate = ctx.get('ondra-proactive-gate') as GateLike | undefined
    declineProactive(gate)
    logInfo(ctx, `主动开口被撤回${sessionId === '' ? '' : `（会话 ${sessionId}）`}`)
    return { body: { ok: true } }
  })

  /** 模型列表。 */
  routes.set('GET /api/models', async () => {
    const client = getDsh(ctx)
    return { body: await client.call('model.list', {}) }
  })

  /**
   * 记忆清单（只读）。
   *
   * ## 为什么这条路由迟到
   *
   * 界面「记忆」面板从建库起一直显示「聊两句就有了」——而库里当时已有
   * 8～11 条事实。根因不在渲染，也不在数据：**中间根本没有一条能列出事实的
   * 接口**，前端那个 `deriveMemories()` 于是硬编码 `return []` 收场。
   * 一个从没接通的东西，在界面上与「还没有记忆」长得一模一样，
   * 而它的注释还振振有词地说「不要用会话原文冒充记忆」——文档正确，
   * 实现缺席，这种组合最难被察觉。
   *
   * ## 排序按 `salience` 而不是时间
   *
   * 面板要回答的是「她记住了什么」，不是「最近写了什么」。按时间倒序会把
   * 同一轮里提炼出的三条并列在前，看起来像流水账；按显著度降序才让
   * 「你搭档叫阿岚」排到「今天天气不错」上面。
   *
   * 内核的 `orderBy: 'salience'` **只按显著度排，没有二级键**，所以同分的行
   * 之间顺序由存储层决定，不保证稳定。界面这一层是无翻页的一次性列表，
   * 顺序抖动只影响「并列项谁在前」，不影响可见集合——因此不为此在宿主重排。
   * 将来若要做翻页，必须先给内核补二级排序键，不能在这里用 `Array.sort`
   * 假装稳定（那会让 offset 翻页漏行）。
   *
   * 只读，不含密钥，不触发模型调用。
   */
  routes.set('GET /api/memory', (request: RouteRequest) => {
    interface MemoryPort {
      readonly available?: boolean
      listFacts(query?: Record<string, unknown>): readonly MemoryRecordLike[]
      countFacts(query?: Record<string, unknown>): number
    }
    interface MemoryRecordLike {
      readonly id: string
      readonly kind: string
      readonly category: string
      readonly text: string
      readonly summary: string | null
      readonly salience: number
      readonly createdAt: number
      readonly lastSeenAt: number
      readonly important: boolean
      readonly archived: boolean
    }
    const service = ctx.get('ondra-memory-core') as MemoryPort | undefined
    if (service === undefined || service.available !== true) {
      // 内核缺席 ≠ 没有记忆。前端据此区分「读不到」与「确实为空」。
      return { body: { items: [], total: 0, reason: 'no-memory-core' } }
    }
    const query = request.query ?? {}
    const rawLimit = Number(query['limit'] ?? 60)
    // 上限 200：这是界面列表，不是导出。开太大只会让一次请求扫全表。
    const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.trunc(rawLimit))) : 60
    const needle = typeof query['q'] === 'string' ? query['q'].trim().toLowerCase() : ''
    let rows: readonly MemoryRecordLike[]
    try {
      rows = service.listFacts({ orderBy: 'salience', limit: needle === '' ? limit : 200 })
    } catch (error) {
      logInfo(ctx, `记忆清单读取失败：${String(error)}`)
      return { body: { items: [], total: 0, reason: 'list-failed' } }
    }
    /*
     * 搜索在宿主侧做，不用 `FactQuery`：它没有文本条件（相关性排序是召回插件
     * 的事，不是内核的事）。在这里 `includes` 一遍是最小实现——数据量是几百条
     * 量级，而给内核加一个只有界面用的查询字段，等于把 UI 需求塞进领域接口。
     */
    const matched = needle === '' ? rows : rows.filter(row => row.text.toLowerCase().includes(needle))
    return {
      body: {
        total: service.countFacts(),
        items: matched.slice(0, limit).map(row => ({
          id: row.id,
          text: row.summary !== null && row.summary !== '' ? row.summary : row.text,
          kind: row.kind,
          category: row.category,
          salience: row.salience,
          createdAt: row.createdAt,
          lastSeenAt: row.lastSeenAt,
          important: row.important,
        })),
      },
    }
  })

  /**
   * 记忆链诊断（只读）。
   *
   * ## 为什么需要这条路由
   *
   * 「`memory_fact` 一直是 0」这件事，排查时**每一层都说是好的**：
   * 提炼器 `available=false` 但没人问它；网关 `sources` 空数组但那是合法默认；
   * 内核插件装载成功。链路上任何一环断掉，症状完全相同（下游恒空），
   * 而每一环的原因码都藏在自己的 `stats()` 里。
   *
   * 所以这里把四层的**原因码**并排吐出来。它不修复任何东西，
   * 只回答「现在断在哪一层」——这正是本仓反复踩的那类坑的唯一解药：
   * 「上游缺席」与「上游没被写」必须能被区分开。
   *
   * 只读，不含密钥，不触发任何模型调用。
   */
  routes.set('GET /api/diagnostics/memory', () => {
    /** 插件服务的 `stats()` 形状：只取我们要的那几个字段。 */
    interface ProbeLike {
      readonly available?: boolean
      readonly reason?: string
      stats?(): Record<string, unknown>
    }
    const probe = (key: string): Record<string, unknown> => {
      const service = (ctx as unknown as Record<string, unknown>)[key] as ProbeLike | undefined
      if (service === undefined) return { present: false, reason: 'not-loaded' }
      let stats: Record<string, unknown> | undefined
      try {
        stats = typeof service.stats === 'function' ? service.stats() : undefined
      } catch (error) {
        // 状态查询本身失败也要说得出来，不能让它把整条诊断拖垮。
        return { present: true, error: String(error) }
      }
      return {
        present: true,
        available: service.available,
        reason: service.reason ?? stats?.['reason'],
        stats: stats ?? null,
      }
    }
    return {
      body: {
        // 网关：有它、有 sources、有上游 `llm`，三者缺一即 no-gateway 一族。
        gateway: probe('ondra-llm-gateway'),
        // 提炼器：它自己的 stats 会给出 calls / succeeded / failed / factsWritten。
        extract: probe('ondra-memory-extract'),
        // 采集器：看它到底有没有收到轮次（turns）与提炼返回（facts）。
        intake: probe('ondra-memory-intake'),
        memory: probe('ondra-memory-core'),
        /*
         * 注入装箱：八块里到底哪几块产出了正文。
         *
         * 为什么非要这一格：`loadedPlugins` 只回答「装了几个包」，
         * 而「八块记忆里有几块真的进了提示词」是**另一个问题**。四个可选块
         * 提供方（recall / audit / humanlike / decay）缺席时，装箱照常渲染、
         * 照常返回正文字符数，只是少了几个标题——两侧都不报错。
         *
         * `stats.sources` 是逐块的可达性，`lastItems` 是上一次装箱实际收进来的
         * 条目数。前者说「能不能拿」，后者说「拿到了没有」，两个数分开才有意义：
         * 只有前者为真而后者为 0，才说明是**记忆为空**而不是接线断了。
         */
        inject: probe('ondra-prompt-inject'),
        /*
         * 记忆图谱：边表到底建了几条边。
         *
         * 为什么要单开这一格：图谱接上了没有，**只有这一个数能回答**。
         * 它的 `available` 恒为 true（存储缺席时才 false），`relatedness()`
         * 在边表为空时也只是静默返回空映射，召回侧于是把图谱因子整项退出
         * 归一化——分母从 1.00 降到 0.89，其余一切照常。两侧都不报错。
         *
         * 而「边表 0 行」有两种成因，必须分开：
         *
         * | 成因 | `edges` | `links.refused` | 该查什么 |
         * | --- | --- | --- | --- |
         * | 还没有一轮出过两条以上事实 | 0 | 0 | 换一句信息密度高的话再说一轮 |
         * | 建边被拒（端点 id 不合规 / 自环） | 0 | >0 | 看 `lastIssue`，那是拒因 |
         *
         * 没有这一格时，上面两种都与「图谱没装」同形——本仓反复踩的形态。
         */
        graph: probe('ondra-memory-graph'),
        /*
         * 判重：**它决定了「同一句话被记几遍」**，而这在界面上完全看不出来。
         *
         * 两条事实各写一份、与一条事实 `times_said=2`，右栏显示的都是
         * 「记得两件事」。唯一能分辨的数是 `counters` 里那五个动作的分布：
         *
         * | 现象 | 该读哪个数 | 说明 |
         * | --- | --- | --- |
         * | 装了但 `merge` / `append` 恒 0 | `counters.settled` | 每次都在 `add`——判重没拿到候选，或候选池是空的 |
         * | `settled` 恒 0 而 `factsWritten` 在涨 | `counters.settled` | **写入路径没接上**，走的还是 `extract()` 直写 |
         * | `logRows` 0 而 `settled` 在涨 | `stats.logRows` | 判定在跑，但没有存储端口落决策日志 |
         *
         * 第二行是本轮修的那个断裂：`propose()` / `settle()` 此前全仓零调用方，
         * 判重服务注册着、`available` 是 true、`stats()` 一切正常，唯独
         * `settled` 永远是 0。**只看 `available` 会得出「判重工作正常」的错误结论。**
         */
        dedupe: probe('ondra-memory-dedupe'),
        // 上游 `llm` 服务在不在：这一格是 false 时，网关恒不可用。
        llmProvided: (ctx as unknown as Record<string, unknown>)['llm'] !== undefined,
      },
    }
  })

  /**
   * 情绪弥散诊断（只读）。
   *
   * ## 为什么单独一条，而不是并进 `diagnostics/memory`
   *
   * 记忆那三层（网关 → 提炼 → 采集）是一条**串联**的链，一个断点让下游全空，
   * 所以它们必须并排看。情绪弥散不是那条链上的东西：它的上游是情绪内核，
   * 下游是「下一轮的心情」，中间隔着一道时间闸（`minGapMinutes`）。
   *
   * 并进去的代价很具体：`diagnostics/memory` 的读者是「为什么她记不住」，
   * 而这里回答的是「为什么她一觉醒来还是昨晚那个语气」。两个问题，
   * 两个读者，混在一个响应体里只会让两边都得读一半无关的字段。
   *
   * ## 为什么要暴露 `counters`
   *
   * 四个计数器把「没弥散」拆成了四种互斥的原因，而它们**症状完全相同**
   * （心情不动）。只看 `available` 的话，这四种一律显示「我是好的」——
   * 本仓已经因为这一点白查过四轮。
   *
   * | 计数器 | 含义 | 读者该做什么 |
   * | --- | --- | --- |
   * | `claims` | 真弥散了 | 正常 |
   * | `duplicates` | 同边界重复调 | 键生成错了 |
   * | `tooSoon` | 间隔不足 | 正常（同会话） |
   * | `noEmotion` | 情绪内核不可用 | 去查 `diagnostics/memory` |
   */
  /**
   * 声音链状态：合成通道 + 闸门 + 宿主这一侧接没接上。
   *
   * ## 为什么必须有这条只读探针
   *
   * 「语音不出声」有五种完全不同的原因，而它们**症状一模一样**（安静）：
   *
   * | 原因 | 读者该做什么 |
   * | --- | --- |
   * | 插件没装载 | 查名单 |
   * | 用户关了朗读（`enable=false`） | 去设置里打开 |
   * | 三条通道全不可用 | 装 `edge-tts` 或查 `say` |
   * | 闸门拦下了（句长/情绪/频控/连读） | 正常的节制，不用管 |
   * | 宿主没接线 | 改 `src/voice.ts` |
   *
   * 前四种能用 `note` 一句话分开；第五种由 `ttsLoaded`/`gateLoaded` 都为 true、
   * 而 `note` 为空来反证。不把这五件事分开，就会变成「语音坏了」四个字
   * 被查五轮——本仓在情绪弥散那一支已经吃过一次同样的亏。
   *
   * 只读：不合成、不判定、不动闸门计数。
   */
  routes.set('GET /api/diagnostics/voice', () => {
    return { body: voiceProbe(ctx) }
  })

  /**
   * 口语化状态：插件在不在 + 情绪档到没到 + 真改过几次字。
   *
   * ## 为什么这一格必须与语音那格分开
   *
   * 它们回答的是两个不同的问题：「她说话的**口吻**改了吗」与
   * 「她出声了吗」。合成坏了（`voice.available=false`）时口吻照改；
   * 口吻关掉了（`oral.enable=false`）时声音照出。合成一格会把
   * 「嘴上不像」和「耳朵听不见」说成同一件事，而修法完全不同。
   *
   * `stats.turns` 为 0 是这里唯一能抓到「宿主没接线」的证据：
   * 插件装载正常、`available=true`、`expressReady=true`，但一次都没被调过——
   * 这四种「一切正常却没效果」的形态里最难查的一种。
   */
  routes.set('GET /api/diagnostics/oral', () => {
    return { body: oralProbe(ctx) }
  })

  /**
   * 节奏状态：分条、计时、呼吸三包各自在不在 + 真算过几次。
   *
   * ## 为什么单独一格，且与口吻那格分开
   *
   * 「她嘴里的句子像不像人」与「她说得急不急」是两个问题：
   *
   * | 格 | 问题 | 坏了的表现 |
   * | --- | --- | --- |
   * | 说话口吻 | 句子有没有主语、句号是不是太多 | 像个客服 |
   * | 说话节奏 | 分几条、每条等多久、深夜慢不慢 | 一口气吐完一整段 |
   *
   * 口吻关掉了节奏照跑，合成坏了节奏也照跑。合成一格会把三件事
   * 说成一件，而修法完全不同。
   *
   * ## `rhythm.turns` 为 0 是唯一能抓到「宿主没接线」的证据
   *
   * 三个包都装载、`available` 全 true、配置段读得到，却一次都没被调过——
   * 这正是本轮接入前它们的状态，而在任何面板上都看不出来。
   */
  routes.set('GET /api/diagnostics/rhythm', () => {
    return { body: rhythmProbe(ctx) }
  })

  /**
   * 输出过滤状态：九步链在不在 + 四个上游到没到 + 真跑过几次。
   *
   * ## 为什么这一格是「她说过什么」这一层的唯一读数
   *
   * 前面几格管的是**怎么说话**（口吻 / 节奏 / 出声），这一格管的是
   * **说出来的话对不对**：会不会冒出「作为一个 AI」、会不会重复上一轮那句、
   * 会不会端着客服腔说「您」。四件事都在九步里，而它们的共同特征是
   * **删掉之后读起来仍然通顺**——所以「过滤没跑」与「她本来就很干净」
   * 在界面上完全一样。
   *
   * `stats.runs` 长期为 0 是「宿主没接线」的唯一证据；
   * `runs` 涨而 `lastRemoved` 恒 0 则是「接了但一步都没命中」。
   * 两种都不是错误，但对应完全不同的动作，必须分开看得见。
   *
   * `pending` 一栏如实列出本轮**没做**的两件事（锚点注入、事后评审），
   * 免得读者对着一个绿色的面板以为整条链都通了。
   */
  routes.set('GET /api/diagnostics/filter', () => {
    return { body: filterProbe(ctx) }
  })

  /**
   * 人格这一段：加载器扫到什么 + 内核能不能装出来 + 装不出来卡在哪。
   *
   * ## 为什么这一格必须先有
   *
   * 「她不知道自己是谁」这件事在本仓有三种完全不同的成因，
   * 而三者的外部症状一模一样——人格段是空的，说话仍然通顺：
   *
   * | 成因 | `loader.available` | `core.available` | `core.reason` |
   * | --- | --- | --- | --- |
   * | 加载器没装 / 扫不到包 | false | false | `no-loader` / `no-persona` |
   * | 包在但没 SKILL.md | true | false | `no-skill` |
   * | 内核正常、下游没读 | true | true | — |
   *
   * 第三行是最难查的一种：插件全绿，`filter-chain` 的 `sources.persona`
   * 却是 false，因为过滤器读的是 `available` 而中间少了一根线。
   * 所以这一格必须同时给出**加载器侧**与**内核侧**两套读数，
   * 只给一侧的话，「包没扫到」和「内核没建起来」永远分不开。
   *
   * `activeId` 与 `personas` 并排也是同一个道理：配置写的是 `oh-jingjing`，
   * 而列表里只有 `xia-ningqi` 时，界面上必须能一眼看出是「配错」而不是「包丢了」。
   */
  routes.set('GET /api/diagnostics/persona', () => {
    interface StatsLike {
      readonly available?: boolean
      readonly reason?: string | null
      [key: string]: unknown
    }
    interface LoaderLike {
      readonly available: boolean
      readonly reason?: string
      stats(): StatsLike
      list(): readonly { readonly id: string }[]
      activeId(): string | undefined
    }
    interface CoreLike {
      readonly available: boolean
      readonly reason?: string
      stats(): StatsLike
    }
    const loader = ctx.get('ondra-persona-loader') as LoaderLike | undefined
    const core = ctx.get('ondra-persona-core') as CoreLike | undefined
    let loaderView: Record<string, unknown>
    if (loader === undefined) {
      loaderView = { present: false, reason: 'not-loaded' }
    } else {
      try {
        const stats = loader.stats()
        loaderView = {
          present: true,
          available: loader.available,
          reason: loader.reason ?? stats.reason ?? null,
          activeId: loader.activeId() ?? null,
          personas: loader.list().map(item => item.id),
          stats,
        }
      } catch (error) {
        loaderView = { present: true, error: String(error) }
      }
    }
    let coreView: Record<string, unknown>
    if (core === undefined) {
      coreView = { present: false, reason: 'not-loaded' }
    } else {
      try {
        coreView = { present: true, available: core.available, reason: core.reason ?? null, stats: core.stats() }
      } catch (error) {
        coreView = { present: true, error: String(error) }
      }
    }
    return { body: { loader: loaderView, core: coreView } }
  })

  routes.set('GET /api/diagnostics/emotion', () => {
    interface ProbeLike {
      readonly available?: boolean
      readonly reason?: string
      stats?(): Record<string, unknown>
    }
    const probe = (key: string): Record<string, unknown> => {
      const service = (ctx as unknown as Record<string, unknown>)[key] as ProbeLike | undefined
      if (service === undefined) return { present: false, reason: 'not-loaded' }
      try {
        const stats = typeof service.stats === 'function' ? service.stats() : undefined
        return {
          present: true,
          available: service.available,
          reason: service.reason ?? stats?.['reason'],
          stats: stats ?? null,
        }
      } catch (error) {
        return { present: true, error: String(error) }
      }
    }
    return {
      body: {
        core: probe('ondra-emotion-core'),
        express: probe('ondra-emotion-express'),
        diffuse: probe('ondra-emotion-diffuse'),
        /*
         * 关系域：`familiarity` 的真源。
         *
         * ## 为什么它必须在这里有一格
         *
         * `familiarity` 恒 0 有三种成因，成因不同、症状完全一样（值就是 0），
         * 而 0 是「陌生人」这个**合法取值**——所以「服务没装」「没人调 touch」
         * 「宿主没把值传给弥散」这三件事，在界面上一个字都看不出来。
         *
         * 这一格同时给出三个数：
         *
         * | 字段 | 说明 | 读到 0 时的结论 |
         * | --- | --- | --- |
         * | `present` | 服务在不在 | false → 检查默认启用名单 |
         * | `interactions` | 累计互动次数 | 有值而 familiarity 为 0 → 公式或读取断了 |
         * | `familiarity` | 推导出来的熟悉度 | 与 `interactions/5000` 不等 → 两处真源 |
         *
         * 三者并排，「没装」「没写」「没读」才分得开。
         */
        relation: relationProbe(ctx),
        /*
         * 人格演化：`interactions` 与 `factor` 的真源。
         *
         * ## 为什么它必须在这里有一格
         *
         * 这个插件的症状和关系域一模一样：`interactions = 0` → 系数 `×1.00`
         * → 阈值一个都不涨，而 `×1.00` 是**合法系数**，所以不会有任何报错。
         * 用户能感知到的只有一句「她永远像第一天认识你」。
         *
         * 三件需要并排看清的事：
         *
         * | 字段 | 读到什么 | 结论 |
         * | --- | --- | --- |
         * | `present: false` | 服务没装 | 查默认启用名单 |
         * | `interactions` 涨而 `aligned: false` | 与关系真源漂开 | 差额对齐没跑 |
         * | `appliedTo: []` | 系数没有消费方 | **算得出，但没生效**（如实回答） |
         *
         * 第三行是本轮最要紧的一格：六态与七阶的阈值都在各自插件的常量表里，
         * 没有任何一处接受外面传进来的值。装上了不等于生效，这句话必须是
         * 机器可读的，否则下一个人会以为改完就见效了。
         */
        evolve: evolveProbe(ctx),
        /*
         * 投影：情绪的唯一文本出口。
         *
         * ## 为什么它必须在这里有一格
         *
         * 「她永远用同一种语气说话」有四种成因，症状完全相同——提示词里
         * 缺了那一段。而缺得到底是哪一种，界面上一个字都看不出来：
         *
         * | 字段 | 读到什么 | 结论 |
         * | --- | --- | --- |
         * | `present: false` | 服务没装 | 查默认启用名单 |
         * | `hasExpress: false` | 六态缺席 | 投影一律 `no-state`，去查 `express` 那格 |
         * | `counters.projects === 0` | 装上了但没人调 | 装配线断了 |
         * | `counters.refusals` 在涨而 `projects` 不动 | 调用到了、判据在拦 | 正常产品行为 |
         *
         * `askedForNumbersWired: false` 是**如实回答**：§4.3 的唯一例外出口
         * 目前没有判据来源，宿主刻意不从对话里猜（猜错一次就是她突然报数）。
         * 这一格存在的意义就是不让它看起来像接好了。
         */
        project: projectionProbe(ctx),
        /*
         * 本进程里一共问过几次弥散。
         *
         * 它和插件的 `claims` 放在一起才有意义：`asked` 一直是 0 说明
         * 宿主根本没调用（接线断了）；`asked` 在涨而 `claims` 不动，
         * 说明调用到了、判据在拦（那是正常的产品行为）。
         *
         * `rounds` 是「本来该问几轮」——它与 `asked` 是**两个数**，
         * 正是为了让「调用被删掉但计数器还在涨」这种假绿无处可藏。
         */
        asked: diffuseAsked,
        rounds: diffuseSeq,
        /*
         * 「这一轮的情绪块真的拼进系统提示词」的轮数。
         *
         * 它和 `project.counters.projects` 必须并排看：两者长期不等，
         * 说明装配线断了（取到投影却没用上），而这两种情形的日志一模一样。
         */
        emotionApplied,
        /*
         * 记忆注入那一段的两格。见 `contextApplied` 声明处的说明：
         * 登记数与产出轮数**必须分开**，否则「没挂上」与「没东西可说」同形。
         *
         * ## 为什么从 `ctx` 取而不是闭包变量
         *
         * 注册表在 `main()` 里 provide、`buildRoutes()` 在另一个作用域。
         * 从 `ctx` 取不仅解决了可见性，还保证了**读到的是插件实际拿到的那个
         * 对象**——用闭包变量的话，将来若有人把 provide 换成另一个实例，
         * 诊断会照常报「登记了 1 段」，而插件挂在了别处。
         *
         * `names` 是登记方的名字，用来一眼看出是谁挂的（应当含
         * `ondra:injection`）。它读的是注册表的 `names()`——那个方法返回
         * 「谁登记了」，与「这一轮谁产出了」是两件事。
         */
        context: (() => {
          const registry = ctx.get(SYSTEM_PROMPT_SERVICE_KEY) as ContextRegistry | undefined
          return {
            registered: registry?.size ?? 0,
            names: registry?.names() ?? [],
            applied: contextApplied,
          }
        })(),
      },
    }
  })

  /**
   * 记忆库体检（`ondra-memory-heal` 的唯一消费者）。
   *
   * ## 为什么必须有这条路由
   *
   * 这个插件的 `diagnose()` 全仓零调用方。它被装载之后，`available` 是 true、
   * `stats()` 一切正常、配置段能读能写——**唯独巡检从不发生**。
   * 这是本仓踩了十一次的同一个形态：一个写完了但没人问的服务，
   * 在界面上与「这个功能本来没有」完全同形。
   *
   * 所以本路由不是「顺便加一个接口」，而是**这个插件存在的理由**：
   * 没有它，把它加进默认启用名单只是把空跑挪了个位置。
   *
   * ## `?run=1` 与不带参数的区别
   *
   * 不带参数只回 `stats()`：回答「装没装、跑过几次、累计发现几项」。
   * 带 `?run=1` 才真的巡检一遍——巡检要翻几百条记忆、每条算一次强度，
   * 不能让它跟着面板轮询一起跑（那会把每次刷新变成一次全表扫）。
   *
   * ## 三档为什么不在这里合并
   *
   * `auto` / `confirm` / `advise` 三档原样返回，**宿主不做任何取舍**。
   * 合并的决定权在界面上那颗确认按钮，而宿主替用户决定哪档可以批量跑，
   * 就是把这个插件的核心设计（二次确认闸）绕过掉了。
   *
   * 只读（`?run=1` 也不写库），不含密钥，不触发模型调用。
   */
  routes.set('GET /api/memory/health', (request: RouteRequest) => {
    interface HealPort {
      readonly available?: boolean
      readonly reason?: string
      diagnose(limit?: number): {
        readonly at: number
        readonly scanned: number
        readonly complete: boolean
        readonly findings: readonly {
          readonly code: string
          readonly tier: string
          readonly id: string
          readonly detail: string
          readonly action: string | null
        }[]
        readonly counts: { readonly auto: number; readonly confirm: number; readonly advise: number }
        readonly missing: readonly string[]
      }
      plan(report?: unknown): {
        readonly items: readonly unknown[]
        readonly actionable: number
        readonly advisory: number
      }
      stats?(): Record<string, unknown>
    }
    const service = ctx.get('ondra-memory-heal') as HealPort | undefined
    // 未装载 ≠ 记忆库健康。前端据此区分「没这个能力」与「查过、没问题」。
    if (service === undefined) {
      return { body: { loaded: false, reason: 'not-loaded', findings: [], counts: null } }
    }
    const stats = ((): Record<string, unknown> | null => {
      try {
        return typeof service.stats === 'function' ? service.stats() : null
      } catch {
        return null
      }
    })()
    if (service.available !== true) {
      return {
        body: {
          loaded: true,
          available: false,
          reason: service.reason ?? 'unavailable',
          stats,
          findings: [],
          counts: null,
        },
      }
    }

    const query = request.query ?? {}
    if (query['run'] !== '1') {
      // 轻查询：只报统计，不扫库。面板轮询走这条。
      return { body: { loaded: true, available: true, ran: false, stats } }
    }

    const rawLimit = Number(query['limit'] ?? 0)
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.trunc(rawLimit) : undefined
    try {
      const report = limit === undefined ? service.diagnose() : service.diagnose(limit)
      const plan = service.plan(report)
      /*
       * `stats` **在巡检之后才取**。
       *
       * 取早了会得到一个稳定错误的数：`diagnoses` 永远是上一次的值，
       * 于是「刚跑完一次巡检」的那次响应里 `diagnoses: 0`——
       * 读起来正好是「从来没跑过」。而这恰恰是诊断接口最不该说错的
       * 那一格（它存在的全部意义就是分辨「没跑」与「跑了没问题」）。
       */
      const statsAfter = ((): Record<string, unknown> | null => {
        try {
          return typeof service.stats === 'function' ? service.stats() : null
        } catch {
          return null
        }
      })()
      return {
        body: {
          loaded: true,
          available: true,
          ran: true,
          at: report.at,
          scanned: report.scanned,
          /*
           * `complete=false` 时清单只是**部分**结果。
           * 不传这一格，界面会把「撞了上限」显示成「全部就这些」——
           * 而这两个结论对用户的含义完全相反。
           */
          complete: report.complete,
          missing: report.missing,
          counts: report.counts,
          findings: report.findings,
          actionable: plan.actionable,
          advisory: plan.advisory,
          stats: statsAfter,
        },
      }
    } catch (error) {
      // 巡检崩了要说出来，不能回一个空清单冒充「没问题」。
      logInfo(ctx, `记忆体检失败：${String(error)}`)
      return { status: 500, body: { loaded: true, available: true, ran: true, error: String(error) } }
    }
  })

  /**
   * 按清单修记忆（`auto` / `confirm` 两档）。
   *
   * ## 为什么 `confirm` 必须由请求体逐个点名
   *
   * 插件本身要求 `{ confirm: 'repair' }` 这道闸（缺了直接抛
   * `confirmation-required`）。本路由**额外**要求：请求体里必须带
   * `keys` 数组，且每一项都必须是当前巡检真的存在的 key。
   * 两道闸拦的是两件不同的事——
   *
   * | 闸 | 拦的是 |
   * | --- | --- |
   * | `confirm: 'repair'` | 「这不是一次误触」 |
   * | `keys` 逐个点名 | 「没有一条是顺手批量带进来的」 |
   *
   * 只放行 `auto` / `confirm`；`advise` 档的 key 传进来会被插件拒（`not-actionable`），
   * 宿主不替它改判——那一档本来就该由别的插件做。
   *
   * 这是本仓唯一的「写记忆库」路由，故不提供无 body 的 GET 形态。
   */
  routes.set('POST /api/memory/health/repair', (request: RouteRequest) => {
    interface HealRepairPort {
      readonly available?: boolean
      apply(
        keys: readonly string[],
        options?: { readonly confirm: 'repair' },
      ): readonly {
        readonly key: string
        readonly ok: boolean
        readonly refusal?: string
        readonly detail: string
      }[]
    }
    const service = ctx.get('ondra-memory-heal') as HealRepairPort | undefined
    if (service === undefined) return { status: 503, body: { error: '记忆自愈未装载' } }
    if (service.available !== true) {
      return { status: 503, body: { error: '记忆自愈不可用（记忆内核缺席）' } }
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    const raw = body['keys']
    if (!Array.isArray(raw) || raw.length === 0) {
      return { status: 400, body: { error: 'keys 必须是非空数组：修复要逐项点名，不支持「全修」' } }
    }
    // 上限 50：一次点五十项已经是「人真的逐条看过」的上限，
    // 再多就接近批量了，而批量正是这个插件刻意不提供的。
    const keys = raw.filter((key): key is string => typeof key === 'string' && key !== '').slice(0, 50)
    if (keys.length === 0) return { status: 400, body: { error: 'keys 里没有有效的 key' } }
    try {
      const outcomes = service.apply(keys, { confirm: 'repair' })
      return { body: { outcomes, ok: outcomes.filter(item => item.ok).length } }
    } catch (error) {
      logInfo(ctx, `记忆修复失败：${String(error)}`)
      return { status: 500, body: { error: String(error) } }
    }
  })

  /**
   * 做梦：读状态（GET）与真的做一场（POST）。
   *
   * ## 为什么 GET 与 POST 分成两条
   *
   * GET 只读探针（`dreamProbe`），**不扫库、不调模型、不改任何一个字节**——
   * 面板每次打开都能安全地打它。POST 才是「做一场梦」：它会读原文层、
   * 调一次模型、往记忆库写事实、往 `dream_log` 记一笔账。
   *
   * 合成一条 GET（`?run=1` 那种写法）在这里不合适：做一场梦是**不可逆**的
   * 写操作（写进 `memory_fact` 的事实不会被自动撤销），而有缓存、预取、
   * 链接预热的客户端会把 GET 重放。记忆体检那条路能那么写，是因为它的
   * `diagnose()` 只读；本插件不是。
   *
   * ## 为什么 `force` 只接受布尔
   *
   * 「今天已经做过一场」是默认闸，`force: true` 是界面上「再来一场」
   * 那颗按钮。不提供「跳过所有闸」之类的位：做梦的四道闸在插件里，
   * 宿主这一层只有一道「一天一场」，能绕的也只有这一道。
   */
  routes.set('GET /api/memory/dream', () => {
    return { body: dreamProbe(ctx) }
  })

  routes.set('POST /api/memory/dream', async (request: RouteRequest) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const force = body['force'] === true
    const outcome = await runDream(ctx, { force })
    /*
     * 三种「没跑」要说成三句不同的话：
     * 没装载 / 装了但不可用 / 今天跑过了。
     * 合成一句「做梦失败」是最坏的一种，它会把「还没接上」和「已经跑过了」
     * 说成同一件事，而后者恰好是**正常**的。
     */
    if (!outcome.ran) {
      if (outcome.skipped === 'already-today') {
        return { body: { ran: false, skipped: outcome.skipped, note: outcome.note } }
      }
      const status = outcome.skipped === 'not-loaded' || outcome.skipped === 'unavailable' ? 503 : 200
      return { status, body: { ran: false, skipped: outcome.skipped, note: outcome.note } }
    }
    if (outcome.report !== undefined) {
      const report = outcome.report
      logInfo(
        ctx,
        `做了一场梦（${report.mode}）：候选 ${String(report.candidates)}，写 ${String(report.written.length)}，`
        + `拒 ${String(report.rejected.length)}，卡片 ${String(report.cards.length)}，梦话 ${String(report.talk.length)}`,
      )
      return {
        body: {
          ran: true,
          ok: report.ok,
          ...(report.reason === undefined ? {} : { reason: report.reason }),
          mode: report.mode,
          date: report.date,
          at: report.at,
          candidates: report.candidates,
          written: report.written.length,
          rejected: report.rejected.length,
          cards: report.cards.length,
          talk: report.talk.length,
          edges: report.edges,
          backup: report.backup,
          logged: report.logged,
          note: outcome.note,
        },
      }
    }
    return { body: { ran: true, note: outcome.note } }
  })

  /**
   * 快照：清单（GET）与校验一份（POST）。
   *
   * ## 为什么只有这两个动作
   *
   * | 动作 | 为什么不做 |
   * | --- | --- |
   * | `restore()` | 插件要求「库已关闭」，而宿主正持有着那个库——任何按钮都只会返回 `db-open`，是假按钮 |
   * | `create()` | 做梦本身就会调它（真用途）；给一颗手按的按钮会让人以为「不按就不备份」 |
   * | `prune()` | 轮转在 `create()` 之后由插件自己跑，同样不该由人按 |
   *
   * `verify()` 必须做：它是「备份」与「一份没人验过的文件」之间唯一的分界线，
   * 而在此之前整个产品里没有地方能问这句话。
   *
   * ## 为什么校验用 POST
   *
   * `verify()` 会 `ATTACH` 一份快照并跑 `quick_check`——读几百 MB 是常态。
   * 放在 GET 上会被缓存、被预取、被链接预热反复触发。它不改任何东西，
   * 但**它也不该被自动触发**。
   */
  routes.set('GET /api/memory/snapshots', () => {
    return { body: snapshotProbe(ctx) }
  })

  routes.set('POST /api/memory/snapshots/verify', (request: RouteRequest) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const id = typeof body['id'] === 'string' ? body['id'] : ''
    if (id === '') return { status: 400, body: { error: '缺少快照 id' } }
    const result = verifySnapshot(ctx, id)
    if (!result.ok) {
      // 没装载与「这份快照坏了」是两个结论，状态码分开。
      const status = result.reason === 'not-loaded' ? 503 : 200
      return { status, body: result }
    }
    return { body: result }
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

  /*
   * 调试路由放在最后注册。
   *
   * 两个理由：① 它要在业务路由全部就位之后才能读 `routes.size` 做自检；
   * ② 默认关闭时（`debug === undefined`）这里一行都不执行，正式包的路由表
   *    与加调试接口之前**完全一致**，不存在"多了几条能看见的路径"。
   */
  if (debug !== undefined) installDebugRoutes(routes, debug)

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

/**
 * 读当前会话（单会话制的唯一那一条）。
 *
 * 内核按 `updatedAt` 倒序给出活跃会话，这里取第一条。**不额外维护一个
 * 「当前会话 id」的文件**：那份文件与内核的会话列表是两份真源，一旦不同步，
 * 界面就会指向一个不存在或已归档的会话，而所有相关接口都不会报错。
 *
 * @returns 会话元信息；一条都没有时返回 null（新装应用的正常状态）。
 */
async function readCurrentSession(ctx: Context): Promise<Record<string, unknown> | null> {
  const client = getDsh(ctx)
  const raw = await client.call('session.list', { includeArchived: false })
  if (!Array.isArray(raw) || raw.length === 0) return null
  const first = raw[0] as Record<string, unknown>
  if (typeof first['id'] !== 'string' || first['id'] === '') return null
  return {
    id: first['id'],
    title: typeof first['title'] === 'string' ? first['title'] : '',
    createdAt: typeof first['createdAt'] === 'number' ? first['createdAt'] : 0,
    updatedAt: typeof first['updatedAt'] === 'number' ? first['updatedAt'] : 0,
    archived: first['archived'] === true,
    workspace: typeof first['workspace'] === 'string' ? first['workspace'] : '',
  }
}

/** 日志时间轴的一行。形状与前端 `lib/types.ts` 的 `LogEntry` 一一对应。 */
interface SessionLogRow {
  id: string
  round: number
  at: number
  channel: 'rhythm' | 'channel' | 'model'
  actor: 'system' | 'user' | 'assistant'
  summary: string
  detail?: string
  chars?: number
  ms?: number
}

/**
 * 从落盘消息派生会话日志。
 *
 * ## 一轮怎么划分
 *
 * 以用户消息为界：他说一句，到下一个用户消息之前算一轮。这样「第 N 轮」
 * 与他心里的计数一致——他数自己说了几句，而不是数气泡个数。
 *
 * ## 为什么不补「想了多久」
 *
 * 思考过程不落盘（见内核 `InferenceRun` 的注释），历史轮次无从还原时长。
 * 少一行比编一行好：日志的全部价值在于可信。
 */
function deriveSessionLog(raw: unknown): SessionLogRow[] {
  if (!Array.isArray(raw)) return []
  const rows = raw as Array<{ id?: unknown; role?: unknown; content?: unknown; createdAt?: unknown }>
  const out: SessionLogRow[] = []
  let round = 0
  let roundAt = 0

  for (const row of rows) {
    if (typeof row.content !== 'string') continue
    const at = typeof row.createdAt === 'number' ? row.createdAt : 0
    const id = typeof row.id === 'string' ? row.id : `row-${String(out.length)}`

    if (row.role === 'user') {
      round += 1
      roundAt = at
      out.push({ id: `${id}-start`, round, at, channel: 'rhythm', actor: 'system', summary: '开始这一轮' })
      out.push({
        id: `${id}-in`,
        round,
        at,
        channel: 'channel',
        actor: 'user',
        summary: '收到一条消息',
        chars: row.content.length,
        ...(row.content === '' ? {} : { detail: row.content }),
      })
      continue
    }

    if (row.role !== 'assistant') continue
    // 中断留下的空助手消息不进日志：它没有「说完了」这件事可说。
    if (row.content === '') continue
    out.push({
      id: `${id}-out`,
      round: Math.max(1, round),
      at,
      channel: 'model',
      actor: 'assistant',
      summary: '说完了',
      chars: row.content.length,
      ...(roundAt > 0 && at > roundAt ? { ms: at - roundAt } : {}),
      detail: row.content,
    })
  }

  return out
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

/* ==========================================================================
   导出 / 导入：形状与格式化
   ========================================================================== */

/** 内核返回的会话元信息里，导出真正用得到的那几项。 */
interface SessionExportMeta {
  id?: unknown
  title?: unknown
  createdAt?: unknown
  updatedAt?: unknown
  workspace?: unknown
}

/**
 * 导出文件里的一条消息。
 *
 * 字段名与落盘文件（`sessions/<uuid>.json` 的 `messages`）**逐字相同**：
 * 用户拿到的 JSON 和磁盘上那份是同一种东西，不需要再学一套格式。
 * 唯一不带的是 `id`——恢复时会重新生成（理由见 `importMessages`）。
 */
interface ExportedMessage {
  role: string
  content: string
  createdAt: number
  toolName?: string
}

/** 一段可迁移的对话。 */
interface SessionPayload {
  format: number
  exportedAt: number
  id: string
  title: string
  createdAt: number
  updatedAt: number
  workspace: string
  messages: ExportedMessage[]
}

/**
 * 把内核返回的原始行收窄成可导出的消息。
 *
 * 逐字段判类型而不是直接断言：这些数据来自磁盘文件，用户手工编辑过是常态，
 * 而一个 `content` 是 `null` 的消息会让整个导出文件在恢复时炸掉。
 */
function normalizeExportMessages(rows: unknown): ExportedMessage[] {
  if (!Array.isArray(rows)) return []
  const out: ExportedMessage[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const item = row as Record<string, unknown>
    if (typeof item.content !== 'string') continue
    const role = typeof item.role === 'string' ? item.role : 'user'
    out.push({
      role,
      content: item.content,
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
      ...(typeof item.toolName === 'string' ? { toolName: item.toolName } : {}),
    })
  }
  return out
}

/** 两位补零。 */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 时间戳 → `2026-11-11 18:30`。
 *
 * 不用 `toLocaleString`：它依赖运行时的 ICU 与系统区域，同一份会话在不同
 * 机器上导出的时间格式会不一样，而导出文件是给人归档用的，格式应当稳定。
 */
function stamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '时间未知'
  const date = new Date(ms)
  return (
    `${String(date.getFullYear())}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  )
}

/** 角色在导出的 Markdown 里的称呼。 */
const ROLE_LABEL: Record<string, string> = {
  user: '我',
  assistant: '她',
  system: '系统',
  tool: '工具',
}

/**
 * 渲染成人能读的 Markdown。
 *
 * 目标是**贴到任何地方都不失真**：标题一行、元信息一行、每条消息一个
 * 二级标题 + 正文。不用表格、不用 HTML、不依赖任何渲染器扩展。
 * 工具消息收进围栏代码块——它的内容是 JSON，直接铺在正文里会淹没对话。
 */
function renderSessionMarkdown(payload: SessionPayload): string {
  const lines: string[] = []
  const title = payload.title.trim() === '' ? '未命名会话' : payload.title.trim()
  lines.push(`# ${title}`, '')
  const meta = [
    `导出时间：${stamp(payload.exportedAt)}`,
    `开始于：${stamp(payload.createdAt)}`,
    `共 ${String(payload.messages.length)} 条消息`,
  ]
  if (payload.workspace !== '') meta.push(`工作区：${payload.workspace}`)
  lines.push(`> ${meta.join(' · ')}`, '')

  for (const message of payload.messages) {
    const label = ROLE_LABEL[message.role] ?? message.role
    const suffix = message.role === 'tool' && message.toolName !== undefined ? `（${message.toolName}）` : ''
    lines.push(`## ${label}${suffix} · ${stamp(message.createdAt)}`, '')
    if (message.role === 'tool') {
      lines.push('```json', message.content, '```')
    } else {
      lines.push(message.content)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * 把任意形状的导入文件收窄成「标题 + 消息」。
 *
 * 三种形态都认：
 *
 * | 用户存下的文件 | 形状 |
 * | --- | --- |
 * | 完整导出响应 | `{ session: { messages }, markdown }` |
 * | 只存了 session 那一段 | `{ format, title, messages }` |
 * | 直接拷了数据目录里的会话文件 | `{ version, title, messages, id }` |
 *
 * 认不出就返回 `undefined`，由调用方回 400 给一句人话——比抛异常好，
 * 因为"选错了文件"是最常见的失败，它不该看起来像服务坏了。
 */
function normalizeImportPayload(value: unknown): { title: string; messages: ExportedMessage[] } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const messages = normalizeExportMessages(record.messages)
  if (messages.length === 0) return undefined
  const title = typeof record.title === 'string' ? record.title : ''
  return { title, messages }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? (error.stack ?? message) : message
  process.stderr.write(`[host] 启动失败：${stack}\n`)
  // 完整诊断只写 stderr；发给壳的只有可读消息，避免把本机路径暴露到界面。
  sendToShell({ type: 'fatal', message })
  process.exitCode = 1
})
