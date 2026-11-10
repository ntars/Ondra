/**
 * O-138 的**默认规则表**：关键词 → 工具族。全部是确定性映射，没有一个模型调用。
 *
 * ## 规则表为什么可以写死在代码里
 *
 * 因为它要能被审计。一条门控决定必须能一句话说清「因为出现了这两个字」，
 * 而不是「模型觉得」。写死 + 可被配置覆盖，是「可解释」的最低成本实现。
 *
 * ## 工具名不是编的
 *
 * 下面每一条 `toolPatterns` 都对应 `desktop/docs/tool-catalog.zh.md` 里
 * **真实注册**的工具名（`read` / `edit` / `write` / `glob` / `grep` / `bash` /
 * `pwsh` / `terminal_*` / `web_search` / `web_fetch` / `stagehand_*` /
 * `subagent` / `team_task_*` / `todo_write` / `schedule_*` …）。
 * 拼错一个前缀的后果不是报错，是**规则永远匹配不上**，而门控看起来「在工作」
 * （`no-match` 会被单独计数，就是为了让这种情况露出来）。
 *
 * ## 两个刻意的取舍
 *
 * 1. **英文关键词按词边界匹配，中文按子串。** 中文没有词边界，只能子串；
 *    但英文按子串会出事——`read` 会命中 `already`，`run` 会命中 `truncate`。
 *    所以纯 ASCII 的关键词走 `\b` 语义，含中文的走 `includes`。
 * 2. **只支持尾部星号。** `terminal_*` 能一眼看出匹配了谁；`*read` 与 `re*d`
 *    需要解释，而「需要解释」正是本包想消灭的东西。
 */

import type { IntentRule } from './types.js'

/**
 * 无论如何都不许摘的工具。
 *
 * 判据：它们是**说话的方式**，不是**做事的能力**。
 * 摘掉 `ask_user_question`，模型遇到歧义就只能瞎猜；摘掉 `present`，
 * 它做完了没法把东西摆出来；摘掉 `exit_plan_mode`，plan 模式会卡在那里。
 * `run_code` 是上游的保留传输名，`restrict()` 对它直接抛错（硬保护，不可配置）。
 */
export const ALWAYS_KEEP: readonly string[] = Object.freeze([
  'run_code',
  'ask_user_question',
  'present',
  'propose_action',
  'exit_plan_mode',
])

/** 默认规则表。顺序即报告顺序，不影响匹配结果。 */
export const DEFAULT_RULES: readonly IntentRule[] = Object.freeze([
  Object.freeze({
    id: 'fs-read',
    family: 'fs-read',
    doc: '要看、要读、要搜：只给读类工具',
    keywords: Object.freeze([
      '读', '看', '打开', '查看', '内容', '文件', '代码', '搜', '找', '路径', '目录', '图片', '截图',
      '日志', '会话', '报错',
      'read', 'open', 'show', 'look', 'inspect', 'grep', 'search', 'find', 'file', 'log',
    ]),
    toolPatterns: Object.freeze(['read', 'read_image', 'glob', 'grep', 'lsp', 'session_search']),
  }),
  Object.freeze({
    id: 'fs-write',
    family: 'fs-write',
    doc: '要改、要写、要删：只给写类工具',
    keywords: Object.freeze([
      '改', '写', '创建', '新建', '删除', '替换', '重命名', '重构', '保存', '补丁', '修正',
      'edit', 'write', 'create', 'delete', 'remove', 'rename', 'refactor', 'patch', 'fix',
    ]),
    toolPatterns: Object.freeze(['edit', 'write', 'str_replace_editor']),
  }),
  Object.freeze({
    id: 'shell',
    family: 'shell',
    doc: '要跑命令、要装依赖、要构建：只给 shell 类工具',
    keywords: Object.freeze([
      '运行', '执行', '命令', '终端', '安装', '构建', '编译', '测试', '启动', '脚本', '部署', '依赖',
      'run', 'exec', 'shell', 'terminal', 'install', 'build', 'test', 'start', 'deploy',
    ]),
    toolPatterns: Object.freeze(['bash', 'pwsh', 'terminal_*', 'load_workspace_dependencies']),
  }),
  Object.freeze({
    id: 'web',
    family: 'web',
    doc: '要联网查、要抓网页：只给网络类工具',
    keywords: Object.freeze([
      '联网', '网页', '网站', '链接', '上网', '下载', '抓取', '官网', '最新', '搜一下', '查一下',
      'web', 'http', 'url', 'browse', 'fetch', 'download', 'online',
    ]),
    toolPatterns: Object.freeze(['web_search', 'web_fetch', 'stagehand_*']),
  }),
  Object.freeze({
    id: 'agent',
    family: 'agent',
    doc: '要分工、要并行、要后台：只给子代理类工具',
    keywords: Object.freeze([
      '子任务', '并行', '分工', '团队', '委派', '后台', '多个', '同时', '协作',
      'subagent', 'agent', 'team', 'parallel', 'delegate', 'spawn',
    ]),
    toolPatterns: Object.freeze([
      'subagent', 'subagent_oar', 'spawn_teammate', 'team_task_*', 'send_message',
      'wait_agent', 'list_agents', 'list_subagent_models', 'interrupt_agent',
      'job_*', 'workflow', 'ralph',
    ]),
  }),
  Object.freeze({
    id: 'plan',
    family: 'plan',
    doc: '要排计划、要提醒、要定目标：只给计划类工具',
    keywords: Object.freeze([
      '计划', '待办', '目标', '提醒', '定时', '每天', '每周', '安排', '步骤', '清单',
      'plan', 'todo', 'goal', 'remind', 'schedule', 'daily', 'weekly',
    ]),
    toolPatterns: Object.freeze([
      'todo_write', 'create_goal', 'get_goal', 'update_goal', 'schedule_*',
    ]),
  }),
  Object.freeze({
    id: 'mcp',
    family: 'mcp',
    doc: '要用外部 MCP 资源：只给 MCP 资源类工具',
    keywords: Object.freeze(['mcp', '外部服务', '资源列表', '第三方']),
    toolPatterns: Object.freeze([
      'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
    ]),
  }),
  Object.freeze({
    id: 'meta',
    family: 'meta',
    doc: '要装插件、要看技能：只给插件与技能类工具',
    keywords: Object.freeze([
      '插件', '技能', '市场', '扩展', '装上', '卸载',
      'plugin', 'skill', 'market', 'extension',
    ]),
    toolPatterns: Object.freeze(['plugin_manager', 'plugin_market', 'skill', 'cordis_inspect_*']),
  }),
])

