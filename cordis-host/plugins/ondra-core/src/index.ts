/**
 * 空谷核心成员清单。
 *
 * ## 这份清单从哪来
 *
 * 旧仓库的 134 个插件各自带一份 `cordis.patch.yml`，内容是一个 `insert` 块，
 * 声明「把自己插入宿主入口树的根层」。133 个插件全部如此，没有一个往别人的
 * 分组里塞，也没有一个声明 `disabled`。
 *
 * 也就是说，旧装配方式虽然写着「补丁」，实际语义就是**一张扁平的插件名单**。
 * 这份清单是那张名单的直接转写：每个成员一行，顺序按插件名的字典序。
 * 顺序不影响语义——各插件之间没有代码级 import，只通过服务键在运行时互相发现，
 * Cordis 会按各自声明的服务依赖排队。
 *
 * ## 为什么仍然逐个静态 import
 *
 * 用 `import()` 动态拼接路径可以让这个文件更短，但代价是：打包器看不出依赖，
 * 任何一个插件改名或删除都只会在运行时炸；类型检查也完全失效。
 * 134 行静态 import 换来的是「少一个文件就编译不过」，这笔交易划算。
 */

import type { Context } from '@ntars/cordis'

import type { CoreMember, CoreLoadResult } from './types.js'
import { orderMembers } from './order.js'

export type { CoreMember, CoreLoadResult } from './types.js'
export { orderMembers } from './order.js'
export type { OrderResult } from './order.js'

/** 空谷核心版本。 */
export const CORE_VERSION = '2.2.1'

/** 迁入的空谷插件数量。清单变化时这个数字要跟着变，冒烟测试会核对。 */
export const MIGRATED_PLUGIN_COUNT = 75

// --- 迁入的空谷插件 -------------------------------------------------------
// 按插件名字典序排列，方便对照目录。新增插件请在对应位置插入，不要追加到末尾。
import * as ondra_absence from '@ondra/cordis-plugin-ondra-absence'
import * as ondra_asr from '@ondra/cordis-plugin-ondra-asr'
import * as ondra_breath from '@ondra/cordis-plugin-ondra-breath'
import * as ondra_clock from '@ondra/cordis-plugin-ondra-clock'
import * as ondra_config_schema from '@ondra/cordis-plugin-ondra-config-schema'
import * as ondra_crisis from '@ondra/cordis-plugin-ondra-crisis'
import * as ondra_data_migrate from '@ondra/cordis-plugin-ondra-data-migrate'
import * as ondra_dialogue from '@ondra/cordis-plugin-ondra-dialogue'
import * as ondra_dialogue_protocol from '@ondra/cordis-plugin-ondra-dialogue-protocol'
import * as ondra_drive_gap from '@ondra/cordis-plugin-ondra-drive-gap'
import * as ondra_emotion_core from '@ondra/cordis-plugin-ondra-emotion-core'
import * as ondra_emotion_diffuse from '@ondra/cordis-plugin-ondra-emotion-diffuse'
import * as ondra_emotion_express from '@ondra/cordis-plugin-ondra-emotion-express'
import * as ondra_emotion_project from '@ondra/cordis-plugin-ondra-emotion-project'
import * as ondra_emotion_stage from '@ondra/cordis-plugin-ondra-emotion-stage'
import * as ondra_evidence_gate from '@ondra/cordis-plugin-ondra-evidence-gate'
import * as ondra_expression_decide from '@ondra/cordis-plugin-ondra-expression-decide'
import * as ondra_filter_chain from '@ondra/cordis-plugin-ondra-filter-chain'
import * as ondra_first_meet from '@ondra/cordis-plugin-ondra-first-meet'
import * as ondra_forget_right from '@ondra/cordis-plugin-ondra-forget-right'
import * as ondra_identity from '@ondra/cordis-plugin-ondra-identity'
import * as ondra_inject_dedupe from '@ondra/cordis-plugin-ondra-inject-dedupe'
import * as ondra_install_doctor from '@ondra/cordis-plugin-ondra-install-doctor'
import * as ondra_installer from '@ondra/cordis-plugin-ondra-installer'
import * as ondra_lexicon from '@ondra/cordis-plugin-ondra-lexicon'
import * as ondra_life_rhythm from '@ondra/cordis-plugin-ondra-life-rhythm'
import * as ondra_live from '@ondra/cordis-plugin-ondra-live'
import * as ondra_llm_gateway from '@ondra/cordis-plugin-ondra-llm-gateway'
import * as ondra_log_zh from '@ondra/cordis-plugin-ondra-log-zh'
import * as ondra_memory_audit from '@ondra/cordis-plugin-ondra-memory-audit'
import * as ondra_memory_core from '@ondra/cordis-plugin-ondra-memory-core'
import * as ondra_memory_decay from '@ondra/cordis-plugin-ondra-memory-decay'
import * as ondra_memory_dedupe from '@ondra/cordis-plugin-ondra-memory-dedupe'
import * as ondra_memory_dream from '@ondra/cordis-plugin-ondra-memory-dream'
import * as ondra_memory_extract from '@ondra/cordis-plugin-ondra-memory-extract'
import * as ondra_memory_graph from '@ondra/cordis-plugin-ondra-memory-graph'
import * as ondra_memory_heal from '@ondra/cordis-plugin-ondra-memory-heal'
import * as ondra_memory_humanlike from '@ondra/cordis-plugin-ondra-memory-humanlike'
import * as ondra_memory_intake from '@ondra/cordis-plugin-ondra-memory-intake'
import * as ondra_memory_pool from '@ondra/cordis-plugin-ondra-memory-pool'
import * as ondra_memory_prospective from '@ondra/cordis-plugin-ondra-memory-prospective'
import * as ondra_memory_recall from '@ondra/cordis-plugin-ondra-memory-recall'
import * as ondra_memory_recognition from '@ondra/cordis-plugin-ondra-memory-recognition'
import * as ondra_memory_vector from '@ondra/cordis-plugin-ondra-memory-vector'
import * as ondra_multimodal_memory from '@ondra/cordis-plugin-ondra-multimodal-memory'
import * as ondra_onboarding from '@ondra/cordis-plugin-ondra-onboarding'
import * as ondra_oral from '@ondra/cordis-plugin-ondra-oral'
import * as ondra_organ_gate from '@ondra/cordis-plugin-ondra-organ-gate'
import * as ondra_organ_host from '@ondra/cordis-plugin-ondra-organ-host'
import * as ondra_path_layout from '@ondra/cordis-plugin-ondra-path-layout'
import * as ondra_persona_assemble from '@ondra/cordis-plugin-ondra-persona-assemble'
import * as ondra_persona_core from '@ondra/cordis-plugin-ondra-persona-core'
import * as ondra_persona_evolve from '@ondra/cordis-plugin-ondra-persona-evolve'
import * as ondra_persona_loader from '@ondra/cordis-plugin-ondra-persona-loader'
import * as ondra_persona_vars from '@ondra/cordis-plugin-ondra-persona-vars'
import * as ondra_port_picker from '@ondra/cordis-plugin-ondra-port-picker'
import * as ondra_privacy from '@ondra/cordis-plugin-ondra-privacy'
import * as ondra_proactive_gate from '@ondra/cordis-plugin-ondra-proactive-gate'
import * as ondra_proactive_quota from '@ondra/cordis-plugin-ondra-proactive-quota'
import * as ondra_proactive_reason from '@ondra/cordis-plugin-ondra-proactive-reason'
import * as ondra_process_host from '@ondra/cordis-plugin-ondra-process-host'
import * as ondra_prompt_inject from '@ondra/cordis-plugin-ondra-prompt-inject'
import * as ondra_rhythm from '@ondra/cordis-plugin-ondra-rhythm'
import * as ondra_rhythm_typing from '@ondra/cordis-plugin-ondra-rhythm-typing'
import * as ondra_sandbox from '@ondra/cordis-plugin-ondra-sandbox'
import * as ondra_snapshot from '@ondra/cordis-plugin-ondra-snapshot'
import * as ondra_startup_check from '@ondra/cordis-plugin-ondra-startup-check'
import * as ondra_store_json from '@ondra/cordis-plugin-ondra-store-json'
import * as ondra_store_memory from '@ondra/cordis-plugin-ondra-store-memory'
import * as ondra_store_sqlite from '@ondra/cordis-plugin-ondra-store-sqlite'
import * as ondra_tts from '@ondra/cordis-plugin-ondra-tts'
import * as ondra_tts_gate from '@ondra/cordis-plugin-ondra-tts-gate'
import * as ondra_vision from '@ondra/cordis-plugin-ondra-vision'
import * as ondra_window from '@ondra/cordis-plugin-ondra-window'
import * as ondra_worldbook from '@ondra/cordis-plugin-ondra-worldbook'

