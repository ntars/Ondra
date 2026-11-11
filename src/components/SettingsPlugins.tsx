/**
 * 设置 · 插件参数（场景 / 模块 / 原始三层）。
 *
 * ## 三层是同一个页面的三个深度，不是三页
 *
 * 切换层用页内分段控件，**不换页**。当前层记忆在面板打开期间保持。
 * 把三层拆成三个导航项会让「从原始层跳到模块层」变成一次换页，
 * 而它们本来就是同一批字段的三种看法。
 *
 * ## 撤销粒度是「一次打开」
 *
 * 打开时把用户层拍一份快照。撤销 = 把所有与快照不同的键写回原值、
 * 快照里没有的键删掉。不是"每一步"——逐字节撤销需要维护一条操作栈，
 * 而用户的心智单位是"我刚才那一阵乱调"。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SceneLayer } from './SceneLayer.tsx'
import { ModuleLayer } from './ModuleLayer.tsx'
import { RawLayer } from './RawLayer.tsx'
import { getSettings, saveSetting } from '../lib/settings.ts'
import type { SettingsSection } from '../lib/settingTypes.ts'
import type { SceneValues } from '../lib/scenes.ts'

/** 三层的名字。顺序即渲染顺序：浅 → 深。 */
const TABS = [
  { key: 'scene', label: '场景' },
  { key: 'module', label: '模块' },
  { key: 'raw', label: '原始' },
] as const

type TabKey = typeof TABS[number]['key']

export interface SettingsPluginsProps {
  /**
   * 打开时直接定位到的配置段 id。
   *
   * 扩展抽屉的「配置」会带它进来：用户点的就是某个包，进来还要在六十多个
   * 段里再找一遍，等于让上一步白点。定位方式与「原始层跳到模块层」完全一致
   * ——把搜索词填成段 id，模块层按段 id 过滤后正好只剩那一段。
   */
  initialSection?: string
}

