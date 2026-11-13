/**
 * 设置三层的数据底座。
 *
 * ## 这一层解决什么
 *
 * 原始层有 1116 个字段，但没有人会从 1116 个字段里找到"让她少说两句"。
 * 场景层就是**从这 1110 个里挑出的 12 个真实旋钮**，每项一句话说清它管什么。
 *
 * ## 三条不可让步的规矩（§5.13）
 *
 * 1. **一项只绑一个字段**。第 8 项「作息」绑两个键，是唯一例外——它表达的是
 *    一个区间，拆成两个滑杆就不叫"作息"了。
 * 2. **不伪造取值范围**。滑杆两端必须是字段声明的 `min/max`。界面收窄会让
 *    用户"拉到底却没真正到底"，那是最隐蔽的一类谎。
 * 3. **不新增任何字段**。这一层只是既有字段的视图，绑定的每个键都在插件
 *    `FIELD_SPECS` 里真实存在。§5.13 旧表有 10 个键根本不存在，已全部换掉或删除。
 *
 * ## 键名为什么用 kebab
 *
 * 配置文件里写的就是 kebab（`archive-normal-days`）。`FIELD_SPECS` 里的
 * camelCase 由插件自己的 `KEY_PAIRS` 对应，**不是大小写转换**。宿主扫描时
 * 已经用 `SECTION_KEYS` 反查回 kebab，所以这里直接用配置里的写法，
 * 界面与文件说的是同一个键。
 */

import type { SettingsField, SettingsSection } from './settingTypes.ts'

/** 场景项的一种控件语言。由字段 `kind` 决定，不另立映射。 */
export type SceneControl =
  /** 数字 + 分段锚点。锚点只是快捷值，必须能展开成滑杆改任意值。 */
  | 'number-anchored'
  /** 纯数字滑杆，无锚点。 */
  | 'number'
  /** 开关。 */
  | 'boolean'
  /** 纯分段：底层是 enum，一档对一个真实取值。 */
  | 'enum'
  /** 时间区间：两个 `HH:MM` 输入，画成 24 小时横轴。 */
  | 'range-time'

/** 分段控件的一档。 */
export interface SceneOption {
  value: string
  label: string
}

/** 场景层的一项。 */
export interface SceneItem {
  /** 稳定 id，用于改动记录与撤销。 */
  id: string
  /** 中文名。 */
  name: string
  /** 绑定的段 id（配置里的写法）。 */
  section: string
  /** 绑定的段名，段找不到时用来显示"这个插件没装"。 */
  sectionTitle: string
  /** 主字段键。 */
  key: string
  /** 第二字段键。只有「作息」用。 */
  keyEnd?: string
  control: SceneControl
  /**
   * 分段锚点。`number-anchored` 时是快捷值，`enum` 时是唯一取值集合。
   * 文案与值分开：用户读「一年」，配置里存 `365`。
   */
  options?: SceneOption[]
  /** 滑杆下方的语义锚点文字，如「克制 —— 自然 —— 热情」。 */
  scale?: readonly [string, string, string]
  /** 控件旁的一行提示。 */
  hint?: string
  /**
   * 数字读数的单位，如「天」「分钟」「字」「轮」。
   *
   * ## 为什么必须有这一项
   *
   * 滑杆只显示一个裸数字时，用户读到的信息是不完整的：「记忆保留深度」
   * 显示 `30`，到底是 30 天、30 条、还是 30 次？字段 `archive-normal-days`
   * 的名字里写着 days，但那个名字用户看不到。`aria-valuetext` 同样是裸
   * 数字，读屏用户拿到的信息更少。
   *
   * 单位属于**字段语义**，不属于渲染：同一个数字在不同场景里可以是天、
   * 分钟或轮。所以它跟着场景项定义走，渲染处只负责拼在读数后面——
   * 一份真源，两处（视觉与 `aria-valuetext`）共用。
   *
   * 布尔与枚举项不需要，留空即可。
   */
  unit?: string
  /**
   * 预演函数。只有 §5.13 点名的 6 项有。
   *
   * 返回一句人话，说明「这组参数会产生什么效果」。**不调模型**，
   * 只用本地规则算形状——预演演的是参数的影响，不是她会说什么。
   */
  preview?: (values: SceneValues) => string
}

