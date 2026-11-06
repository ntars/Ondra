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

/** 空谷核心版本。 */
export const CORE_VERSION = '2.0.1'

/** 迁入的空谷插件数量。清单变化时这个数字要跟着变，冒烟测试会核对。 */
export const MIGRATED_PLUGIN_COUNT = 134

// --- 迁入的空谷插件 -------------------------------------------------------
// 按插件名字典序排列，方便对照目录。新增插件请在对应位置插入，不要追加到末尾。
import * as ondra_absence from '@ondra/cordis-plugin-ondra-absence'
import * as ondra_adapter_dingtalk from '@ondra/cordis-plugin-ondra-adapter-dingtalk'
import * as ondra_adapter_discord from '@ondra/cordis-plugin-ondra-adapter-discord'
import * as ondra_adapter_feishu from '@ondra/cordis-plugin-ondra-adapter-feishu'
import * as ondra_adapter_qq_napcat from '@ondra/cordis-plugin-ondra-adapter-qq-napcat'
import * as ondra_adapter_qq_official from '@ondra/cordis-plugin-ondra-adapter-qq-official'
import * as ondra_adapter_telegram from '@ondra/cordis-plugin-ondra-adapter-telegram'
import * as ondra_adapter_wechat_kf from '@ondra/cordis-plugin-ondra-adapter-wechat-kf'
import * as ondra_adapter_wechat_official from '@ondra/cordis-plugin-ondra-adapter-wechat-official'
import * as ondra_adapter_wechat_personal from '@ondra/cordis-plugin-ondra-adapter-wechat-personal'
import * as ondra_adapter_wecom from '@ondra/cordis-plugin-ondra-adapter-wecom'
import * as ondra_adb from '@ondra/cordis-plugin-ondra-adb'
import * as ondra_ambient from '@ondra/cordis-plugin-ondra-ambient'
import * as ondra_asr from '@ondra/cordis-plugin-ondra-asr'
import * as ondra_avatar from '@ondra/cordis-plugin-ondra-avatar'
import * as ondra_beichen_api from '@ondra/cordis-plugin-ondra-beichen-api'
import * as ondra_breath from '@ondra/cordis-plugin-ondra-breath'
import * as ondra_browser from '@ondra/cordis-plugin-ondra-browser'
import * as ondra_browser_pane from '@ondra/cordis-plugin-ondra-browser-pane'
import * as ondra_channel_health from '@ondra/cordis-plugin-ondra-channel-health'
import * as ondra_channel_kit from '@ondra/cordis-plugin-ondra-channel-kit'
import * as ondra_climb from '@ondra/cordis-plugin-ondra-climb'
import * as ondra_clock from '@ondra/cordis-plugin-ondra-clock'
import * as ondra_cocreate from '@ondra/cordis-plugin-ondra-cocreate'
import * as ondra_config_schema from '@ondra/cordis-plugin-ondra-config-schema'
import * as ondra_consistency_bench from '@ondra/cordis-plugin-ondra-consistency-bench'
import * as ondra_crisis from '@ondra/cordis-plugin-ondra-crisis'
import * as ondra_daily_brief from '@ondra/cordis-plugin-ondra-daily-brief'
import * as ondra_data_migrate from '@ondra/cordis-plugin-ondra-data-migrate'
import * as ondra_desktop_mcp from '@ondra/cordis-plugin-ondra-desktop-mcp'
import * as ondra_dev_companion from '@ondra/cordis-plugin-ondra-dev-companion'
import * as ondra_dev_rebrand from '@ondra/cordis-plugin-ondra-dev-rebrand'
import * as ondra_device_mcp from '@ondra/cordis-plugin-ondra-device-mcp'
import * as ondra_dialogue from '@ondra/cordis-plugin-ondra-dialogue'
import * as ondra_dialogue_protocol from '@ondra/cordis-plugin-ondra-dialogue-protocol'
import * as ondra_diary from '@ondra/cordis-plugin-ondra-diary'
import * as ondra_digital_health from '@ondra/cordis-plugin-ondra-digital-health'
import * as ondra_drive_gap from '@ondra/cordis-plugin-ondra-drive-gap'
import * as ondra_emotion_conflict from '@ondra/cordis-plugin-ondra-emotion-conflict'
import * as ondra_emotion_core from '@ondra/cordis-plugin-ondra-emotion-core'
import * as ondra_emotion_diffuse from '@ondra/cordis-plugin-ondra-emotion-diffuse'
import * as ondra_emotion_express from '@ondra/cordis-plugin-ondra-emotion-express'
import * as ondra_emotion_hormone from '@ondra/cordis-plugin-ondra-emotion-hormone'
import * as ondra_emotion_project from '@ondra/cordis-plugin-ondra-emotion-project'
import * as ondra_emotion_stage from '@ondra/cordis-plugin-ondra-emotion-stage'
import * as ondra_emotion_stress from '@ondra/cordis-plugin-ondra-emotion-stress'
import * as ondra_evidence_gate from '@ondra/cordis-plugin-ondra-evidence-gate'
import * as ondra_expression_decide from '@ondra/cordis-plugin-ondra-expression-decide'
import * as ondra_failure_attrib from '@ondra/cordis-plugin-ondra-failure-attrib'
import * as ondra_filter_chain from '@ondra/cordis-plugin-ondra-filter-chain'
import * as ondra_first_meet from '@ondra/cordis-plugin-ondra-first-meet'
import * as ondra_forget_right from '@ondra/cordis-plugin-ondra-forget-right'
import * as ondra_grow from '@ondra/cordis-plugin-ondra-grow'
import * as ondra_gui_agent from '@ondra/cordis-plugin-ondra-gui-agent'
import * as ondra_identity from '@ondra/cordis-plugin-ondra-identity'
import * as ondra_inject_dedupe from '@ondra/cordis-plugin-ondra-inject-dedupe'
import * as ondra_install_doctor from '@ondra/cordis-plugin-ondra-install-doctor'
import * as ondra_installer from '@ondra/cordis-plugin-ondra-installer'
import * as ondra_lexicon from '@ondra/cordis-plugin-ondra-lexicon'
import * as ondra_life_rhythm from '@ondra/cordis-plugin-ondra-life-rhythm'
import * as ondra_live from '@ondra/cordis-plugin-ondra-live'
import * as ondra_llm_gateway from '@ondra/cordis-plugin-ondra-llm-gateway'
import * as ondra_log_zh from '@ondra/cordis-plugin-ondra-log-zh'
import * as ondra_market from '@ondra/cordis-plugin-ondra-market'
import * as ondra_memory_audit from '@ondra/cordis-plugin-ondra-memory-audit'
import * as ondra_memory_core from '@ondra/cordis-plugin-ondra-memory-core'
import * as ondra_memory_decay from '@ondra/cordis-plugin-ondra-memory-decay'
import * as ondra_memory_dedupe from '@ondra/cordis-plugin-ondra-memory-dedupe'
import * as ondra_memory_dream from '@ondra/cordis-plugin-ondra-memory-dream'
import * as ondra_memory_extract from '@ondra/cordis-plugin-ondra-memory-extract'
import * as ondra_memory_git from '@ondra/cordis-plugin-ondra-memory-git'
import * as ondra_memory_graph from '@ondra/cordis-plugin-ondra-memory-graph'
import * as ondra_memory_heal from '@ondra/cordis-plugin-ondra-memory-heal'
import * as ondra_memory_humanlike from '@ondra/cordis-plugin-ondra-memory-humanlike'
import * as ondra_memory_intake from '@ondra/cordis-plugin-ondra-memory-intake'
import * as ondra_memory_pool from '@ondra/cordis-plugin-ondra-memory-pool'
import * as ondra_memory_prospective from '@ondra/cordis-plugin-ondra-memory-prospective'
import * as ondra_memory_recall from '@ondra/cordis-plugin-ondra-memory-recall'
import * as ondra_memory_recognition from '@ondra/cordis-plugin-ondra-memory-recognition'
import * as ondra_memory_vector from '@ondra/cordis-plugin-ondra-memory-vector'
import * as ondra_minecraft from '@ondra/cordis-plugin-ondra-minecraft'
import * as ondra_multimodal_memory from '@ondra/cordis-plugin-ondra-multimodal-memory'
import * as ondra_narrative_log from '@ondra/cordis-plugin-ondra-narrative-log'
import * as ondra_onboarding from '@ondra/cordis-plugin-ondra-onboarding'
import * as ondra_onthisday from '@ondra/cordis-plugin-ondra-onthisday'
import * as ondra_oral from '@ondra/cordis-plugin-ondra-oral'
import * as ondra_organ_gate from '@ondra/cordis-plugin-ondra-organ-gate'
import * as ondra_organ_host from '@ondra/cordis-plugin-ondra-organ-host'
import * as ondra_our_free_model from '@ondra/cordis-plugin-ondra-our-free-model'
import * as ondra_path_layout from '@ondra/cordis-plugin-ondra-path-layout'
import * as ondra_persona_assemble from '@ondra/cordis-plugin-ondra-persona-assemble'
import * as ondra_persona_core from '@ondra/cordis-plugin-ondra-persona-core'
import * as ondra_persona_evolve from '@ondra/cordis-plugin-ondra-persona-evolve'
import * as ondra_persona_loader from '@ondra/cordis-plugin-ondra-persona-loader'
import * as ondra_persona_vars from '@ondra/cordis-plugin-ondra-persona-vars'
import * as ondra_persona_workshop from '@ondra/cordis-plugin-ondra-persona-workshop'
import * as ondra_pet from '@ondra/cordis-plugin-ondra-pet'
import * as ondra_pet_mobile from '@ondra/cordis-plugin-ondra-pet-mobile'
import * as ondra_port_picker from '@ondra/cordis-plugin-ondra-port-picker'
import * as ondra_privacy from '@ondra/cordis-plugin-ondra-privacy'
import * as ondra_proactive_gate from '@ondra/cordis-plugin-ondra-proactive-gate'
import * as ondra_proactive_quota from '@ondra/cordis-plugin-ondra-proactive-quota'
import * as ondra_proactive_reason from '@ondra/cordis-plugin-ondra-proactive-reason'
import * as ondra_process_host from '@ondra/cordis-plugin-ondra-process-host'
import * as ondra_prompt_inject from '@ondra/cordis-plugin-ondra-prompt-inject'
import * as ondra_recall_eval from '@ondra/cordis-plugin-ondra-recall-eval'
import * as ondra_redteam from '@ondra/cordis-plugin-ondra-redteam'
import * as ondra_reflex from '@ondra/cordis-plugin-ondra-reflex'
import * as ondra_rhythm from '@ondra/cordis-plugin-ondra-rhythm'
import * as ondra_rhythm_typing from '@ondra/cordis-plugin-ondra-rhythm-typing'
import * as ondra_ritual from '@ondra/cordis-plugin-ondra-ritual'
import * as ondra_router from '@ondra/cordis-plugin-ondra-router'
import * as ondra_sandbox from '@ondra/cordis-plugin-ondra-sandbox'
import * as ondra_screen_sense from '@ondra/cordis-plugin-ondra-screen-sense'
import * as ondra_snapshot from '@ondra/cordis-plugin-ondra-snapshot'
import * as ondra_startup_check from '@ondra/cordis-plugin-ondra-startup-check'
import * as ondra_sticker from '@ondra/cordis-plugin-ondra-sticker'
import * as ondra_store_json from '@ondra/cordis-plugin-ondra-store-json'
import * as ondra_store_memory from '@ondra/cordis-plugin-ondra-store-memory'
import * as ondra_store_sqlite from '@ondra/cordis-plugin-ondra-store-sqlite'
import * as ondra_study from '@ondra/cordis-plugin-ondra-study'
import * as ondra_theater from '@ondra/cordis-plugin-ondra-theater'
import * as ondra_time_capsule from '@ondra/cordis-plugin-ondra-time-capsule'
import * as ondra_trust_dashboard from '@ondra/cordis-plugin-ondra-trust-dashboard'
import * as ondra_tts from '@ondra/cordis-plugin-ondra-tts'
import * as ondra_tts_gate from '@ondra/cordis-plugin-ondra-tts-gate'
import * as ondra_vision from '@ondra/cordis-plugin-ondra-vision'
import * as ondra_weather from '@ondra/cordis-plugin-ondra-weather'
import * as ondra_webhook_inbox from '@ondra/cordis-plugin-ondra-webhook-inbox'
import * as ondra_weekly from '@ondra/cordis-plugin-ondra-weekly'
import * as ondra_window from '@ondra/cordis-plugin-ondra-window'
import * as ondra_worldbook from '@ondra/cordis-plugin-ondra-worldbook'
import * as ondra_worldbook_scenes from '@ondra/cordis-plugin-ondra-worldbook-scenes'
import * as ondra_zero_residence from '@ondra/cordis-plugin-ondra-zero-residence'