/**
 * 全部核心成员。
 *
 * 单一来源：这份数组就是「空谷由哪些插件组成」的完整答案。
 * 旧仓库需要把 134 份补丁文件与宿主基准配置叠在一起求并集才能回答同一个问题。
 */
export const members: readonly CoreMember[] = [
  { id: 'ondra-absence', plugin: ondra_absence },
  { id: 'ondra-asr', plugin: ondra_asr, after: ['ondra-config-schema', 'ondra-identity', 'ondra-clock', 'ondra-privacy'] },
  { id: 'ondra-breath', plugin: ondra_breath, after: ['ondra-config-schema', 'ondra-identity', 'ondra-clock'] },
  { id: 'ondra-clock', plugin: ondra_clock },
  { id: 'ondra-config-schema', plugin: ondra_config_schema },
  { id: 'ondra-crisis', plugin: ondra_crisis },
  { id: 'ondra-data-migrate', plugin: ondra_data_migrate, after: ['ondra-store-sqlite', 'ondra-store-memory'] },
  { id: 'ondra-dialogue', plugin: ondra_dialogue, after: ['ondra-config-schema', 'ondra-identity', 'ondra-persona-assemble', 'ondra-llm-gateway'] },
  { id: 'ondra-dialogue-protocol', plugin: ondra_dialogue_protocol, after: ['ondra-config-schema', 'ondra-identity'] },
  { id: 'ondra-drive-gap', plugin: ondra_drive_gap, after: ['ondra-store-sqlite', 'ondra-store-memory'] },
  /*
   * `after` 补 `ondra-config-schema` + `ondra-identity`：这五个包（以及上面的
   * `ondra-asr`）在 `apply()` 第一段就**同步**取这两个服务——一个用来注册配置段
   * 并当场 `resolve()`，一个用来拼日志命名空间。写漏了不会报错，只会：
   *
   * - 四层合并整段不发生（用户层仍由宿主的 `buildMemberConfigs` 递进，
   *   所以「配置生效」与「配置没走合并」在界面上完全同形）；
   * - 日志名退成硬编码的 `ondra.emotion.xxx`，与 `ondra logs` 的过滤对不上。
   *
   * 现在靠「注册表按字母序排，`config-schema`(c) 与 `identity`(i) 恰好都排在
   * `emotion-*`(e) 前面」侥幸正确——但 `orderMembers` 是**稳定拓扑排序**，
   * 任何一次名单重排都会让它们失效，且失效时一处报错都没有。
   */
  { id: 'ondra-emotion-core', plugin: ondra_emotion_core, after: ['ondra-config-schema', 'ondra-identity', 'ondra-store-sqlite', 'ondra-store-memory'] },
  { id: 'ondra-emotion-diffuse', plugin: ondra_emotion_diffuse, after: ['ondra-config-schema', 'ondra-identity', 'ondra-store-sqlite', 'ondra-store-memory'] },
  /*
   * `emotion-express` 第 14 轮补 `ondra-emotion-core`：它 `apply()` 末尾会调一次
   * `service.profileOf()` 打「六态表达就绪：… 数值来源 …」（`src/index.ts:181-191`），
   * 而 `profileOf()` 内部同步 `ctx.get('ondra-emotion-core')`。早于内核装配时
   * 读到 `undefined`，那行就固定写成「数值来源 出厂基线（未接情绪服务）」——
   * 实测每次启动都这么报，而 `/api/diagnostics/emotion` 里 `source` 明明是
   * `emotion`。加了 `after` 后这行读数就是真的（mood/energy/tension 也是真的）。
   *
   * 注意：`profileOf()` 是**每次调用现算**，不是装配期缓存，所以这条只影响
   * 那行启动日志的真假，不改变任何表达参数。
   */
  { id: 'ondra-emotion-express', plugin: ondra_emotion_express, after: ['ondra-config-schema', 'ondra-identity', 'ondra-emotion-core'] },
  /*
   * `emotion-project` 第 14 轮补 `ondra-emotion-express`：它在 `apply()` 末尾调
   * `service.stats()` 报一次现状（`src/index.ts:134-138`），而 `stats()` 内部
   * 现取六态服务。取不到就打「情感投影已注册但不可用（六态服务未就绪）：
   * 一律不出投影」——这行是**假的**，六态服务随后就注册了。
   *
   * 这条是第 14 轮自己踩出来的：给 `emotion-express` 补了 `after: emotion-core`
   * 之后它整体后移，于是原本靠数组位置「碰巧在前」的 `emotion-project`
   * 变成了在前，启动日志立刻多出这一条。**改动顺序声明时必须重扫一遍
   * 「谁在装配期快照了被移动的那个服务」**——这是本轮最该记住的教训。
   */
  { id: 'ondra-emotion-project', plugin: ondra_emotion_project, after: ['ondra-config-schema', 'ondra-identity', 'ondra-emotion-express'] },
  { id: 'ondra-emotion-stage', plugin: ondra_emotion_stage, after: ['ondra-config-schema', 'ondra-identity', 'ondra-store-sqlite', 'ondra-store-memory'] },
  { id: 'ondra-evidence-gate', plugin: ondra_evidence_gate, after: ['ondra-store-sqlite', 'ondra-store-memory', 'ondra-memory-core'] },
  /*
   * `after` 补 `ondra-emotion-express`：`apply()` 期同步判一次六态在不在，
   * 缺席时打「此刻没有 ondra-emotion-express：正文无线索时只能给默认表情」。
   * 注册表序里它排第 4、表达档排第 32，不声明就每次启动都说一遍假话。
   */
  { id: 'ondra-expression-decide', plugin: ondra_expression_decide, after: ['ondra-emotion-express'] },
  /*
   * `after` 只列它在 `apply()` 里**同步取值**的两个。
   *
   * `ondra-identity`（日志命名空间）与 `ondra-config-schema`（注册配置段）
   * 都在 `apply` 第一段里 `ctx.get`，少一个就拿到 `undefined` 并把
   * 日志名 / 四层合并定死。
   *
   * ## 上一版注释的判断是错的（已更正，别再退回）
   *
   * 原文写「其余四个上游（`persona-core` / `emotion-stage` /
   * `emotion-express` / `llm-gateway`）都是**取值函数**，晚装载能自愈，
   * 列进 `after` 反而会让『上游缺席』变成『整个插件不加载』」。
   *
   * **半对半错**：那四处**运行时**确实走取值函数、能自愈；但 `apply()` 末尾
   * 还有一段**装载期一次性同步探测**（`index.ts` 第 162–175 行），
   * 判完就固定成日志文案，不会再看第二眼。于是每次启动都稳定出现：
   *
   * ```
   * filter-chain 人格内核未装载：硬红线与关系越线两步不会命中（其余七步照跑）
   * ```
   *
   * 而 persona-core 就在名单里、几秒后就在位，`run()` 时 `persona()` 取得到。
   * **这条 warn 因此是假红**，却会把人直接引向「去装一个已经装好的插件」——
   * 正是本仓最贵的一种误导。补 `after` 让探测时的世界与运行时一致。
   *
   * 至于「上游真的缺席会不会整包不加载」：`after` 只影响**顺序**，不影响
   * 装载与否（未装载的上游不会让下游 PENDING），所以这个担心的前提不成立。
   */
  {
    id: 'ondra-filter-chain',
    plugin: ondra_filter_chain,
    after: [
      'ondra-identity',
      'ondra-config-schema',
      'ondra-persona-core',
      'ondra-emotion-stage',
      'ondra-emotion-express',
      'ondra-llm-gateway',
    ],
  },
  { id: 'ondra-first-meet', plugin: ondra_first_meet },
  /*
   * `after` 补 `ondra-snapshot`：`apply()` 期会**同步**判一次快照服务在不在，
   * 用来打那句「快照（本来就只读）」的诊断。注册表序里 `forget-right`(F)
   * 排在 `snapshot`(S) 前面，不声明就会把已装载的快照误报成缺席。
   * 影响只在那一行日志（`plan()` / `execute()` 都走惰性取值），
   * 但「诊断说谎」比功能出错更难查，一并修掉。
   */
  { id: 'ondra-forget-right', plugin: ondra_forget_right, after: ['ondra-memory-core', 'ondra-snapshot'] },
  { id: 'ondra-identity', plugin: ondra_identity },
  /*
   * `after` 补 `ondra-path-layout`：`apply()` 期就 `ctx.get` 它，取不到时
   * `sources.inject()` 恒 `undefined`，`begin()` 每轮返回 `bypassed`。
   *
   * 注意这条与下面三个**不同类**：本插件的取值器是惰性的（`() => ctx.get(...)`），
   * 所以装载完成后其实会自愈——真正错的是那句 warn（「本轮起 begin() 返回
   * bypassed」是假的）。补 `after` 是为了让这句 warn 不再出现，顺带把
   * 「第一轮 begin() 落在装配期」这个窗口也关掉。
   */
  { id: 'ondra-inject-dedupe', plugin: ondra_inject_dedupe, after: ['ondra-prompt-inject'] },
  { id: 'ondra-install-doctor', plugin: ondra_install_doctor },
  /*
   * `after` 必须列 `ondra-path-layout`：`apply()` 期同步取它，取不到就把
   * `layout=null` 交给 `LedgerStore`，而账本在 `layout===null` 时 `path`
   * 恒 `undefined` → **静默不落盘**。安装器的账本是「装过什么」的唯一凭据，
   * 它不落盘等于每次启动都当第一次装。
   *
   * 这条不是字母序侥幸：`installer`(i) 排在 `path-layout`(p) **前面**，
   * 一旦有人在抽屉里打开它，必然按错的顺序装载。
   */
  { id: 'ondra-installer', plugin: ondra_installer, after: ['ondra-config-schema', 'ondra-identity', 'ondra-path-layout', 'ondra-clock'] },
  /*
   * `after` 补 `ondra-path-layout`：与上面 `installer` / `life-rhythm` 同一形状，
   * 只是本插件的取值器是**惰性**的（`path: () => ctx.get(...)`），所以它不会
   * 永久降级——真正错的是 `apply()` 末尾那句 `stored` 判据：它在装配期读一次
   * `ctx.get`，读到 `undefined` 就写「否（重启要重新攒样本）」。
   *
   * 那句话是假的：`path-layout` 排在 `lexicon`(l) 之后装，装完形状照样落盘。
   * 补 `after` 让装配期的判断也看到真相。
   */
  { id: 'ondra-lexicon', plugin: ondra_lexicon, after: ['ondra-path-layout', 'ondra-clock'] },
  /*
   * `after` 补 `ondra-path-layout` 与 `ondra-emotion-core`：本插件 `apply()`
   * 期同步取路径服务，取不到时 `file=undefined`，`store.ts` 的两个入口
   * 直接返回 → **生活状态永不落盘**（症状是「能量与活动每次重启归零」，
   * 而插件自己那条 warn 恰好也这么说，于是看起来像已知限制，其实是排序漏声明）。
   *
   * `life-rhythm`(l) 排在 `path-layout`(p) 前面，出厂关闭、用户一打开就中招。
   */
  { id: 'ondra-life-rhythm', plugin: ondra_life_rhythm, after: ['ondra-config-schema', 'ondra-identity', 'ondra-clock', 'ondra-path-layout', 'ondra-emotion-core'] },
  { id: 'ondra-live', plugin: ondra_live },
  { id: 'ondra-llm-gateway', plugin: ondra_llm_gateway },
  /*
   * `after` 必须列 `ondra-path-layout`，理由与 `installer` / `life-rhythm` 同一条，
   * 但后果更响：本插件在 `apply()` 里**同步**解析日志目录，取不到路径服务就
   * 整个进程的日志转「仅内存模式」——不落盘、重启即丢，而它恰恰是唯一把
   * 别的插件日志写进文件的那一环。
   *
   * `log-zh`(l) 排在 `path-layout`(p) 前面，所以只要它被装载就必然中招。
   */
  { id: 'ondra-log-zh', plugin: ondra_log_zh, after: ['ondra-path-layout'] },
  { id: 'ondra-memory-audit', plugin: ondra_memory_audit, after: ['ondra-store-sqlite', 'ondra-store-memory', 'ondra-memory-core', 'ondra-memory-decay', 'ondra-memory-graph'] },
  { id: 'ondra-memory-core', plugin: ondra_memory_core, after: ['ondra-store-sqlite', 'ondra-store-memory'] },
  { id: 'ondra-memory-decay', plugin: ondra_memory_decay, after: ['ondra-store-sqlite', 'ondra-store-memory', 'ondra-memory-core'] },
  { id: 'ondra-memory-dedupe', plugin: ondra_memory_dedupe, after: ['ondra-store-sqlite', 'ondra-store-memory', 'ondra-memory-core'] },
  /*
   * `ondra-memory-dream` 的 `after` 必须列出它**在 `apply()` 里同步取值**的
   * 每一个软依赖。
   *
   * 此前只写了 `store-sqlite` 与 `memory-core`，于是装载顺序由名单先后决定——
   * 而 `ondra-memory-graph` / `ondra-memory-dedupe` / `ondra-llm-gateway`
   * 都排在它后面。`DreamRepository` 在构造时就拿到 `undefined` 并定死，
   * 症状是三处静默降级叠在一起，**一处都不报错**：
   *
   * | 取不到的 | 症状 |
   * | --- | --- |
   * | `ondra-memory-graph` | `graphAvailable=false`，荒诞分支建不了边 |
   * | `ondra-memory-dedupe` | `dedupeGate='local'`，重复拒退回「同批去重 + 墓碑」 |
   * | `ondra-llm-gateway` | `available=false` / `no-model`，闸式分支整支不可用 |
   *
   * 这正是上一轮 `ondra-memory-recall` 踩过的同一个坑（那次是三个召回通道）。
   * **名单里有不等于装载时取得到**——软依赖不会卡住装载，但必须排进 `after`。
   *
   * 三个都是软依赖（插件内不声明 `inject`），所以列进来不会让做梦的装载
   * 被它们卡住；它只保证「先到先注册，后到能被读到」。
   */
  { id: 'ondra-memory-dream', plugin: ondra_memory_dream, after: ['ondra-store-sqlite', 'ondra-store-memory', 'ondra-memory-core', 'ondra-memory-graph', 'ondra-memory-dedupe', 'ondra-memory-extract', 'ondra-llm-gateway', 'ondra-snapshot'] },
  { id: 'ondra-memory-extract', plugin: ondra_memory_extract, after: ['ondra-memory-core'] },
  { id: 'ondra-memory-graph', plugin: ondra_memory_graph, after: ['ondra-store-sqlite', 'ondra-store-memory', 'ondra-memory-core'] },
  /*
   * `memory-heal` 的 `after` 原本只写了 `memory-core`，但它在 `apply()` 里
   * **同步**探测 `ondra-memory-audit` 与 `ondra-memory-dedupe`（第 167/170 行）
   * 来决定「三类检查要不要跑」。顺序不对时两个都取不到，于是启动日志里
   * 稳定出现「审计服务未装载：悬空钉子、待曝光幽灵、钉子偏多三类检查将跳过」——
   * 而 audit 与 dedupe **都在装载名单里**，几秒后就在位。
   * 这条错报会让读日志的人去装一个已经装好的插件，是最费时间的一种假红。
   */
  { id: 'ondra-memory-heal', plugin: ondra_memory_heal, after: ['ondra-memory-core', 'ondra-memory-audit', 'ondra-memory-dedupe', 'ondra-clock'] },
  { id: 'ondra-memory-humanlike', plugin: ondra_memory_humanlike, after: ['ondra-store-sqlite', 'ondra-store-memory', 'ondra-memory-core', 'ondra-memory-graph'] },
  /*
   * `ondra-memory-graph` 与 `ondra-memory-dedupe` 都进 `after`：intake 在归池
   * 同一批里建 `cooccur` 边、在写库前把候选交给判重。两处都用取值函数现取，
   * 晚装载也能自愈——但「每轮都取不到」与「没装」症状完全一样：
   * 边表恒 0 行、库里同一句话躺好几份。列进来至少让首次装载就取得到。
   */
  { id: 'ondra-memory-intake', plugin: ondra_memory_intake, after: ['ondra-memory-core', 'ondra-memory-graph', 'ondra-memory-dedupe'] },
  { id: 'ondra-memory-pool', plugin: ondra_memory_pool, after: ['ondra-store-sqlite', 'ondra-store-memory', 'ondra-memory-core'] },
  { id: 'ondra-memory-prospective', plugin: ondra_memory_prospective, after: ['ondra-store-sqlite', 'ondra-store-memory', 'ondra-memory-core'] },
  /*
   * `ondra-memory-recall` 的 `after` 必须列出它要探测的三个通道。
   *
   * 此前只写 `ondra-memory-core`，于是装载顺序由名单先后决定；而三个通道
   * 插件是在召回**之后**才进名单的（本轮才装），`ctx.get` 在 `apply` 时
   * 取值就恒为 `undefined`。症状与「没装这三个包」完全相同：
   * 三条通道各自静默降一档，`available` 仍是 true，一处报错都没有。
   *
   * 这就是「装了却没生效」的典型形态——**名单里有不等于装载时取得到**。
   * 三个通道都是软依赖（插件内不声明 `inject`），所以列进 `after` 不会
   * 让召回的装载被它们卡住；它只保证「先到先注册，后到能被读到」。
   */
  { id: 'ondra-memory-recall', plugin: ondra_memory_recall, after: ['ondra-memory-core', 'ondra-memory-graph', 'ondra-memory-vector', 'ondra-memory-recognition'] },
  { id: 'ondra-memory-recognition', plugin: ondra_memory_recognition, after: ['ondra-memory-core'] },
  /*
   * `memory-vector` 第 14 轮补 `store-memory` 与 `store-json`：它在 `apply()` 里
   * 同步取三个存储（`sqlite ?? memory ?? json`，见 `src/index.ts:155-162`），
   * 而原来只声明了 `store-sqlite`。缺的两个取不到时它会打一行
   * 「没有存储端口：向量索引仅存内存，重启后重嵌」——**这行是假的**，
   * 服务其实在后面就注册了，只是它已经把 `undefined` 传进 `VectorRepository`
   * 的构造函数定死，索引此后永远只在内存里。出厂 `enabled: false`，
   * 所以这条只在用户手动打开后显形。
   */
  { id: 'ondra-memory-vector', plugin: ondra_memory_vector, after: ['ondra-config-schema', 'ondra-store-sqlite', 'ondra-store-memory', 'ondra-store-json', 'ondra-memory-core'] },
  { id: 'ondra-multimodal-memory', plugin: ondra_multimodal_memory, after: ['ondra-store-sqlite', 'ondra-memory-core', 'ondra-evidence-gate'] },
  /*
   * `after` 必须列 `ondra-path-layout`：本插件在 `apply()` 里**同步**构造
   * `new FileOnboardingStore(layout ?? null, ...)`，取不到路径服务就退成
   * 「纯内存」——而首启状态的语义就是「这台机器上第一次见面」。
   *
   * 症状：每次重启都重新引导一次。`onboarding`(o) 排在 `path-layout`(p) 前面，
   * 所以只要它被装载就必然中招，且那句 warn 读起来像「已知限制」。
   */
  { id: 'ondra-onboarding', plugin: ondra_onboarding, after: ['ondra-path-layout'] },
  /*
   * `after` 补 `ondra-emotion-express`：`apply()` 期会**同步**判一次表达档在不在，
   * 用来打那句「表达档未装载：按默认标点处理」。
   *
   * 注册表序里 `oral` 排第 10、`emotion-express` 排第 32——不声明就必然先跑，
   * 于是那句 warn 每次都出现。而实际取值走惰性函数（`express()`），运行时
   * 拿得到六态，功能一直是好的：**坏的是诊断**。它读起来像「缺一个插件」，
   * 会把人引去装一个已经装好的东西。
   */
  { id: 'ondra-oral', plugin: ondra_oral, after: ['ondra-emotion-express'] },
  { id: 'ondra-organ-gate', plugin: ondra_organ_gate },
  { id: 'ondra-organ-host', plugin: ondra_organ_host },
  { id: 'ondra-path-layout', plugin: ondra_path_layout },
  /*
   * 人设三包（loader → core → assemble）必须按序装载。
   *
   * ## 为什么原来"不带 after 也能跑"，但启动日志会撒谎
   *
   * 三包的**真正**上游（loaders / core / vars）都写成延迟取值函数
   * （`loaderOf()` / `coreOf()`），所以运行时总能拿到对的实例——诊断面板
   * 因此一直是绿的。但 `apply()` 开头那几句 `ctx.get('ondra-identity')` /
   * `ctx.get('ondra-config-schema')` 是**装载期同步取**：
   * 顺序不对就拿到 `undefined`，服务构造时把 `available` 定死成 false，
   * 于是启动日志里稳定出现
   *
   * ```
   * persona-core     人格内核服务已注册但不可用（no-loader）
   * persona-assemble 四段拼装服务已注册但不可用（no-core）
   * ```
   *
   * 而几分钟后 `/api/diagnostics/persona` 却是全绿（内核 5854 字、边界 24 条）。
   * **两处说法相反的根源是「构造时定死」与「运行时现取」混用**，
   * 不是人设包坏了。补 `after` 让装载期取值也成立，两处口径才一致。
   */
  { id: 'ondra-persona-assemble', plugin: ondra_persona_assemble, after: ['ondra-config-schema', 'ondra-identity', 'ondra-persona-core', 'ondra-persona-vars'] },
  { id: 'ondra-persona-core', plugin: ondra_persona_core, after: ['ondra-config-schema', 'ondra-identity', 'ondra-persona-loader'] },
  { id: 'ondra-persona-evolve', plugin: ondra_persona_evolve, after: ['ondra-store-sqlite', 'ondra-store-memory'] },
  { id: 'ondra-persona-loader', plugin: ondra_persona_loader, after: ['ondra-config-schema', 'ondra-identity', 'ondra-path-layout'] },
  /*
   * `persona-vars`：`{{relation}}` 的填充源。
   *
   * 它在 `apply()` 里同步 `ctx.get('ondra-persona-core')` 判一次，缺了就
   * 打「没有装载 ondra-persona-core（O-021）：{{relation}} 原样保留」。
   * 不写 `after` 时这句每次启动都可能出现，而 persona-core **一直在名单里**。
   */
  { id: 'ondra-persona-vars', plugin: ondra_persona_vars, after: ['ondra-config-schema', 'ondra-identity', 'ondra-persona-core'] },
  { id: 'ondra-port-picker', plugin: ondra_port_picker },
  { id: 'ondra-privacy', plugin: ondra_privacy },
  { id: 'ondra-proactive-gate', plugin: ondra_proactive_gate, after: ['ondra-config-schema', 'ondra-identity', 'ondra-clock', 'ondra-path-layout'] },
  { id: 'ondra-proactive-quota', plugin: ondra_proactive_quota, after: ['ondra-config-schema', 'ondra-identity', 'ondra-clock', 'ondra-path-layout', 'ondra-proactive-gate'] },
  { id: 'ondra-proactive-reason', plugin: ondra_proactive_reason, after: ['ondra-config-schema', 'ondra-identity', 'ondra-memory-prospective', 'ondra-drive-gap', 'ondra-emotion-express'] },
  { id: 'ondra-process-host', plugin: ondra_process_host },
  /*
   * 注入装箱的四个可选块提供方要**先于它**装载。
   *
   * `prompt-inject` 在 `apply()` 末尾报一次现状：`ctx.get('ondra-memory-recall')`
   * 为空就打一条「召回未装载：③ 我认识的人 与 ⑤ 这会儿想起来的 不会出」。
   * 四个提供方若排在它之后，这条 warn 会在装载顺序完全正确时照常出现——
   * **日志说的是一句假话**，而下一个读日志的人会去查根本没坏的东西。
   * 顺序摆在这里，那句话才只在真的缺包时出现。
   *
   * **这一行必须保持单行写法。** `check-acceptance` 用
   * `/\{ id: '([^']+)', plugin:/` 数成员条数，拆成多行会让它少算 1 条，
   * 报一句「MIGRATED_PLUGIN_COUNT 等于 members 条数」的红——而那份清单
   * 其实一条不少。本轮先拆后合踩过一次，留此备注。
   */
  { id: 'ondra-prompt-inject', plugin: ondra_prompt_inject, after: ['ondra-memory-core', 'ondra-memory-recall', 'ondra-memory-audit', 'ondra-memory-humanlike', 'ondra-memory-decay'] },
  /*
   * 节奏三包的装载顺序：**分条 → 计时 → 呼吸**，一条链缺一环就退一档。
   *
   * | 包 | 同步取的上游 | 缺席时的表现 |
   * | --- | --- | --- |
   * | `ondra-rhythm` | `identity` / `config-schema` / `clock` | 都能降级，但日志名与四层合并会定死 |
   * | `ondra-rhythm-typing` | 同上，外加 `ondra-rhythm`（取值函数，可晚到） | `schedule()` 恒 `no-rhythm`，一次性整段发出 |
   * | `ondra-breath` | 同上，外加 `ondra-rhythm-typing`（取值函数） | `presence()` 恒不显示 |
   *
   * 三个的 `after` 只写「`apply()` 里**同步**取值」的那几个：
   * `rhythm` / `rhythm-typing` 之间是取值函数（`() => ctx.get(...)`），
   * 晚装载能自愈，所以**行为上**不依赖顺序。
   *
   * 第 14 轮仍给 `rhythm-typing` 补了 `ondra-rhythm`：它 `apply()` 末尾会
   * **同步** `ctx.get('ondra-rhythm')` 打一行 warn（`src/index.ts:158-160`），
   * 而实测 `rhythm-typing` 比 `rhythm` 早 28ms 装配，于是每次启动都留下
   * 「节奏服务未装载：所有回合都会一次性整段发出」——**这句话是假的**，
   * 取值函数在第一次调用时就能拿到服务。`after` 只改顺序、不改加载与否，
   * 所以「缺席就降级」的设计不受影响，只是那行诊断不再说谎。
   *
   * `config-schema` / `identity` 必须写：`apply()` 第一件事就是同步取它们，
   * 拿到 `undefined` 会让配置四层合并与日志命名空间整段失效，
   * 而那两件事都不报错（与 `ondra-tts` 那一段是同一个坑）。
   */
  { id: 'ondra-rhythm', plugin: ondra_rhythm, after: ['ondra-config-schema', 'ondra-identity', 'ondra-clock', 'ondra-emotion-express'] },
  { id: 'ondra-rhythm-typing', plugin: ondra_rhythm_typing, after: ['ondra-config-schema', 'ondra-identity', 'ondra-rhythm'] },
  { id: 'ondra-sandbox', plugin: ondra_sandbox },
  /*
   * `ondra-snapshot` 的 `after` 必须写全它 `apply()` 里**同步取值**的三个依赖。
   *
   * `SnapshotStore` 在构造时就确定 `available`：`store` 缺席直接 `return`
   * 不注册服务，`layout` 缺席则注册但 `available=false`。两者都是同步取值，
   * 少写一个 `after` 就等于让它读 `undefined` 然后把自己锁成不可用——
   * 与上一轮 `dream` 的 `graphAvailable=false` 同一个形态。
   *
   * `ondra-data-migrate` 刻意**不列**：它没装载，而插件用
   * `ctx.inject(['ondra-data-migrate'], …)` 做了延迟挂载，缺席时只是少一个
   * 迁移前钩子，服务照旧可用。列进 `after` 会让那句日志变成另一种说法，
   * 但不会让它变得可用——不列才如实反映「谁真的在这里等谁」。
   */
  { id: 'ondra-snapshot', plugin: ondra_snapshot, after: ['ondra-store-sqlite', 'ondra-store-memory', 'ondra-path-layout', 'ondra-identity'] },
  { id: 'ondra-startup-check', plugin: ondra_startup_check },
  /*
   * `after` 要列全 `apply()` 里**装载期同步取**的两个服务。
   *
   * 原来只写 `ondra-store-sqlite`，而 `apply()` 一进来就取 `ondra-identity`
   * （拼日志命名空间）和 `ondra-path-layout`（定位数据目录）；后者的取不到
   * 是**硬失败**——插件会 `log.error` 然后拒绝注册服务。
   *
   * 此前靠「注册表按名字母序排，`path-layout` 恰好排在 `store-json` 前面」
   * 侥幸正确。本插件出厂 `enabled: false`，用户手动打开时才会走到这条路径，
   * 而那时若顺序变了，症状是「打开了，设置页显示已启用，存储却一直没注册」。
   *
   * 第 14 轮补 `ondra-config-schema`：**这条才是「打开也不生效」的根**。
   * `apply()` 先 `registerSection()` 再 `schema.resolve()`，用户的 `enabled`
   * 只经这一条路进来；没有 schema 时直接 `completeConfig(插件实例配置)`，
   * 而实例配置就是出厂值 `false` → 必定 `return`。也就是说开关是空响，
   * 且三个界面各说各话（设置页「已打开」/ `/api/plugins`「loaded」/ 服务没注册）。
   */
  { id: 'ondra-store-json', plugin: ondra_store_json, after: ['ondra-config-schema', 'ondra-store-sqlite', 'ondra-path-layout', 'ondra-identity'] },
  /*
   * `after` 补 `ondra-identity`：`apply()` 第一段就同步读它拿日志命名空间
   * （读不到会退成硬编码的 `ondra.store-memory`），末尾还要同步读
   * `ondra-store-sqlite` 的 `state` 来判断「我在不在用」。两处都是装载期
   * 一次性取值，不给 `after` 就只能碰运气——本清单按字母序排，
   * `identity` 碰巧在前，一旦增删条目就可能翻面。
   */
  { id: 'ondra-store-memory', plugin: ondra_store_memory, after: ['ondra-identity', 'ondra-store-sqlite'] },
  /*
   * `store-sqlite` 的 `after` 原本是空的，靠数组位置碰巧排在 `path-layout` 之后。
   * 但它在 `apply()` 里**同步**取 `identity` 与 `path-layout`，取不到 `layout`
   * 就直接 `return`（`src/index.ts:241-243`「拒绝把数据库落到当前工作目录」）——
   * 也就是整库不注册，而 `check:order` 的 B 段只看「取存储的成员排在提供方之后」，
   * 不会替它检查自己的上游。声明补上，让这条隐式依赖变成显式的。
   */
  { id: 'ondra-store-sqlite', plugin: ondra_store_sqlite, after: ['ondra-identity', 'ondra-path-layout'] },
  /*
   * `ondra-tts` / `ondra-tts-gate` 的 `after` 不能省。
   *
   * 两个插件在 `apply()` 里**同步**取 `ondra-config-schema` 并当场 `resolve()`：
   *
   * ```ts
   * const schema = ctx.get('ondra-config-schema')
   * if (schema !== undefined) { resolved = schema.resolve('tts', { user }) ; effective = ... }
   * const settings = completeConfig(effective)   // ← 取值在这里就定死了
   * ```
   *
   * 清单按字母序排，`ondra-config-schema` 排在 `ondra-tts` 前面——**看似没问题**。
   * 但 `after` 不写就没有跨成员的顺序保证：`orderMembers` 只按声明排序，
   * 未声明的一律保持原序。一旦清单被重排（增删条目、改字母序、加打包分组），
   * 插件就会在 schema 之前 `apply`，`ctx.get` 拿到 `undefined`，
   * 于是**整段用户配置静默作废**，回落到插件默认值。
   *
   * 症状极其难查，因为这正是本轮踩到的：
   *
   * | 现象 | 真相 |
   * | --- | --- |
   * | 设置页显示 `min-chars=25`，读得回、落得盘 | 用户层是正确的 |
   * | `enable` 改了有效果 | 它的默认值本来就是 `true`，改与不改都看不出来 |
   * | `min-chars` / `intensity-min` / `cooldown-ms` 改了毫无反应 | `completeConfig` 拿到的是 `{}`，全部回默认 |
   *
   * 也就是说：**唯一「看起来生效」的那个字段，恰好是巧合。**
   *
   * `ondra-path-layout` 同理（`ensureCacheDir` 在装载期就取目录），
   * `ondra-identity` 决定日志命名空间——三个都要排在前面。
   */
  { id: 'ondra-tts', plugin: ondra_tts, after: ['ondra-config-schema', 'ondra-path-layout', 'ondra-identity', 'ondra-clock'] },
  // 闸门自己也要 `config-schema` 才有用户层；`tts` 是它判「有没有通道」的上游。
  /*
   * 补 `ondra-emotion-core` / `ondra-emotion-express`：与 `ondra-filter-chain`
   * 同一类假红，只是先前没人注意到它。
   *
   * 闸门的两个情绪依赖在运行期是**惰性取值**（`index.ts:169-170` 写的是
   * `() => ctx.get(...)`），所以几秒后它们就位、闸门照常工作。但 `apply()`
   * 末尾还有一段装载期一次性探测（`index.ts:200-205`），判完就把结论写死成日志：
   *
   * ```
   * 此刻没有 ondra-emotion-core：情绪强度闸按降级放行（degraded 里会标 no-emotion）
   * 此刻没有 ondra-emotion-express：拿不到六态语速，也判不出「炸毛不朗读」
   * ```
   *
   * 这两行每次启动都出现，而「情绪强度闸」正是她朗读与否的关键一环——
   * 读日志的人会立刻怀疑语音链坏了，去查一个根本没坏的东西。
   * 本仓已经因为这条语音链查了五轮，最不需要的就是又一句假话。
   */
  { id: 'ondra-tts-gate', plugin: ondra_tts_gate, after: ['ondra-config-schema', 'ondra-identity', 'ondra-clock', 'ondra-tts', 'ondra-emotion-core', 'ondra-emotion-express'] },
  { id: 'ondra-vision', plugin: ondra_vision },
  { id: 'ondra-window', plugin: ondra_window },
  { id: 'ondra-worldbook', plugin: ondra_worldbook },
]

