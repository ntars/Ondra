/**
 * 扩展抽屉：装了哪些包、哪些在跑、去哪儿改配置。
 *
 * ## 为什么清单来自目录，不来自设置段
 *
 * 一批包没有任何设置字段（时钟、身份、路径布局），它们在设置面板里不存在，
 * 但确实是运行中的扩展。用设置段当清单会漏掉它们，用户看到的是「装了 60 个」
 * 而实际 78 个。宿主 `GET /api/plugins` 扫的就是目录（见 `src/plugins.ts`）。
 *
 * ## 为什么不再平铺，也不再给开关
 *
 * 平铺 78 行时，这一屏读起来是一份「包名清单」——用户既不知道哪些是一类，
 * 也不知道哪个能关。现在按**职责**收成三段：
 *
 * | 段 | 成员 | 回答什么 |
 * | --- | --- | --- |
 * | 桌面桥接 | `desktop-bridge` | 壳与本机的连接 |
 * | 内核客户端 | `dsh-client` | 与 dsh 内核的通信 |
 * | 能力包 | 其余全部 `ondra-*` | 她是怎样一个人 |
 *
 * 三段都是**核心组件**：缺任何一段，应用要么连不上壳，要么连不上内核，
 * 要么「她」什么都不剩。所以这里没有开关，也没有「关闭」这个入口——
 * 一行置灰的开关仍然在暗示「这件事可以选」，而它其实不是选项。
 *
 * 后续新增的包不需要改这段代码：判据是目录名前缀（`desktop-bridge` /
 * `dsh-client` / 其余），新包自动落进「能力包」。
 *
 * ## 为什么开关能力仍留在宿主
 *
 * `POST /api/plugins/:id/toggle` 与 `plugins.json` 仍然有效（诊断、CI 与
 * 高级用户都会用），只是界面不再提供入口。撤掉宿主那一侧会让
 * `check:disable` 与「关掉一个包排查问题」这条路一起消失，
 * 而这跟「界面上不该有开关」不是同一件事。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { listPlugins, type PluginList, type PluginRow } from '../lib/api.ts'

/** 三段扩展。顺序即展示顺序：越靠近本机的越靠上。 */
const BUNDLES = [
  {
    id: 'desktop-bridge',
    title: '桌面桥接',
    note: '壳与本机的连接：文件选择、系统主题、窗口标题、外部链接。',
  },
  {
    id: 'dsh-client',
    title: '内核客户端',
    note: '与 dsh 内核的 JSON-RPC 通信：进程生命周期与请求配对。',
  },
  {
    id: 'ondra-bundle',
    title: '能力包',
    note: '她是谁、记得什么、怎么说话、怎么出声——其余全部能力插件。',
  },
] as const

type BundleId = (typeof BUNDLES)[number]['id']

/**
 * 一个包属于哪一段。
 *
 * 只有两个包需要按名字认，其余一律进「能力包」。用 `startsWith` 之外
 * 的判据（例如读 `package.json` 的某个字段）会引入第二处真源：
 * 新包忘了写那个字段，就会掉进「能力包」，而没有人会发现它其实属于别处。
 */
function bundleOf(id: string): BundleId {
  if (id === 'desktop-bridge') return 'desktop-bridge'
  if (id === 'dsh-client') return 'dsh-client'
  return 'ondra-bundle'
}

/** 一行右侧的状态文字。现在只有「在跑」与「没装载」两种，界面不能再改它。 */
function stateOf(row: PluginRow): { text: string; tone: 'live' | 'idle' } {
  return row.loaded ? { text: '运行中', tone: 'live' } : { text: '未装载', tone: 'idle' }
}

export interface ExtensionDrawerProps {
  /**
   * 打开某个包的配置。
   *
   * @param sectionId 配置段 id。上层据此打开三层面板并定位到该段。
   */
  onConfigure(sectionId: string): void
}

/**
 * 渲染扩展抽屉。
 *
 * ## 为什么搜索框在这里自己维护
 *
 * 抽屉容器的搜索框只服务「会话 / 记忆」那类短列表，且它的占位文案与
 * 语义是按内容切换的。能力包有七十多个，搜索是它最主要的使用方式，
 * 让容器去理解「这一屏按什么字段搜」会把两种数据形状搅在一起。
 */