/**
 * 全部核心成员。
 *
 * 单一来源：这份数组就是「空谷由哪些插件组成」的完整答案。
 * 旧仓库需要把 134 份补丁文件与宿主基准配置叠在一起求并集才能回答同一个问题。
 */
export const members: readonly CoreMember[] = [
  { id: 'ondra-absence', plugin: ondra_absence },
  { id: 'ondra-adapter-dingtalk', plugin: ondra_adapter_dingtalk },
  { id: 'ondra-adapter-discord', plugin: ondra_adapter_discord },
  { id: 'ondra-adapter-feishu', plugin: ondra_adapter_feishu },
  { id: 'ondra-adapter-qq-napcat', plugin: ondra_adapter_qq_napcat },
  { id: 'ondra-adapter-qq-official', plugin: ondra_adapter_qq_official },
  { id: 'ondra-adapter-telegram', plugin: ondra_adapter_telegram },
  { id: 'ondra-adapter-wechat-kf', plugin: ondra_adapter_wechat_kf },
  { id: 'ondra-adapter-wechat-official', plugin: ondra_adapter_wechat_official },
  { id: 'ondra-adapter-wechat-personal', plugin: ondra_adapter_wechat_personal },
  { id: 'ondra-adapter-wecom', plugin: ondra_adapter_wecom },
  { id: 'ondra-adb', plugin: ondra_adb },
  { id: 'ondra-ambient', plugin: ondra_ambient },
  { id: 'ondra-asr', plugin: ondra_asr },
  { id: 'ondra-avatar', plugin: ondra_avatar },
  { id: 'ondra-beichen-api', plugin: ondra_beichen_api },
  { id: 'ondra-breath', plugin: ondra_breath },
  { id: 'ondra-browser', plugin: ondra_browser },
  { id: 'ondra-browser-pane', plugin: ondra_browser_pane },
  { id: 'ondra-channel-health', plugin: ondra_channel_health },
  { id: 'ondra-channel-kit', plugin: ondra_channel_kit },
  { id: 'ondra-climb', plugin: ondra_climb },
  { id: 'ondra-clock', plugin: ondra_clock },
  { id: 'ondra-cocreate', plugin: ondra_cocreate },
  { id: 'ondra-config-schema', plugin: ondra_config_schema },
  { id: 'ondra-consistency-bench', plugin: ondra_consistency_bench },
  { id: 'ondra-crisis', plugin: ondra_crisis },
  { id: 'ondra-daily-brief', plugin: ondra_daily_brief },
  { id: 'ondra-data-migrate', plugin: ondra_data_migrate },
  { id: 'ondra-desktop-mcp', plugin: ondra_desktop_mcp },
  { id: 'ondra-dev-companion', plugin: ondra_dev_companion },
  { id: 'ondra-dev-rebrand', plugin: ondra_dev_rebrand },
  { id: 'ondra-device-mcp', plugin: ondra_device_mcp },
  { id: 'ondra-dialogue', plugin: ondra_dialogue },
  { id: 'ondra-dialogue-protocol', plugin: ondra_dialogue_protocol },
  { id: 'ondra-diary', plugin: ondra_diary },
  { id: 'ondra-digital-health', plugin: ondra_digital_health },
  { id: 'ondra-drive-gap', plugin: ondra_drive_gap },
  { id: 'ondra-emotion-conflict', plugin: ondra_emotion_conflict },
  { id: 'ondra-emotion-core', plugin: ondra_emotion_core },
  { id: 'ondra-emotion-diffuse', plugin: ondra_emotion_diffuse },
  { id: 'ondra-emotion-express', plugin: ondra_emotion_express },
  { id: 'ondra-emotion-hormone', plugin: ondra_emotion_hormone },
  { id: 'ondra-emotion-project', plugin: ondra_emotion_project },
  { id: 'ondra-emotion-stage', plugin: ondra_emotion_stage },
  { id: 'ondra-emotion-stress', plugin: ondra_emotion_stress },
  { id: 'ondra-evidence-gate', plugin: ondra_evidence_gate },
  { id: 'ondra-expression-decide', plugin: ondra_expression_decide },
  { id: 'ondra-failure-attrib', plugin: ondra_failure_attrib },
  { id: 'ondra-filter-chain', plugin: ondra_filter_chain },
  { id: 'ondra-first-meet', plugin: ondra_first_meet },
  { id: 'ondra-forget-right', plugin: ondra_forget_right },
  { id: 'ondra-grow', plugin: ondra_grow },
  { id: 'ondra-gui-agent', plugin: ondra_gui_agent },
  { id: 'ondra-identity', plugin: ondra_identity },
  { id: 'ondra-inject-dedupe', plugin: ondra_inject_dedupe },
  { id: 'ondra-install-doctor', plugin: ondra_install_doctor },
  { id: 'ondra-installer', plugin: ondra_installer },
  { id: 'ondra-lexicon', plugin: ondra_lexicon },
  { id: 'ondra-life-rhythm', plugin: ondra_life_rhythm },
  { id: 'ondra-live', plugin: ondra_live },
  { id: 'ondra-llm-gateway', plugin: ondra_llm_gateway },
  { id: 'ondra-log-zh', plugin: ondra_log_zh },
  { id: 'ondra-market', plugin: ondra_market },
  { id: 'ondra-memory-audit', plugin: ondra_memory_audit },
  { id: 'ondra-memory-core', plugin: ondra_memory_core },
  { id: 'ondra-memory-decay', plugin: ondra_memory_decay },
  { id: 'ondra-memory-dedupe', plugin: ondra_memory_dedupe },
  { id: 'ondra-memory-dream', plugin: ondra_memory_dream },
  { id: 'ondra-memory-extract', plugin: ondra_memory_extract },
  { id: 'ondra-memory-git', plugin: ondra_memory_git },
  { id: 'ondra-memory-graph', plugin: ondra_memory_graph },
  { id: 'ondra-memory-heal', plugin: ondra_memory_heal },
  { id: 'ondra-memory-humanlike', plugin: ondra_memory_humanlike },
  { id: 'ondra-memory-intake', plugin: ondra_memory_intake },
  { id: 'ondra-memory-pool', plugin: ondra_memory_pool },
  { id: 'ondra-memory-prospective', plugin: ondra_memory_prospective },
  { id: 'ondra-memory-recall', plugin: ondra_memory_recall },
  { id: 'ondra-memory-recognition', plugin: ondra_memory_recognition },
  { id: 'ondra-memory-vector', plugin: ondra_memory_vector },
  { id: 'ondra-minecraft', plugin: ondra_minecraft },
  { id: 'ondra-multimodal-memory', plugin: ondra_multimodal_memory },
  { id: 'ondra-narrative-log', plugin: ondra_narrative_log },
  { id: 'ondra-onboarding', plugin: ondra_onboarding },
  { id: 'ondra-onthisday', plugin: ondra_onthisday },
  { id: 'ondra-oral', plugin: ondra_oral },
  { id: 'ondra-organ-gate', plugin: ondra_organ_gate },
  { id: 'ondra-organ-host', plugin: ondra_organ_host },
  { id: 'ondra-our-free-model', plugin: ondra_our_free_model },
  { id: 'ondra-path-layout', plugin: ondra_path_layout },
  { id: 'ondra-persona-assemble', plugin: ondra_persona_assemble },
  { id: 'ondra-persona-core', plugin: ondra_persona_core },
  { id: 'ondra-persona-evolve', plugin: ondra_persona_evolve },
  { id: 'ondra-persona-loader', plugin: ondra_persona_loader },
  { id: 'ondra-persona-vars', plugin: ondra_persona_vars },
  { id: 'ondra-persona-workshop', plugin: ondra_persona_workshop },
  { id: 'ondra-pet', plugin: ondra_pet },
  { id: 'ondra-pet-mobile', plugin: ondra_pet_mobile },
  { id: 'ondra-port-picker', plugin: ondra_port_picker },
  { id: 'ondra-privacy', plugin: ondra_privacy },
  { id: 'ondra-proactive-gate', plugin: ondra_proactive_gate },
  { id: 'ondra-proactive-quota', plugin: ondra_proactive_quota },
  { id: 'ondra-proactive-reason', plugin: ondra_proactive_reason },
  { id: 'ondra-process-host', plugin: ondra_process_host },
  { id: 'ondra-prompt-inject', plugin: ondra_prompt_inject },
  { id: 'ondra-recall-eval', plugin: ondra_recall_eval },
  { id: 'ondra-redteam', plugin: ondra_redteam },
  { id: 'ondra-reflex', plugin: ondra_reflex },
  { id: 'ondra-rhythm', plugin: ondra_rhythm },
  { id: 'ondra-rhythm-typing', plugin: ondra_rhythm_typing },
  { id: 'ondra-ritual', plugin: ondra_ritual },
  { id: 'ondra-router', plugin: ondra_router },
  { id: 'ondra-sandbox', plugin: ondra_sandbox },
  { id: 'ondra-screen-sense', plugin: ondra_screen_sense },
  { id: 'ondra-snapshot', plugin: ondra_snapshot },
  { id: 'ondra-startup-check', plugin: ondra_startup_check },
  { id: 'ondra-sticker', plugin: ondra_sticker },
  { id: 'ondra-store-json', plugin: ondra_store_json },
  { id: 'ondra-store-memory', plugin: ondra_store_memory },
  { id: 'ondra-store-sqlite', plugin: ondra_store_sqlite },
  { id: 'ondra-study', plugin: ondra_study },
  { id: 'ondra-theater', plugin: ondra_theater },
  { id: 'ondra-time-capsule', plugin: ondra_time_capsule },
  { id: 'ondra-trust-dashboard', plugin: ondra_trust_dashboard },
  { id: 'ondra-tts', plugin: ondra_tts },
  { id: 'ondra-tts-gate', plugin: ondra_tts_gate },
  { id: 'ondra-vision', plugin: ondra_vision },
  { id: 'ondra-weather', plugin: ondra_weather },
  { id: 'ondra-webhook-inbox', plugin: ondra_webhook_inbox },
  { id: 'ondra-weekly', plugin: ondra_weekly },
  { id: 'ondra-window', plugin: ondra_window },
  { id: 'ondra-worldbook', plugin: ondra_worldbook },
  { id: 'ondra-worldbook-scenes', plugin: ondra_worldbook_scenes },
  { id: 'ondra-zero-residence', plugin: ondra_zero_residence },
]