/**
 * 把空谷核心装载到上下文。
 *
 * ## 默认全部禁用
 *
 * `members` 里的 75 个成员构成完整清单，但 `loadCore` 在**没有显式启用名单时
 * 一个都不装**（`enabled.size === 0` → 全部 `enabled: false`）。
 * 谁真的上机由宿主的两份名单决定：代码常量 `DEFAULT_CORE_ENABLE`（核心链）
 * 与用户在扩展抽屉里写的 `plugins.json` 的 `extra` / `disabled`。
 *
 * 这条注释曾经写着「134 个成员属于旧项目那套 dsh 功能，当前界面一个都没接」。
 * 它有两处错，而且是会把人带偏的那种错：
 *
 * | 那句 | 实际 |
 * | --- | --- |
 * | 134 个成员 | 75 个（134 是**旧仓库**的插件数，与这里无关） |
 * | 当前界面一个都没接 | 情绪、记忆、人设、对话这些早就接进界面并在默认名单里 |
 *
 * 谁出厂就关、关的理由是什么，逐条登记在 `docs/PLUGIN-HEALTH.md`，
 * 那里才是唯一真源——不要在代码注释里另立一份名单，两份一定漂。
 *
 * 「装着不用」而不是「干脆不打包」仍然是有意的：这些是产品的一部分，
 * 将来逐个接通时只需要把 id 加进启用名单，不必重新设计打包流程。
 *
 * ## 为什么要有 `configs`
 *
 * 曾经这里只传 `enable`，成员的 `config` 恒为 `undefined`。后果不是「配置
 * 取默认值」这么轻——**用户在设置页改的每一项都到不了插件**：界面上写着
 * 「她多主动：主动 → 每天 6 条」，插件里跑的还是 `standard`（3 条），
 * 而两侧都不报错。这条断裂在 1168 个字段上同时成立，属于「设置页是个摆设」。
 *
 * 配置的真源仍是插件的 `FIELD_SPECS`：`loadCore` 只负责把**用户层那一段**
 * 原样递进去，不补默认值、不改键名、不做校验。插件自己会走
 * `normalizeUserLayer` + `completeConfig` 兜住非法值。
 *
 * @param ctx 根上下文。
 * @param options.enable 要启用的成员 id 列表。空数组表示全部禁用（默认）。
 * @param options.extra 额外成员。用于测试或用户自定义，排在核心成员之后装载。
 * @param options.configs 按成员 id 给的配置（键用**目录名**，如
 *   `ondra-proactive-quota`，与 `enable` 同一套键）。缺项表示该成员没有
 *   用户层配置，退回自己的默认值。
 * @returns 装配结果。
 */
