/**
 * 设置三层的数据底座。
 *
 * ## 这一层解决什么
 *
 * 原始层有 1168 个字段，但没有人会从 1168 个字段里找到"让她少说两句"。
 * 场景层就是**从这 1168 个里挑出的 13 个真实旋钮**，每项一句话说清它管什么。
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
 * 13 项场景的定义。
 *
 * 顺序即渲染顺序，按「先她是谁、再她怎么说话、再她怎么记事、最后安全」排，
 * 而不是按字段所属插件排——用户读到的是一件事，不是一张插件清单。
 */
export const SCENE_ITEMS: readonly SceneItem[] = Object.freeze([
  {
    id: 'memory-depth',
    name: '她记得多深',
    section: 'memory-core',
    sectionTitle: '记忆内核',
    key: 'archive-normal-days',
    control: 'number-anchored',
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
      return `${String(days)} 天没提到的记忆会沉底，仍可翻到`
    },
  },
  {
    id: 'proactive-rate',
    name: '她多主动',
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
    hint: '想让她完全不主动说话，去原始层关掉 proactive-quota 的 enable',
    preview: (values) => {
      const profile = readString(values, 'proactive-quota', 'profile', 'standard')
      const perDay = profile === 'slow' ? 1 : profile === 'fast' ? 6 : 3
      return `大约每天 ${String(perDay)} 条`
    },
  },
  {
    id: 'proactive-cap',
    name: '主动的安全阀',
    section: 'proactive-gate',
    sectionTitle: '主动闸门',
    key: 'daily-quota',
    control: 'number',
    hint: '每天最多几条。只算她主动开口，不算回话',
  },
  {
    id: 'tone',
    name: '说话的浓度',
    section: 'persona-vars',
    sectionTitle: '人格变量与浓度',
    key: 'tone-level',
    control: 'number',
    scale: ['克制', '自然', '热情'],
    preview: (values) => {
      const level = readNumber(values, 'persona-vars', 'tone-level', 50)
      // 三档对照同一句话，让「浓度」这个抽象参数有一次可见的差别。
      const samples: readonly [string, string, string] = ['嗯。', '嗯，我在。', '在的在的，怎么啦？']
      const index = level < 34 ? 0 : level < 67 ? 1 : 2
      return `同一句「我在」会写成：${samples[index] ?? samples[1]}`
    },
  },
  {
    id: 'message-length',
    name: '一次说多少',
    section: 'rhythm',
    sectionTitle: '节奏',
    key: 'max-chars-per-message',
    control: 'number',
    scale: ['短', '适中', '长'],
    hint: '越短越像即时消息',
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
    // 用 max-turns 而不是 max-tokens：后者默认 0 表示「不设上限」，
    // 做成滑杆后最左端等于「无限」，语义是反的。
    options: [
      { value: '4', label: '短' },
      { value: '10', label: '中' },
      { value: '20', label: '长' },
    ],
    preview: (values) => {
      const turns = readNumber(values, 'dialogue', 'max-turns', 10)
      if (turns <= 1) return '只带 1 轮，没有「多轮」可演'
      return `她会记得最近 ${String(turns)} 轮对话`
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
    hint: '她在这段时间休息',
  },
  {
    id: 'proactive-reason',
    name: '主动消息可解释',
    section: 'proactive-reason',
    sectionTitle: '主动话由',
    key: 'pool-enabled',
    control: 'boolean',
    hint: '每次主动都能看到「为什么」',
  },
  {
    id: 'audit-interval',
    name: '多久复核一次遗忘',
    section: 'memory-audit',
    sectionTitle: '遗忘审计',
    key: 'resurface-days',
    control: 'number',
  },
  {
    id: 'tts',
    name: '语音',
    section: 'tts',
    sectionTitle: '语音合成',
    key: 'enable',
    control: 'boolean',
    hint: '她可以读出来',
  },
  {
    id: 'pet',
    name: '桌宠',
    section: 'pet',
    sectionTitle: '桌面宠物',
    key: 'enable',
    control: 'boolean',
    hint: '桌面上的小窗口',
  },
  {
    id: 'approval',
    name: '高风险操作',
    section: 'privacy',
    sectionTitle: '隐私闸门',
    key: 'approval-mode',
    control: 'enum',
    options: [
      { value: 'supervised', label: '都问我' },
      { value: 'auto', label: '低风险不问' },
      { value: 'full', label: '都不问' },
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