/**
 * 把空谷核心装载到上下文。
 *
 * ## 默认全部禁用
 *
 * 这里的 134 个成员属于旧项目那套 dsh 功能（情绪、记忆、人设、各类 IM 适配器），
 * 当前界面一个都没接。它们的代码随包分发（用户能在包里看到这些东西存在），
 * 但不装载——所以默认 `enabled: false`。
 *
 * 「装着不用」而不是「干脆不打包」是有意的：这些是产品的一部分，
 * 将来逐个接通时只需要把 `enabled` 改成 true，不必重新设计打包流程。
 *
 * @param ctx 根上下文。
 * @param options.enable 要启用的成员 id 列表。空数组表示全部禁用（默认）。
 * @param options.extra 额外成员。用于测试或用户自定义，排在核心成员之后装载。
 * @returns 装配结果。
 */
export async function loadCore(
  ctx: Context,
  options: { enable?: readonly string[]; extra?: readonly CoreMember[] } = {},
): Promise<CoreLoadResult> {
  const enabled = new Set(options.enable ?? [])
  const list = [...members, ...(options.extra ?? [])]

  // 没有显式启用名单时，整份清单都不装载。
  // 把 enabled 就地改写而不是在 loadMembers 里加分支：
  // 装载循环只该关心「这条要不要装」，不该知道「默认策略是什么」。
  const resolved = list.map((member) => ({
    ...member,
    enabled: enabled.size === 0 ? false : enabled.has(member.id),
  }))

  return loadMembers(ctx, resolved)
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