export async function loadCore(
  ctx: Context,
  options: {
    enable?: readonly string[]
    extra?: readonly CoreMember[]
    configs?: Readonly<Record<string, unknown>>
  } = {},
): Promise<CoreLoadResult> {
  const enabled = new Set(options.enable ?? [])
  const list = [...members, ...(options.extra ?? [])]
  const configs = options.configs ?? {}

  // 没有显式启用名单时，整份清单都不装载。
  // 把 enabled 就地改写而不是在 loadMembers 里加分支：
  // 装载循环只该关心「这条要不要装」，不该知道「默认策略是什么」。
  const resolved = list.map((member) => {
    // 成员自己写死的 `config` 优先于用户层：那是清单里的固定参数
    // （如某成员要求一个测试用路径），不该被用户误改。
    const injected = member.config === undefined ? configs[member.id] : member.config
    return {
      ...member,
      ...(injected === undefined ? {} : { config: injected }),
      enabled: enabled.size === 0 ? false : enabled.has(member.id),
    }
  })

  /*
   * 只对**本批要装的**做排序，未启用的不参与。
   *
   * 参与排序会让「未启用」的成员成为别人的前置阻塞源（它们永远不会被装），
   * 于是整条链排不出来。`orderMembers` 另有 `present` 过滤，这里先筛一遍
   * 是为了把日志里的 `unresolved` 收窄到真正相关的那几条。
   */
  const enabledOnly = resolved.filter((member) => member.enabled !== false)
  const { ordered, unresolved } = orderMembers(enabledOnly)
  if (unresolved.length > 0) {
    // 环不阻断装载，但必须说出来：环上的成员互相等，`after` 对它们零作用。
    process.stderr.write(`[core] 装载清单的 after 有环，这些成员按原序装：${unresolved.join(', ')}\n`)
  }

  // 排好的与「本批不装的」分开交回去：不装的那批在 loadMembers 里被跳过，
  // 顺序对它们没有意义，但保留在结果里能让 `skipped` 的成因可追溯。
  const disabled = resolved.filter((member) => member.enabled === false)
  return loadMembers(ctx, [...ordered, ...disabled])
}

/**
 * 逐个装载成员。
 *
 * 每个成员单独 try/catch：一个可选插件坏了不该让整个应用起不来，
 * 但必须记录下来——否则会变成「某个功能莫名其妙没了」。
 */
async function loadMembers(ctx: Context, list: readonly CoreMember[]): Promise<CoreLoadResult> {
  const loaded: string[] = []
  const skipped: CoreLoadResult['skipped'] = []

  for (const member of list) {
    if (member.enabled === false) {
      skipped.push({ id: member.id, reason: '默认禁用' })
      continue
    }
    try {
      // 逐个 await：Cordis 的 plugin 是异步的，并发装载会让依赖方在
      // 被依赖方还没 provide 服务时就开始初始化，出现「服务不存在」的偶发失败。
      await ctx.plugin(member.plugin, member.config)
      loaded.push(member.id)
    } catch (error) {
      skipped.push({
        id: member.id,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { loaded, skipped }
}
