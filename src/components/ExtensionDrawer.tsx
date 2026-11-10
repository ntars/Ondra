/**
 * 扩展抽屉：装了哪些包、哪些在跑、去哪儿改配置。
 *
 * ## 为什么清单来自目录，不来自设置段
 *
 * 一批包没有任何设置字段（时钟、身份、路径布局），它们在设置面板里不存在，
 * 但确实是运行中的扩展。用设置段当清单会漏掉它们，用户看到的是「装了 60 个」
 * 而实际 78 个。宿主 `GET /api/plugins` 扫的就是目录（见 `src/plugins.ts`）。
 *
 * ## 开关为什么分「已生效」与「下次启动」
 *
 * 运行中撤走一个已经 `provide` 了服务键的插件，会让别的插件的 `ctx.get`
 * 留下悬空引用——不报错，只在某次调用时抛。所以开关只改下次启动的名单，
 * 界面必须如实标出「重启后生效」，不能让用户以为关掉就立刻消失。
 *
 * ## 为什么核心链成员不能关
 *
 * 同一类理由，后果更重：核心成员缺席不会有任何报错，只会让一批能力静默
 * 降级。开关置灰 + 一句说明，比允许点下去再让人排查「她为什么突然不记事」
 * 诚实。宿主也会回 409 兜底。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { listPlugins, togglePlugin, type PluginList, type PluginRow } from '../lib/api.ts'

/** 一行右侧的状态文字。四种组合各有各的说法，不合并成「开/关」。 */
function stateOf(row: PluginRow): { text: string; tone: 'live' | 'idle' | 'pending' } {
  if (row.enabled && row.loaded) return { text: '运行中', tone: 'live' }
  if (!row.enabled && row.loaded) return { text: '重启后停用', tone: 'pending' }
  if (row.enabled && !row.loaded) return { text: '重启后启用', tone: 'pending' }
  return { text: '未装载', tone: 'idle' }
}

export interface ExtensionDrawerProps {
  /**
   * 打开某个包的配置。
   *
   * @param sectionId 配置段 id。上层据此打开三层面板并定位到该段。
   */
  onConfigure(sectionId: string): void
  /** 一句提示（重启生效这类）。 */
  onNote(text: string): void
}

/**
 * 渲染扩展抽屉。
 *
 * ## 为什么搜索框在这里自己维护
 *
 * 抽屉容器的搜索框只服务「会话 / 记忆」那类短列表，且它的占位文案与
 * 语义是按内容切换的。扩展列表有 76 项，搜索是它最主要的使用方式，
 * 让容器去理解「这一屏按什么字段搜」会把两种数据形状搅在一起。
 */
export function ExtensionDrawer({ onConfigure, onNote }: ExtensionDrawerProps): React.JSX.Element {
  const [data, setData] = useState<PluginList | undefined>(undefined)
  const [fault, setFault] = useState<string | undefined>(undefined)
  const [query, setQuery] = useState('')
  /** 正在提交的包 id。提交期间禁用它自己的开关，避免连点写入两份名单。 */
  const [pending, setPending] = useState<string | undefined>(undefined)

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
   * 拨一个开关是乐观更新：行先变，请求后到。若这一格读服务端那份合计，
   * 用户拨完之后它会停在 0——「改了但没告诉你还要重启」正是最该说明的一刻。
   * 行是唯一真源，合计跟着行走。
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

  /**
   * 切换一个包的开关。
   *
   * ## 为什么失败要回滚
   *
   * 乐观更新让开关立刻动，但如果写文件失败而界面停在「已停用」，
   * 下次启动它照样在跑——那种不一致最难解释。失败时把它拨回去并说明。
   */
  const onToggle = useCallback(async (row: PluginRow): Promise<void> => {
    if (pending !== undefined) return
    const target = !row.enabled
    setPending(row.id)
    setData((current) => current === undefined ? current : {
      ...current,
      items: current.items.map((item) => item.id === row.id
        ? { ...item, enabled: target, pendingRestart: target !== item.loaded }
        : item),
    })
    try {
      const result = await togglePlugin(row.id, target)
      if (result.restartRequired) {
        onNote(target ? '下次启动时装载它' : '下次启动时不再装载它')
      }
    } catch (caught) {
      setData((current) => current === undefined ? current : {
        ...current,
        items: current.items.map((item) => item.id === row.id
          ? { ...item, enabled: row.enabled, pendingRestart: row.enabled !== item.loaded }
          : item),
      })
      onNote(caught instanceof Error ? caught.message : '开关没写成')
    } finally {
      setPending(undefined)
    }
  }, [pending, onNote])

  return (
    <div className="ext">
      <div className="ext__search">
        <input
          type="search"
          className="drawer__search-input"
          value={query}
          placeholder="按名字或包名找"
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
            合计三格：总数、装载数、待生效数。
            待生效单独一格：它不为 0 时说明有改动还没落地，这一格是唯一提示。
          */}
          <div className="ext__totals">
            <span>{String(data.totals.all)} 个包</span>
            <span>{String(data.totals.loaded)} 个在跑</span>
            {pendingCount > 0 ? (
              <span className="ext__totals--pending">{`${String(pendingCount)} 个待重启`}</span>
            ) : null}
          </div>

          {shown.length === 0 ? (
            <p className="drawer__empty">{`没找到「${query.trim()}」`}</p>
          ) : (
            <ul className="ext__list">
              {shown.map((row) => {
                const state = stateOf(row)
                const name = row.name === '' ? row.id : row.name
                return (
                  <li className="ext__row" key={row.id}>
                    <div className="ext__main">
                      <div className="ext__line">
                        <span className="ext__name" title={row.id}>{name}</span>
                        {row.core ? <span className="ext__tag">核心</span> : null}
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

                    {/*
                      开关用 `role="switch"`：读屏会念「开/关」而不是「按钮」。
                      核心成员的开关置灰，`title` 给出原因——置灰而不解释等于
                      让用户猜自己做错了什么。
                    */}
                    <button
                      type="button"
                      role="switch"
                      className="ext__switch"
                      aria-checked={row.enabled}
                      aria-label={`${row.core ? '核心扩展' : '扩展'} ${name}`}
                      disabled={row.core || pending === row.id}
                      title={row.core ? '核心链成员不能停用：停掉不会报错，只会让一批能力静默降级' : undefined}
                      onClick={() => { void onToggle(row) }}
                    >
                      <span className="ext__knob" />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