/** 一次读取里拿到的全部取值：`段 → 键 → 值`。 */
export type SceneValues = Record<string, Record<string, unknown>>

/**
 * 12 项场景的定义。
 *
 * 顺序即渲染顺序，按「先她是谁、再她怎么说话、再她怎么记事、最后安全」排，
 * 而不是按字段所属插件排——用户读到的是一件事，不是一张插件清单。
 */
export const SCENE_ITEMS: readonly SceneItem[] = Object.freeze([
  {
    id: 'memory-depth',
    name: '记忆保留深度',
    section: 'memory-core',
    sectionTitle: '记忆内核',
    key: 'archive-normal-days',
    control: 'number-anchored',
    unit: '天',
    // 四档只是 30 / 90 / 365 / 3650 的显示名。字段 min:1 max:3650，
    // 所以滑杆必须能拉到任意天数（步长 1），不能只给这四档。
    options: [
      { value: '30', label: '一个月' },
      { value: '90', label: '三个月' },
      { value: '365', label: '一年' },
      { value: '3650', label: '十年' },
    ],
    preview: (values) => {
      const days = readNumber(values, 'memory-core', 'archive-normal-days', 30)
      return `${String(days)} 天未提及的记忆将转入归档，仍可查阅`
    },
  },
  {
    id: 'proactive-rate',
    name: '主动发言频率',
    section: 'proactive-quota',
    sectionTitle: '主动配额',
    key: 'profile',
    control: 'enum',
    // 只有三档。「关闭」由 enable 表达，不在这里多造一档——
    // 两个「关」并存会让用户关了一个、另一个还在工作。
    options: [
      { value: 'slow', label: '偶尔' },
      { value: 'standard', label: '正常' },
      { value: 'fast', label: '主动' },
    ],
    /*
     * 这里曾经写「去原始层关掉 proactive-quota 的 enable」。
     *
     * 那句是错的，而且错得伤人：用户照做之后她照样开口——实测
     * `proactive-quota.enable=false` 下 `/api/proactive/check` 仍返回
     * `allow:true`、额度仍是 3（节律的 `patch()` 不看自己这个开关）。
     * 唯一的真开关在主动闸门：`proactive-gate.enable=false` 会在第一道闸
     * 就 drop/disabled，那才是「她不再主动说话」。
     */
    /*
     * 指引改到「通用 · 主动发言」：那三个段已从扩展功能上移，界面上
     * 有了名字叫「开口时机与限额」的折叠区。继续指「原始」层会让用户
     * 按旧路径去找一个已经不在那里的东西。
     */
    hint: '如需完全关闭主动发言，到「通用 · 主动发言」里关掉「开口时机与限额」的总开关',
    preview: (values) => {
      const profile = readString(values, 'proactive-quota', 'profile', 'standard')
      const perDay = profile === 'slow' ? 1 : profile === 'fast' ? 6 : 3
      return `约每日 ${String(perDay)} 条`
    },
  },
  /*
   * 这一项原来绑 `proactive-gate.daily-quota`，那个键是**死的**：
   * 主动节律在位时，宿主把 `patch()` 算出的档位额度当入参交给门控，
   * 门控一律用入参（`budgetOf()`：`fromCaller ? override : settings.dailyQuota`），
   * 于是这个滑杆拖到哪都不影响任何一次判定——设置页能拖、能落盘、
   * 界面写着「已改」，而她每天说的条数一个不变。
   *
   * 现在改绑 `idle-minutes`：会话安静满这么久她才允许插话，是门控自己
   * 读的那个数，没有被谁覆盖，拖一下立刻能感觉到。
   *
   * 注：这里不能用块注释夹在 `id:` 前面——`check-acceptance` 的场景解析器
   * 按 `\n  {\n    id: '` 切块，中间插任何东西都会让这一项整块漏掉。
   */
  {
    id: 'proactive-cap',
    name: '主动发言静默阈值',
    section: 'proactive-gate',
    sectionTitle: '主动闸门',
    key: 'idle-minutes',
    control: 'number-anchored',
    unit: '分钟',
    /*
     * 四档只是显示名。字段 min:0 max:1440，滑杆必须仍能拉到任意分钟——
     * 0–1440 的线性滑杆把常用的 5–60 分钟挤在最左边几个像素里，
     * 不给锚点就基本没法精确落到「25」这种值（默认值恰好是 25）。
     */
    options: [
      { value: '5', label: '五分钟' },
      { value: '15', label: '一刻钟' },
      { value: '30', label: '半小时' },
      { value: '120', label: '两小时' },
    ],
    hint: '会话静默达到该时长后，允许主动发言',
  },
  {
    id: 'tone',
    name: '人格浓度',
    section: 'persona-vars',
    sectionTitle: '人格变量与浓度',
    key: 'tone-level',
    control: 'number',
    unit: '%',
    scale: ['克制', '自然', '热情'],
    preview: (values) => {
      const level = readNumber(values, 'persona-vars', 'tone-level', 50)
      // 三档对照同一句话，让「浓度」这个抽象参数有一次可见的差别。
      const samples: readonly [string, string, string] = ['嗯。', '嗯，我在。', '在的在的，怎么啦？']
      const index = level < 34 ? 0 : level < 67 ? 1 : 2
      return `同一句「我在」在当前浓度下写作：${samples[index] ?? samples[1]}`
    },
  },
  {
    id: 'message-length',
    name: '单条消息长度',
    section: 'rhythm',
    sectionTitle: '节奏',
    key: 'max-chars-per-message',
    control: 'number',
    unit: '字',
    scale: ['短', '适中', '长'],
    hint: '长度越短，越接近即时消息节奏',
    preview: (values) => {
      const limit = readNumber(values, 'rhythm', 'max-chars-per-message', 40)
      // 用一条 120 字的长回复演示切分。条数按上限整除后向上取整。
      const count = Math.max(1, Math.ceil(120 / Math.max(1, limit)))
      return `一条 120 字的回复会被切成 ${String(count)} 条`
    },
  },
  {
    id: 'typing-speed',
    name: '打字的节奏',
    section: 'rhythm',
    sectionTitle: '节奏',
    key: 'chars-per-second',
    control: 'number',
    unit: '字/秒',
    scale: ['慢', '自然', '快'],
    preview: (values) => {
      const speed = readNumber(values, 'rhythm', 'chars-per-second', 6)
      const seconds = 40 / Math.max(1, speed)
      // 一位小数即可：差 0.1 秒人感知不到，写成两位反而显得精密过头。
      return `一条 40 字的消息会显示约 ${seconds.toFixed(1)} 秒`
    },
  },
  {
    id: 'context-turns',
    name: '上下文长度',
    section: 'dialogue',
    sectionTitle: '对话',
    key: 'max-turns',
    control: 'number-anchored',
    unit: '轮',
    // 用 max-turns 而不是 max-tokens：后者默认 0 表示「不设上限」，
    // 做成滑杆后最左端等于「无限」，语义是反的。
    options: [
      { value: '4', label: '短' },
      { value: '10', label: '中' },
      { value: '20', label: '长' },
    ],
    preview: (values) => {
      const turns = readNumber(values, 'dialogue', 'max-turns', 10)
      if (turns <= 1) return '仅携带 1 轮，无法体现多轮上下文'
      return `保留最近 ${String(turns)} 轮对话作为上下文`
    },
  },
  {
    id: 'rest-window',
    name: '作息',
    section: 'life-rhythm',
    sectionTitle: '作息节律',
    key: 'rest-start',
    keyEnd: 'rest-end',
    control: 'range-time',
    hint: '该时段内不主动发言',
  },
  {
    id: 'proactive-reason',
    name: '主动消息可解释',
    section: 'proactive-reason',
    sectionTitle: '主动话由',
    key: 'pool-enabled',
    control: 'boolean',
    hint: '每条主动消息附带触发原因',
  },
  {
    id: 'audit-interval',
    name: '遗忘复核周期',
    section: 'memory-audit',
    sectionTitle: '遗忘审计',
    key: 'resurface-days',
    control: 'number',
    unit: '天',
  },
  {
    id: 'tts',
    name: '语音',
    section: 'tts',
    sectionTitle: '语音合成',
    key: 'enable',
    control: 'boolean',
    hint: '启用后回复可朗读',
  },
  {
    id: 'approval',
    name: '高风险操作',
    section: 'privacy',
    sectionTitle: '隐私闸门',
    key: 'approval-mode',
    control: 'enum',
    options: [
      { value: 'supervised', label: '全部确认' },
      { value: 'auto', label: '仅高风险确认' },
      { value: 'full', label: '不确认' },
    ],
  },
])

