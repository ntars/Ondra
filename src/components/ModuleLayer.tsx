/**
 * 设置·模块层（120 段 / 1116 字段）。
 *
 * ## 五个渲染器覆盖全部情况（§6.6）
 *
 * | kind | 渲染 | 真实数量 |
 * | --- | --- | --- |
 * | `number` | 滑杆（有 min/max 时）或数字框 | 576 |
 * | `boolean` | 开关 | 359 |
 * | `enum` | 分段（≤4）或下拉（>4） | 53 |
 * | `string` | 输入框，有 `pattern` 时实时校验 | 126（35 个带正则） |
 * | `json` | 等宽文本域，实时校验 | 54 |
 *
 * number 与 boolean 合计 80%，所以这两种控件的观感决定整个设置页的观感。
 *
 * ## 分层可见：普通视图不给高级字段，开发者模式全给
 *
 * 全仓近半数字段标着 `advancedOnly`。默认藏起来不是「简化」，是**先给能
 * 读懂的那一半**：普通视图里一段只有三五项，读得完；开发者模式是同一个
 * 列表，只是不再过滤。两档由**一个**开关控制（设置页底部的「开发者模式」），
 * 不再按段各记一个——按段记的结果是同一屏里有些段展开有些没展开，
 * 用户无法从界面判断「我到底在哪个模式」。
 *
 * ## 分组按「使用者要解决什么问题」
 *
 * 65 个段平铺是一堵墙。分组表在 `lib/settingsTaxonomy.ts`，四组 + 兜底：
 * 人设与表达 / 记忆与情绪 / 主动与节奏 / 运行与安全。搜索时不分组——
 * 用户已经说出了他要找的词，再按组折叠只是多一层点击。
 *
 * ## 零插件专属代码
 *
 * 这个文件里没有一处 `if (plugin === 'ondra-xxx')`。段名、字段、范围、说明
 * 全部来自插件自己的声明——§6.6 的验收就是"加一个插件，这里改 0 行"。
 */

import { useCallback, useMemo, useState } from 'react'
import type { SettingsField, SettingsSection } from '../lib/settingTypes.ts'
import type { SceneValues } from '../lib/scenes.ts'
import { SETTINGS_CATEGORIES, categoryOfSection, isDedicated, isHighRisk } from '../lib/settingsTaxonomy.ts'

export interface ModuleLayerProps {
  sections: SettingsSection[]
  user: SceneValues
  onWrite(section: string, key: string, value: unknown): Promise<void>
  /** 搜索词由上层持有，让「场景层搜不到 → 跳到模块层」能带词过来。 */
  query: string
  onQueryChange(next: string): void
  /**
   * 开发者模式：是否显示高级字段。
   *
   * 由设置页的一个开关控制，不按段记忆（见文件头）。默认关闭。
   */
  developerMode: boolean
}

/** 一个字段的当前值：用户层优先，否则默认值。 */
function valueOf(user: SceneValues, section: string, key: string, fallback: unknown): unknown {
  const override = user[section]?.[key]
  return override !== undefined ? override : fallback
}

/** 把值写成输入框里的文字。 */
function toText(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value, undefined, 2)
  } catch {
    return ''
  }
}