export function SettingsPlugins({ initialSection }: SettingsPluginsProps): React.JSX.Element {
  const [tab, setTab] = useState<TabKey>('scene')
  const [sections, setSections] = useState<SettingsSection[]>([])
  const [user, setUser] = useState<SceneValues>({})
  const [totals, setTotals] = useState({ sections: 0, fields: 0, unregistered: 0 })
  /** 加载态。首屏用骨架，之后不再显示骨架（避免"换个骨架再换回来"）。 */
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [error, setError] = useState('')

  /**
   * 打开时的用户层快照。撤销回到这里。
   *
   * 用 ref 而不是 state：它只在撤销时被读，从不参与渲染。
   * 放 state 会多一次无意义的 re-render，也让"快照"看起来像界面数据。
   */
  const snapshot = useRef<SceneValues>({})

  /** 搜索词在模块层与「从原始层跳过去」之间共享。 */
  const [query, setQuery] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setPhase('loading')
    try {
      const data = await getSettings()
      setSections(data.sections)
      setUser(data.user)
      setTotals(data.totals)
      snapshot.current = structuredClone(data.user)
      /*
       * 带了段 id 就定位过去。
       *
       * 在「数据到手之后」定位，而不是挂载时：模块层要拿到 `sections`
       * 才能过滤，提前设一个搜不到的词，界面会先闪一帧空列表。
       */
      if (initialSection !== undefined && initialSection !== '') {
        setQuery(initialSection)
        setTab('module')
      }
      setPhase('ready')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '读不到设置')
      setPhase('failed')
    }
  }, [initialSection])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * 写一个字段。
   *
   * ## 为什么先改本地再发请求
   *
   * 滑杆松手到宿主回包之间有几十毫秒。等回包再更新界面，读数会"弹回去
   * 再跳过来"，看起来像没生效。先乐观更新，失败时回滚并报错。
   *
   * ## 为什么失败要回滚
   *
   * 不滚的话，界面显示"已改 45 天"，文件里还是 30 天。下次启动变回去，
   * 用户会认为"这个设置存不住"——而真正的原因是那一次写入失败了。
   */
  const onWrite = useCallback(async (section: string, key: string, value: unknown): Promise<void> => {
    const previous = user[section]?.[key]
    const hadPrevious = previous !== undefined

    setUser((current) => {
      const bucket = { ...current[section] }
      if (value === undefined) delete bucket[key]
      else bucket[key] = value
      const next = { ...current }
      if (Object.keys(bucket).length === 0) delete next[section]
      else next[section] = bucket
      return next
    })

    try {
      await saveSetting(section, key, value)
    } catch (caught) {
      // 回滚到写入前的状态。用函数式更新，避免闭包里的旧 user 覆盖掉
      // 用户在等待期间做的另一次改动。
      setUser((current) => {
        const bucket = { ...current[section] }
        if (hadPrevious) bucket[key] = previous
        else delete bucket[key]
        const next = { ...current }
        if (Object.keys(bucket).length === 0) delete next[section]
        else next[section] = bucket
        return next
      })
      setError(caught instanceof Error ? caught.message : '写入失败')
    }
  }, [user])

  /** 与快照相比改了几项。 */
  const changedCount = useMemo(() => {
    let count = 0
    const sectionsSeen = new Set([...Object.keys(user), ...Object.keys(snapshot.current)])
    for (const section of sectionsSeen) {
      const now = user[section] ?? {}
      const before = snapshot.current[section] ?? {}
      const keys = new Set([...Object.keys(now), ...Object.keys(before)])
      for (const key of keys) {
        if (now[key] !== before[key]) count += 1
      }
    }
    return count
  }, [user])

  /**
   * 撤销：把所有与快照不同的键写回去。
   *
   * 逐个 `await`：并发写同一个 JSON 文件会产生互相覆盖的 rename，
   * 结果是文件里只落下了最后一批。串行虽慢，但撤销是一次性动作。
   */
  const onUndo = useCallback((): void => {
    const target = snapshot.current
    const current = user
    void (async () => {
      const sectionsSeen = new Set([...Object.keys(current), ...Object.keys(target)])
      for (const section of sectionsSeen) {
        const now = current[section] ?? {}
        const before = target[section] ?? {}
        const keys = new Set([...Object.keys(now), ...Object.keys(before)])
        for (const key of keys) {
          if (now[key] === before[key]) continue
          await onWrite(section, key, before[key])
        }
      }
    })()
  }, [onWrite, user])

  return (
    <div className="settings__plug">
      {/*
       * 三层切换。放在内容顶部，不换页。
       *
       * 用 `role="tablist"`：这三者确实是 tab 语义（同一内容区的三种深度），
       * 读屏会念"场景，选项卡，1/3"，比一串按钮清楚。
       */}
      <div className="settings__tabs" role="tablist" aria-label="设置深度">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            className="settings__tab"
            aria-selected={tab === item.key}
            onClick={() => { setTab(item.key) }}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="settings__body">
        {phase === 'loading' ? (
          <div className="settings__skeleton" aria-label="正在读取设置">
            <div /><div /><div />
          </div>
        ) : null}

        {phase === 'failed' ? (
          <div className="settings__failed">
            <p className="settings__failed-title">读不到设置</p>
            <p className="settings__failed-detail">{error}</p>
            <button type="button" className="button button--ghost" onClick={() => { void load() }}>
              重试
            </button>
          </div>
        ) : null}

        {phase === 'ready' ? (
          <>
            {tab === 'scene' ? (
              <SceneLayer sections={sections} user={user} onWrite={onWrite} />
            ) : null}

            {tab === 'module' ? (
              <ModuleLayer
                sections={sections}
                user={user}
                onWrite={onWrite}
                query={query}
                onQueryChange={setQuery}
              />
            ) : null}

            {tab === 'raw' ? (
              <RawLayer
                sections={sections}
                user={user}
                onJump={(sectionId) => {
                  // 切到模块层并把搜索框填成段 id：模块层按段 id 过滤，
                  // 跳过去正好只剩那一段。比"只切层不定位"少一次手动搜索。
                  setQuery(sectionId)
                  setTab('module')
                }}
              />
            ) : null}
          </>
        ) : null}
      </div>

      {/*
       * 改动条：本次改动 N 项 + 撤销。
       *
       * ## 为什么放在滚动区外、统计条之上
       *
       * 第一版把它放在场景层内部并 `position: sticky; bottom: 0`。sticky 会在
       * 文档流里保留原占位，同时把它视觉上推到底部——结果每次滚动都压住下面
       * 一行的分段控件。提到面板级还有第二个理由：模块层改值同样计入
       * `changedCount`，而它原来只挂在场景层。
       */}
      {phase === 'ready' && changedCount > 0 ? (
        <div className="settings__bar">
          <span className="settings__bar-text">本次改动 {changedCount} 项</span>
          <button type="button" className="settings__bar-undo" onClick={onUndo}>
            撤销
          </button>
        </div>
      ) : null}

      {/*
       * 底部统计。只在就绪后显示——加载中显示 0 段 0 字段会被当成真实结果。
       *
       * 三个数分开说：段数、可调字段数、来源未登记的段数。第三个不为 0 时
       * 必须显示，否则用户会在模块层看到一段没有标题的字段却说不清它从哪来。
       */}
      {phase === 'ready' ? (
        <footer className="settings__foot">
          <span>{totals.sections} 个配置段</span>
          <span>{totals.fields} 个字段</span>
          {totals.unregistered === 0 ? null : <span>{totals.unregistered} 段来源未登记</span>}
        </footer>
      ) : null}
    </div>
  )
}