/** 纯 ASCII 词的形状（走词边界匹配）。 */
const ASCII_WORD_RE = /^[a-z0-9_-]+$/

/** 转义正则里的特殊字符（关键词里可能有 `_` / `-`，本身不特殊，但统一处理）。 */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 预编译后的关键词测试器缓存：同一个词只编一次。 */
const KEYWORD_CACHE = new Map<string, RegExp | undefined>()

/**
 * 一个关键词是否命中。
 * @param lowered 已转小写的正文。
 * @param keyword 关键词原文。
 */
export function keywordHit(lowered: string, keyword: string): boolean {
  const key = keyword.toLowerCase()
  if (key === '') return false
  if (!ASCII_WORD_RE.test(key)) {
    // 含中文（或含空格等）：没有词边界可言，直接子串。
    return lowered.includes(key)
  }
  let re = KEYWORD_CACHE.get(key)
  if (re === undefined && !KEYWORD_CACHE.has(key)) {
    // 两侧必须是「非字母数字下划线」或行首尾：`read` 不该命中 `already`。
    re = new RegExp('(^|[^a-z0-9_])' + escapeRe(key) + '([^a-z0-9_]|$)', 'i')
    KEYWORD_CACHE.set(key, re)
  }
  return re === undefined ? lowered.includes(key) : re.test(lowered)
}

/**
 * 一个工具名是否匹配一条模式。
 * @param pattern 模式：`read` 精确 / `terminal_*` 前缀。
 * @param tool 工具名。
 */
export function toolMatches(pattern: string, tool: string): boolean {
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1)
    return prefix !== '' && tool.startsWith(prefix)
  }
  return pattern === tool
}

/**
 * 正文命中了哪些规则。
 * @param rules 规则表。
 * @param text 用户原话。
 * @returns 命中的规则 id（按规则表顺序，去重）。
 */
export function matchRules(rules: readonly IntentRule[], text: string): readonly string[] {
  const lowered = text.toLowerCase()
  const out: string[] = []
  for (const rule of rules) {
    for (const keyword of rule.keywords) {
      if (keywordHit(lowered, keyword)) {
        if (!out.includes(rule.id)) out.push(rule.id)
        break
      }
    }
  }
  return Object.freeze(out)
}

/**
 * 命中规则所允许的工具名（与真实可见工具求交）。
 * @param rules 规则表。
 * @param hitIds 命中的规则 id。
 * @param toolNames 当前可见工具名。
 * @returns 允许的工具名（升序）。
 */
export function allowedTools(
  rules: readonly IntentRule[],
  hitIds: readonly string[],
  toolNames: readonly string[],
): readonly string[] {
  const patterns: string[] = []
  for (const rule of rules) {
    if (!hitIds.includes(rule.id)) continue
    for (const pattern of rule.toolPatterns) {
      if (!patterns.includes(pattern)) patterns.push(pattern)
    }
  }
  const out: string[] = []
  for (const tool of toolNames) {
    for (const pattern of patterns) {
      if (toolMatches(pattern, tool)) {
        out.push(tool)
        break
      }
    }
  }
  return Object.freeze(out)
}

/**
 * 规则表自检：id / family 合规、关键词非空、模式非空。
 *
 * 存在的理由：规则表是**数据**，写错一个前缀不会报错，只会永远匹配不上。
 * 启动时跑一遍，把「规则表本身有病」和「这一轮没命中」分开。
 * @param rules 规则表。
 * @returns 问题清单（空 = 没问题）。
 */
export function auditRules(rules: readonly IntentRule[]): readonly string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const rule of rules) {
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(rule.id)) problems.push('规则 id 不合规：' + rule.id)
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(rule.family)) problems.push('工具族名不合规：' + rule.family)
    if (seen.has(rule.id)) problems.push('规则 id 重复：' + rule.id)
    seen.add(rule.id)
    if (rule.keywords.length === 0) problems.push('规则没有关键词：' + rule.id)
    if (rule.toolPatterns.length === 0) problems.push('规则没有工具模式：' + rule.id)
    for (const pattern of rule.toolPatterns) {
      if (pattern === '*') problems.push('规则 ' + rule.id + ' 有裸星号模式：会匹配全部工具')
      if (pattern.includes('*') && !pattern.endsWith('*')) {
        problems.push('规则 ' + rule.id + ' 的模式 ' + pattern + ' 不是尾部星号：本包不支持')
      }
    }
  }
  return Object.freeze(problems)
}
