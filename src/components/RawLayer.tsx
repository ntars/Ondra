/**
 * 设置·原始层（1168 条）。
 *
 * ## 这一层不是"给开发者的丑陋版本"，而是同一条数据的另一种排布
 *
 * 三条信息在模块层被折叠了，这里必须全部摊开：
 *
 * | 列 | 为什么必须单独一列 |
 * | --- | --- |
 * | 类型 | `30` 是数字、`"30"` 是字符串，两者在配置里是两种东西 |
 * | 默认值 | 判断"我改没改"的唯一依据 |
 * | 来源段 | 段 id 与目录名不一致时，只有这一列能让人对上配置文件 |
 *
 * ## 为什么用虚拟化的替代品：分页而不是全量渲染
 *
 * 1168 行同时进 DOM 会让这个面板滚动一顿一顿的。引入虚拟列表要新增一个
 * 依赖，而这个面板的使用频率极低（开发者排障用），**分页足够**：
 * 每页 80 行，滚到底点"下一页"。用最少的东西解决问题。
 */

import { useMemo, useState } from 'react'
import type { SettingsSection } from '../lib/settingTypes.ts'
import type { SceneValues } from '../lib/scenes.ts'

export interface RawLayerProps {
  sections: SettingsSection[]
  user: SceneValues
  /**
   * 跳到模块层的某个段（§12.16「来源插件可点击跳转」）。
   *
   * 回调由 `Settings` 提供：它持有「当前在哪一层」与「模块层搜索词」两个
   * 状态，原始层只负责说"用户点了这一段"。让原始层自己去切层，就得把
   * 两个状态传进来再传出去，比一个回调重。
   */
  onJump?(sectionId: string): void
}

/** 每页行数。80 行约两屏，足够看清一批同类字段。 */
const PAGE_SIZE = 80

/** 一条扁平化的字段。 */
interface RawRow {
  section: SettingsSection
  key: string
  kind: string
  fallback: string
  current: string
  changed: boolean
  advancedOnly: boolean
}

/** 把值压成一行短文本。原始层不展开 json——展开会把表格撑破。 */
function cell(value: unknown): string {
  if (value === undefined) return '—'
  if (typeof value === 'string') return value === '' ? '""' : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${String(value.length)} 项]`
  return '{…}'
}

/** 渲染原始层。 */
export function RawLayer({ sections, user, onJump }: RawLayerProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)

  const rows = useMemo<RawRow[]>(() => {
    const flat: RawRow[] = []
    for (const section of sections) {
      const overrides = user[section.id] ?? {}
      for (const field of section.fields) {
        const changed = overrides[field.key] !== undefined
        flat.push({
          section,
          key: field.key,
          kind: field.kind,
          fallback: cell(field.default),
          current: cell(changed ? overrides[field.key] : field.default),
          changed,
          advancedOnly: field.advancedOnly,
        })
      }
    }
    return flat
  }, [sections, user])

  const matched = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (keyword === '') return rows
    return rows.filter((row) => (
      row.key.toLowerCase().includes(keyword)
      || row.section.id.toLowerCase().includes(keyword)
      || row.section.title.toLowerCase().includes(keyword)
    ))
  }, [rows, query])

  /*
   * 翻页要把页码夹回合法范围。
   *
   * 搜索把结果从 1168 条缩到 3 条时，页码若还停在第 10 页，表格会一片空白
   * ——用户会以为"搜不到"，实际是页码越界。在渲染时夹而不是在 onChange 里夹，
   * 因为搜索框与页码是两个独立状态，任一方变化都可能让页码失效。
   */
  const pageCount = Math.max(1, Math.ceil(matched.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const visible = matched.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  return (
    <div className="settings__raw">
      <input
        className="settings__search"
        type="search"
        value={query}
        placeholder="搜键名或段名"
        aria-label="搜索原始设置"
        onChange={(event) => {
          setQuery(event.target.value)
          setPage(0)
        }}
      />

      <p className="settings__count">
        共 {matched.length} 条{matched.length === rows.length ? '' : ` / ${String(rows.length)}`}
        {' · '}第 {safePage + 1} / {pageCount} 页
      </p>

      <table className="raw__table">
        <thead>
          <tr>
            <th scope="col">键</th>
            <th scope="col">类型</th>
            <th scope="col">当前</th>
            <th scope="col">默认</th>
            <th scope="col">段</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => (
            <tr key={`${row.section.id}/${row.key}`} data-changed={row.changed ? '' : undefined}>
              <td className="raw__key">
                {row.key}
                {row.advancedOnly ? <span className="raw__tag">高级</span> : null}
              </td>
              <td className="raw__kind">{row.kind}</td>
              <td className="raw__value" title={row.current}>{row.current}</td>
              <td className="raw__value raw__value--muted" title={row.fallback}>{row.fallback}</td>
              <td className="raw__section">
                {/*
                  * 段 id 可点击跳到模块层（§12.16）。
                  *
                  * 用 `button` 而不是给 `td` 加 `onClick`：它要能被 Tab 到、
                  * 能被回车触发。给单元格挂点击事件只有鼠标用户碰得到。
                  */}
                <button
                  type="button"
                  className="raw__jump"
                  title={`在模块层查看 ${row.section.id}`}
                  onClick={() => { onJump?.(row.section.id) }}
                >
                  {row.section.id}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {pageCount > 1 ? (
        <div className="raw__pager">
          <button
            type="button"
            className="button button--ghost"
            disabled={safePage === 0}
            onClick={() => { setPage(safePage - 1) }}
          >
            上一页
          </button>
          <button
            type="button"
            className="button button--ghost"
            disabled={safePage >= pageCount - 1}
            onClick={() => { setPage(safePage + 1) }}
          >
            下一页
          </button>
        </div>
      ) : null}

      {/*
       * 为什么原始层不做行内编辑。
       *
       * 这一层是**排障视图**，不是编辑器。它的价值在于「一眼看全 1168 条」，
       * 加上编辑能力后会诱使用户在这里改值——而 json 字段的正确编辑方式
       * 是模块层的等宽文本域（有校验）。改值请回模块层，这里只回答"现在是什么"。
       */}
      <p className="settings__note">这一层只读。改值请回模块层——那里有对应的控件与校验。</p>
    </div>
  )
}