/** 数字字段：范围大或需要精确输入时用数字框，否则滑杆。 */
function NumberField({
  field,
  value,
  onCommit,
}: {
  field: SettingsField
  value: unknown
  onCommit(next: number): void
}): React.JSX.Element {
  const min = field.min ?? 0
  const max = field.max ?? 100
  const current = typeof value === 'number' && Number.isFinite(value) ? value : min
  /*
   * 判据不是"范围大小"本身，而是**滑杆在这段范围上还有没有分辨率**。
   * 3650 天铺在 300px 上，一格约 12 天，用滑杆选"45 天"根本选不到；
   * 一百以内 300px 一格不到 1，滑杆反而比打字快。
   */
  const useSlider = max - min <= 200

  /* 已填充比例（§12.16）。同 `SceneLayer`：轨道无法分段着色，填充画在元素背景上。 */
  const fill = max > min ? `${String(((current - min) / (max - min)) * 100)}%` : '0%'

  /*
   * 单位。空串表示这个数字没有量纲，此时不渲染也不拼进 `aria-valuetext`
   * ——拼一个空的会让读屏多念一次停顿。
   *
   * 与 `SceneLayer` 同一口径：百分号紧贴数字，其余单位按词处理加空格。
   */
  const unit = field.unit ?? ''
  const ariaText = unit === ''
    ? String(current)
    : unit === '%'
      ? `${String(current)}%`
      : `${String(current)} ${unit}`

  return (
    <div className="field__control">
      {useSlider ? (
        <input
          className="field__range control-range"
          type="range"
          min={min}
          max={max}
          step={1}
          value={current}
          aria-label={field.key}
          aria-valuetext={ariaText}
          style={{ '--fill': fill } as React.CSSProperties}
          onChange={(event) => { onCommit(Number(event.target.value)) }}
        />
      ) : null}
      <input
        className="field__number"
        type="number"
        min={min}
        max={max}
        step={1}
        value={current}
        aria-label={field.key}
        aria-valuetext={ariaText}
        onChange={(event) => {
          const next = Number(event.target.value)
          // 越界时不动：把 5000 夹成 3650 会让用户以为自己输的是 3650。
          if (!Number.isFinite(next) || next < min || next > max) return
          onCommit(next)
        }}
      />
    </div>
  )
}

/** 字符串字段：单行输入，带 `pattern` 时实时校验。 */
function StringField({
  field,
  value,
  onCommit,
}: {
  field: SettingsField
  value: unknown
  onCommit(next: string): void
}): React.JSX.Element {
  const text = toText(value)
  const [draft, setDraft] = useState(text)

  /*
   * 校验结果三态：合法 / 不合法 / 还看不出。
   *
   * 空串不算"不合法"——用户删空准备重打时不该立刻标红。空串是否合法
   * 由插件自己判断（有些字段允许空，有些不允许），界面不替它下结论。
   */
  const invalid = useMemo(() => {
    if (field.pattern === undefined || draft === '') return false
    try {
      return !new RegExp(field.pattern).test(draft)
    } catch {
      // 正则源码本身写错时不要崩界面，按"无法校验"处理。
      return false
    }
  }, [field.pattern, draft])

  return (
    <div className="field__control field__control--stack">
      <input
        className="field__text"
        type="text"
        value={draft}
        aria-label={field.key}
        aria-invalid={invalid}
        onChange={(event) => {
          const next = event.target.value
          setDraft(next)
          if (field.pattern === undefined || next === '') {
            onCommit(next)
            return
          }
          try {
            if (new RegExp(field.pattern).test(next)) onCommit(next)
          } catch {
            onCommit(next)
          }
        }}
      />
      {invalid ? <p className="field__invalid">格式不对，要求形如：{field.pattern}</p> : null}
    </div>
  )
}

/** JSON 字段：等宽文本域，实时校验。 */
function JsonField({
  field,
  value,
  onCommit,
}: {
  field: SettingsField
  value: unknown
  onCommit(next: unknown): void
}): React.JSX.Element {
  const [draft, setDraft] = useState(() => toText(value))
  const [error, setError] = useState('')

  return (
    <div className="field__control field__control--stack">
      <textarea
        className="field__json"
        rows={4}
        value={draft}
        spellCheck={false}
        aria-label={field.key}
        aria-invalid={error !== ''}
        onChange={(event) => {
          const next = event.target.value
          setDraft(next)
          try {
            const parsed: unknown = JSON.parse(next)
            setError('')
            onCommit(parsed)
          } catch (caught) {
            // 报错要说清哪里错。`SyntaxError` 的 message 里带位置，
            // 但 Chromium 的措辞是英文——这里只留一句中文结论，不假装翻译它。
            setError(caught instanceof Error ? 'JSON 不完整或格式有误' : '解析失败')
          }
        }}
      />
      {error === '' ? null : <p className="field__invalid">{error}</p>}
    </div>
  )
}