/** 从取值表里安全取一个数字。缺失时回落到插件声明的默认值。 */
function readNumber(values: SceneValues, section: string, key: string, fallback: number): number {
  const raw = values[section]?.[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

/** 从取值表里安全取一个字符串。 */
function readString(values: SceneValues, section: string, key: string, fallback: string): string {
  const raw = values[section]?.[key]
  return typeof raw === 'string' && raw !== '' ? raw : fallback
}

/**
 * 一个场景项在界面上的实际取值。
 *
 * 优先级：用户层改过的值 → 插件默认值。中间那两层（出厂 / 组合包）目前
 * 恒为空，宿主也没有接口去读它们，所以这里只有两档。
 *
 * **为什么由界面合并而不是宿主合并**：用户层是一份稀疏覆盖表，
 * 合并规则只有"用户层优先"一条。宿主返回默认值与覆盖值，界面合并，
 * 这样界面上"已改"标记（`changed`）与取值用的是同一次判断，不可能打架。
 */
export interface SceneState {
  /** 当前生效值。 */
  value: unknown
  /** 插件声明的默认值。 */
  fallback: unknown
  /** 用户是否改过。 */
  changed: boolean
  /** 对应字段的声明。undefined 表示段或字段不存在（插件没装）。 */
  field: SettingsField | undefined
  /** 区间终点的字段声明，仅「作息」有。 */
  endField?: SettingsField | undefined
  /** 区间终点的当前生效值，仅「作息」有。 */
  endValue?: unknown
}

/** 取一个场景项的真实取值与声明。 */
export function resolveScene(item: SceneItem, sections: readonly SettingsSection[], user: SceneValues): SceneState {
  const section = sections.find((candidate) => candidate.id === item.section)
  const field = section?.fields.find((candidate) => candidate.key === item.key)
  const endField = item.keyEnd === undefined
    ? undefined
    : section?.fields.find((candidate) => candidate.key === item.keyEnd)

  const override = user[item.section]?.[item.key]
  const state: SceneState = {
    value: override !== undefined ? override : field?.default,
    fallback: field?.default,
    changed: override !== undefined,
    field,
  }
  if (item.keyEnd !== undefined) {
    const endOverride = user[item.section]?.[item.keyEnd]
    state.endField = endField
    state.endValue = endOverride !== undefined ? endOverride : endField?.default
  }
  return state
}

/**
 * 把场景层的一项改动摊平成若干次字段写入。
 *
 * 「作息」是唯一返回两项的：`rest-start` 与 `rest-end` 各写一次。
 * 其余一律一项。返回空数组表示这一项没有可写的值（插件没装）。
 */
export function writesFor(item: SceneItem, value: unknown, endValue?: unknown): Array<{ section: string; key: string; value: unknown }> {
  const out: Array<{ section: string; key: string; value: unknown }> = [
    { section: item.section, key: item.key, value },
  ]
  if (item.keyEnd !== undefined) {
    out.push({ section: item.section, key: item.keyEnd, value: endValue })
  }
  return out
}