export function ExtensionDrawer({ onConfigure }: ExtensionDrawerProps): React.JSX.Element {
  const [data, setData] = useState<PluginList | undefined>(undefined)
  const [fault, setFault] = useState<string | undefined>(undefined)
  const [query, setQuery] = useState('')

  const load = useCallback(async (): Promise<void> => {
    try {
      setData(await listPlugins())
      setFault(undefined)
    } catch (caught) {
      setFault(caught instanceof Error ? caught.message : '读不到扩展清单')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const items = data?.items ?? []
  /*
   * 待生效数**从行里数**，不读 `data.totals.pending`。
   *
   * 界面已经不能拨开关了，但这个数仍有意义：开关文件是用户可改的
   * （`plugins.json`），改完重启前它就停在这里。合计与行必须同源。
   */
  const pendingCount = items.filter((row) => row.pendingRestart).length

  /*
   * 过滤用「包含」而不是前缀：用户记得的是「记忆」，不是
   * 「ondra-memory-core」这个完整包名。大小写抹平——中文没有大小写，
   * 但包名全是英文。
   */
  const needle = query.trim().toLowerCase()
  const shown = useMemo(() => {
    if (needle === '') return items
    return items.filter((row) =>
      row.id.toLowerCase().includes(needle)
      || row.name.toLowerCase().includes(needle)
      || row.description.toLowerCase().includes(needle)
      || (row.sectionTitle ?? '').toLowerCase().includes(needle))
  }, [items, needle])

  /** 按段分好，空段不渲染（搜索时常见）。 */
  const grouped = useMemo(() => {
    const map = new Map<BundleId, PluginRow[]>()
    for (const bundle of BUNDLES) map.set(bundle.id, [])
    for (const row of shown) map.get(bundleOf(row.id))?.push(row)
    return map
  }, [shown])

  return (
    <div className="ext">
      <div className="ext__search">
        <input
          type="search"
          className="drawer__search-input"
          value={query}
          placeholder="按名称或包名搜索"
          aria-label="搜索扩展"
          onChange={(event) => { setQuery(event.target.value) }}
          /*
           * `Esc` 先清词，不关抽屉。
           *
           * 与原来抽屉容器里那个搜索框同一套语言：按 Esc 的第一意图是
           * 「撤销我刚才的筛选」，而不是「把整块面板收走」——后者会让
           * 用户重新点一次图标、再输一遍。`stopPropagation` 是必须的：
           * 全局那层 `keydown` 挂在 `window` 上，不拦就会接着关抽屉。
           *
           * 输入法组合中的 Esc（取消候选词）不归这里管：全局那层已经
           * 按 `isComposing` 挡掉了，这里再判一次只是为了让「清词」也
           * 不在组合中发生。
           */
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || query === '') return
            if (event.nativeEvent.isComposing) return
            event.preventDefault()
            event.stopPropagation()
            setQuery('')
          }}
        />
      </div>

      {fault !== undefined ? (
        <p className="drawer__empty">{fault}</p>
      ) : data === undefined ? (
        <p className="drawer__empty">正在读扩展清单</p>
      ) : (
        <>
          {/*
            合计两格：总数与装载数。待生效单独一格，它不为 0 时说明有改动
            还没落地（改的是开关文件），这一格是唯一提示。
          */}
          <div className="ext__totals">
            <span>{String(data.totals.all)} 个包</span>
            <span>{String(data.totals.loaded)} 个在跑</span>
            {pendingCount > 0 ? (
              <span className="ext__totals--pending">{`${String(pendingCount)} 个待重启`}</span>
            ) : null}
          </div>

          {shown.length === 0 ? (
            <p className="drawer__empty">{`未找到「${query.trim()}」`}</p>
          ) : (
            <div className="ext__groups">
              {BUNDLES.map((bundle) => {
                const rows = grouped.get(bundle.id) ?? []
                if (rows.length === 0) return null
                return (
                  /*
                   * 用 `<details open>` 而不是自管展开态：它自带键盘语义
                   * （Enter / Space 开合）、自带 `aria-expanded`，
                   * 且「默认展开、需要时收起」正是这一屏的用法。
                   */
                  <details className="ext__group" open key={bundle.id}>
                    <summary className="ext__group-head">
                      <span className="ext__group-name">{bundle.title}</span>
                      <span className="ext__group-count">{String(rows.length)}</span>
                      <span className="ext__tag">核心</span>
                    </summary>
                    <p className="ext__group-note">{bundle.note}</p>

                    <ul className="ext__list">
                      {rows.map((row) => {
                        const state = stateOf(row)
                        const name = row.name === '' ? row.id : row.name
                        return (
                          <li className="ext__row" key={row.id}>
                            <div className="ext__main">
                              <div className="ext__line">
                                <span className="ext__name" title={row.id}>{name}</span>
                                <span className="ext__state" data-tone={state.tone}>{state.text}</span>
                              </div>
                              <div className="ext__meta">
                                <span className="ext__id">{row.id}</span>
                                {row.version === '' ? null : <span>v{row.version}</span>}
                                {row.fields > 0 ? <span>{String(row.fields)} 项设置</span> : null}
                                {/*
                                  「配置」挂在技术那一行（包名 / 版本 / 几项设置）的右端，
                                  不单独占一行。单独占行时每个包会多出约 28px 高度，
                                  76 行就是两千多像素的无谓滚动；而它要改的正是这一行
                                  写着的东西，放在一起比漂在描述下面更好找。

                                  这是**上下文入口**，不是「开关」：它去改这个包的参数，
                                  不是把它停掉。
                                */}
                                {row.sectionId === null ? null : (
                                  <button
                                    type="button"
                                    className="ext__config"
                                    onClick={() => { onConfigure(row.sectionId ?? '') }}
                                  >
                                    配置
                                  </button>
                                )}
                              </div>
                              {row.description === '' ? null : (
                                <p className="ext__desc">{row.description}</p>
                              )}
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  </details>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