/** 枚举字段：候选 ≤4 用分段，>4 用下拉。 */
function EnumField({
  field,
  value,
  onCommit,
}: {
  field: SettingsField
  value: unknown
  onCommit(next: string): void
}): React.JSX.Element {
  const values = field.values ?? []
  const current = typeof value === 'string' ? value : ''

  if (values.length <= 4) {
    return (
      <div className="field__control field__segments control-segments" role="group" aria-label={field.key}>
        {values.map((option) => (
          <button
            key={option}
            type="button"
            className="field__segment control-segment"
            aria-pressed={current === option}
            onClick={() => { onCommit(option) }}
          >
            {option}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="field__control">
      <select
        className="field__select"
        value={current}
        aria-label={field.key}
        onChange={(event) => { onCommit(event.target.value) }}
      >
        {values.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    </div>
  )
}

/** 一个字段整行。 */
function FieldRow({
  section,
  field,
  user,
  onWrite,
}: {
  section: SettingsSection
  field: SettingsField
  user: SceneValues
  onWrite(section: string, key: string, value: unknown): Promise<void>
}): React.JSX.Element {
  const value = valueOf(user, section.id, field.key, field.default)
  const changed = user[section.id]?.[field.key] !== undefined

  /*
   * 当前值压成一行短文本给元数据行用。
   *
   * json 不展开（展开会把面板撑破），只报条数或类型——用户从这行字里
   * 要得到的是"现在是什么形态"，不是全文。
   */
  const currentText = Array.isArray(value)
    ? `[${String(value.length)} 项]`
    : typeof value === 'object' && value !== null
      ? '{…}'
      : String(value)

  /*
   * 视觉读数里的单位后缀。
   *
   * 与 `aria-valuetext` 同源（都来自 `field.unit`），只差排版：百分号
   * 紧贴数字，其余按词加一个空格。数字字段之外一律为空——`{…}` 后面
   * 跟一个「天」只会让人以为这个对象以天计。
   */
  const unitSuffix = field.kind !== 'number' || field.unit === undefined
    ? ''
    : field.unit === '%'
      ? '%'
      : ` ${field.unit}`

  const commit = useCallback((next: unknown): void => {
    void onWrite(section.id, field.key, next)
  }, [field.key, onWrite, section.id])

  /*
   * 生效时机。
   *
   * §6.6 给了一条明确的兜底规则：**猜不到就按"即时生效"**。宁可立即生效后
   * 发现无效，也不要提示重启但其实不需要——后者会让用户白重启一次。
   * 唯一会猜的是"路径类字符串"：改它一定影响下次启动的加载位置。
   */
  const needsRestart = field.kind === 'string'
    && (field.key.includes('path') || field.key.includes('dir') || field.key.includes('bin'))

  return (
    <div className="field" data-changed={changed ? '' : undefined}>
      <div className="field__head">
        {/* 标题用字段键：`doc` 是说明，不是标题。缺失中文名时显示原名即可（§5.13）。 */}
        <span className="field__key">{field.key}</span>
      </div>

      {field.kind === 'boolean' ? (
        <button
          type="button"
          className="scene__switch control-switch"
          role="switch"
          aria-checked={value === true}
          aria-label={field.key}
          onClick={() => { commit(value !== true) }}
        >
          <span className="scene__switch-knob control-switch-knob" />
        </button>
      ) : null}

      {field.kind === 'number' ? <NumberField field={field} value={value} onCommit={commit} /> : null}
      {field.kind === 'string' ? <StringField field={field} value={value} onCommit={commit} /> : null}
      {field.kind === 'json' ? <JsonField field={field} value={value} onCommit={commit} /> : null}
      {field.kind === 'enum' ? <EnumField field={field} value={value} onCommit={commit} /> : null}

      {/*
        * 元数据行（§12.16「五种控件共用」）。
        *
        * 四项全用文字不用图标：图标需要学习，文字不需要。
        *
        * 位置在控件**下方** 6px。原先放在标题右侧，与键名挤在一行里——
        * 那样一行要放「键名 + 当前 + 默认 + 已改」四段文字，12px 字在
        * 360 宽的面板里会折行，折了行就一项都读不全。
        *
        * 「当前」只在改动过时显示：未改时当前值恒等于默认值，
        * 并排写两个一样的数字只是噪声。
        */}
      <p className="field__meta">
        {changed ? `当前 ${currentText}${unitSuffix} · ` : null}
        默认 {String(field.default ?? '—')}{unitSuffix} · {changed ? '已改' : '未改'}
      </p>

      {field.doc === undefined ? null : <p className="field__doc">{field.doc}</p>}
      {needsRestart ? <p className="field__restart">下次启动生效</p> : null}

      {changed ? (
        <button
          type="button"
          className="field__reset"
          onClick={() => { void onWrite(section.id, field.key, undefined) }}
        >
          恢复默认
        </button>
      ) : null}
    </div>
  )
}

/** 一段。展开后才渲染字段——120 段一次全渲染会有 1116 个受控输入框。 */
/**
 * 一个配置段的可折叠块。
 *
 * ## 为什么导出
 *
 * 「人物设定」页的四张卡（朗读 / 口吻 / 节奏 / 规矩）各自只绑了对应段的
 * `enable` 一个字段，而那个段还有 14–22 个字段留在这一页里。同一件事被
 * 劈成两处：用户在人物设定页看到「朗读」开关，想调声音却发现要跑到
 * 「扩展功能 · 模块」里找 `tts` 段。
 *
 * 导出这个块之后，专门页可以**原地**嵌进完整字段，扩展功能不再重复渲染
 * 同一段——一份字段，一个入口。
 */
export function SectionBlock({
  section,
  user,
  onWrite,
  expanded,
  onToggle,
  developerMode,
  chrome = 'full',
  omitKeys,
}: {
  section: SettingsSection
  user: SceneValues
  onWrite(section: string, key: string, value: unknown): Promise<void>
  expanded: boolean
  onToggle(): void
  developerMode: boolean
  /**
   * 外壳形态。
   *
   * - `full`：段头 + 折叠 + 字段。模块层用它。
   * - `fields`：只给字段区，不带段头。专门页面（人物设定）把这一段嵌在
   *   自己的卡片下面，卡片标题已经说明了这是什么，再叠一个段名会让读者
   *   犹豫「这是两个东西吗」。
   */
  chrome?: 'full' | 'fields'
  /**
   * 不渲染的字段键。
   *
   * 专门页面把段嵌进自己的卡片时用它排除 `enable`——卡片上那个开关
   * 与段里的 `enable` 是同一个字段，渲染两遍会得到两个互相联动的开关，
   * 而界面上没有任何线索说明它们是同一个。
   */
  omitKeys?: ReadonlySet<string>
}): React.JSX.Element {
  const changedCount = Object.keys(user[section.id] ?? {}).length
  const advancedCount = section.fields.filter((field) => field.advancedOnly).length
  /* 普通视图只给非高级；开发者模式给全部。两种视图共用同一段折叠状态。 */
  const base = developerMode ? section.fields : section.fields.filter((field) => !field.advancedOnly)
  const visible = omitKeys === undefined ? base : base.filter((field) => !omitKeys.has(field.key))
  const highRisk = isHighRisk(section.id)

  const full = chrome === 'full'

  return (
    <section className="module" data-inactive={section.active ? undefined : ''} data-chrome={chrome}>
      {full ? (
      <button type="button" className="module__head" aria-expanded={expanded} onClick={onToggle}>
        <span className="module__title">
          {section.title}
          {/*
            高风险标挂在段名后面而不是单独一行：它修饰的是这一段，
            读者点到它时应该已经知道「这一段会动到机器边界」。
          */}
          {highRisk ? <span className="module__risk">高风险</span> : null}
        </span>
        <span className="module__meta">
          {visible.length} 项
          {developerMode && advancedCount > 0 ? ` · ${String(advancedCount)} 高级` : ''}
          {changedCount > 0 ? ` · 已改 ${String(changedCount)}` : ''}
        </span>
      </button>
      ) : null}

      {/*
       * 停用标注（§6.7）。
       *
       * 插件停用后它的段必须灰显并注明，不允许看起来还能调——
       * 那是最容易让人失去信任的一类缺陷。
       *
       * ## 为什么补上「去哪启用」
       *
       * 上一版只有前半句「插件已停用，改了不生效」。新用户第一次进这一页
       * 会看到 27 处这句话，而他并不知道"停用"是自己关的还是坏的、
       * 更不知道去哪里开。只说"不能用"而不说"怎么让它能用"，
       * 等于把问题丢回给用户。
       *
       * 这里不直接给一个开关：启停的语义在扩展抽屉里（那里能看包名、
       * 版本与依赖），在这一页再放一个就是第二个真源。所以只指路。
       */}
      {section.active ? null : (
        <p className="module__off">
          插件已停用，改了不生效。到左栏「扩展」里找到它并启用，重启后生效。
        </p>
      )}
      {section.registered || !full ? null : <p className="module__off">未注册配置段，不参与四层合并</p>}

      {expanded || !full ? (
        <div className="module__body">
          {visible.length === 0 ? <p className="module__off">这一段只有高级字段，打开开发者模式可见</p> : null}
          {visible.map((field) => (
            <FieldRow key={field.key} section={section} field={field} user={user} onWrite={onWrite} />
          ))}
        </div>
      ) : null}
    </section>
  )
}

/** 渲染模块层。 */
export function ModuleLayer({
  sections,
  user,
  onWrite,
  query,
  onQueryChange,
  developerMode,
}: ModuleLayerProps): React.JSX.Element {
  /** 展开的段 id 集合。只允许同时展开一段，避免 1116 个控件同时在树上。 */
  const [expanded, setExpanded] = useState<string | undefined>(undefined)
  const keyword = query.trim().toLowerCase()

  /*
   * 搜索的范围是「段名 + 段 id + 字段键 + 字段说明」四项。
   *
   * 用户可能搜"作息"（段名）、"life-rhythm"（段 id）、"rest-start"（字段键）、
   * "休息"（说明里的词）。少任何一项，都会出现"明明有这个设置却搜不到"。
   */
  /*
   * 已由专门页面承载的段在这里不再出现（见 `DEDICATED_SECTIONS`）。
   *
   * ## 为什么搜索也过滤
   *
   * 只在「无搜索词」时过滤会得到最坏的一种行为：用户在扩展功能里搜「朗读」，
   * 搜不到（好），但搜「tts」又能搜到（坏）——同一个段一会儿在、一会儿不在，
   * 用户会认为搜索坏了。既然它已经有专门页面，两个路径都不该给。
   *
   * 代价是「搜段 id 定位」这条路径对已上移的段失效。扩展抽屉的「配置」
   * 按钮不受影响：它带的是 `initialSection`，走的是模块层的 `query`，
   * 而那一步在 `SettingsPlugins.load()` 里——那里会把目标段的专门页面
   * 直接打开（见该文件的 `onOpenDedicated`）。
   */
  const owned = useMemo(
    () => sections.filter((section) => !isDedicated(section.id)),
    [sections],
  )

  const matched = useMemo(() => {
    if (keyword === '') return owned
    return owned.filter((section) => {
      if (section.title.toLowerCase().includes(keyword)) return true
      if (section.id.toLowerCase().includes(keyword)) return true
      if (section.dir.toLowerCase().includes(keyword)) return true
      return section.fields.some((field) => (
        field.key.toLowerCase().includes(keyword)
        || (field.doc ?? '').toLowerCase().includes(keyword)
      ))
    })
  }, [owned, keyword])

  /**
   * 无段字段的条数（§5.13 的 `ondra-memory-intake`）。
   *
   * 它只有 `FIELD_SPECS` 没有 `CONFIG_SECTION`，所以既不能算进"120 个配置段"，
   * 也不能不告而别——它是真实可调的 5 个字段。单独报一句，两者都成立。
   */
  const orphanCount = useMemo(
    () => matched.filter((section) => !section.registered).length,
    [matched],
  )

  /**
   * 一段的渲染闭包。
   *
   * 分组视图与搜索结果共用同一段代码：两处各写一遍，折叠状态与「已改」
   * 计数迟早会不一致——那种不一致用户在界面上看不出来，只会觉得「数字不对」。
   */
  const renderSection = (section: SettingsSection): React.JSX.Element => (
    <SectionBlock
      key={section.id}
      section={section}
      user={user}
      onWrite={onWrite}
      expanded={expanded === section.id}
      onToggle={() => { setExpanded(expanded === section.id ? undefined : section.id) }}
      developerMode={developerMode}
    />
  )

  /**
   * 按四组铺开。
   *
   * 段在组内的顺序取分类表里的声明顺序（那是「基础 → 进阶」的排法），
   * 表里没列的段按标题排在组尾——它们通常是新装的插件，还没归位。
   */
  const grouped = useMemo(() => {
    const byId = new Map(matched.map((section) => [section.id, section]))
    const used = new Set<string>()
    const groups = SETTINGS_CATEGORIES.map((category) => {
      const ordered: SettingsSection[] = []
      for (const id of category.sections) {
        const section = byId.get(id)
        if (section === undefined) continue
        ordered.push(section)
        used.add(id)
      }
      const rest = matched
        .filter((section) => !used.has(section.id) && categoryOfSection(section.id) === category.id)
        .sort((left, right) => left.title.localeCompare(right.title, 'zh'))
      for (const section of rest) used.add(section.id)
      return { id: category.id, name: category.name, subtitle: category.subtitle, sections: [...ordered, ...rest] }
    })
    return groups.filter((group) => group.sections.length > 0)
  }, [matched])

  return (
    <div className="settings__module">
      <input
        className="settings__search"
        type="search"
        value={query}
        placeholder="搜插件、段名或参数名"
        aria-label="搜索设置"
        onChange={(event) => { onQueryChange(event.target.value) }}
      />

      {matched.length === 0 ? (
        <p className="settings__empty">没有匹配的设置，换个词试试</p>
      ) : (
        <>
          {/*
            * 计数只算**已注册**的段，与底部统计条同一口径。
            *
            * 之前这里写 `matched.length`，把无段字段（§5.13 的
            * `ondra-memory-intake`）也算成一"段"，于是同一屏上模块层说
            * "121 个配置段"、底部说"120 个配置段"。两个数都是真实计算出来的，
            * 但用户只会认为界面在乱报数。122 是 §5.13 的权威口径，
            * 无段字段单独用一句话交代，不混进段数里。
            */}
          <p className="settings__count">
            {matched.filter((section) => section.registered).length} 个配置段
            {orphanCount === 0 ? null : <span className="settings__count-note">另有 {orphanCount} 个插件只有字段、没有配置段</span>}
          </p>
          {/*
            * 有搜索词时平铺：用户已经说出了要找的词，再按组折叠只是
            * 多一层点击。没有搜索词时按四组铺开，组头给一句「这一组管什么」。
            */}
          {keyword === ''
            ? grouped.map((group) => (
              <section key={group.id} className="module__group">
                <header className="module__group-head">
                  <h4 className="module__group-title">{group.name}</h4>
                  <span className="module__group-count">{group.sections.length}</span>
                  <p className="module__group-sub">{group.subtitle}</p>
                </header>
                {group.sections.map(renderSection)}
              </section>
            ))
            : matched.map(renderSection)}
        </>
      )}
    </div>
  )
}
