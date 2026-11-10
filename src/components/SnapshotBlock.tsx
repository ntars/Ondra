/**
 * 快照（`ondra-snapshot` 的界面入口）。
 *
 * ## 它与前两块的区别
 *
 * 做梦和体检是「写完了没人问」，而快照**不缺调用方**——五个插件早就在
 * `ctx.get('ondra-snapshot')` 等它，`create()` 会在做梦前被真的调用。
 * 它缺的是**人能看到结果的那条路**：
 *
 * | 谁调 | 调的是 |
 * | --- | --- |
 * | 五个插件 | 只有 `create()`——备份是它们的内部动作 |
 * | **没有人** | `list()` / `verify()` / `stats()` |
 *
 * 于是「备份做没做成、坏没坏、占多少地方」三件事在产品里完全不可见。
 * 而这三件恰好是备份唯一的用户价值：**一份没人验过的备份，和没有备份，
 * 在需要它的那一刻是同一件事。**
 *
 * ## 三条显示纪律
 *
 * 1. **没有快照 ≠ 快照可用**：`count: 0` 说的是「还没做过」，不是「做不了」。
 *    不可用会另有原因，两者不能说成一句。
 * 2. **「没验过」与「验过且好」必须分开**：刚建完、还没按校验键的那份，
 *    不能说成「已验证」。这才是这个块存在的理由。
 * 3. **恢复不给按钮**：插件要求「库已关闭」，而宿主正持有着库——
 *    任何恢复按钮都只会返回 `db-open`，那是假按钮。真恢复要走
 *    「退出应用 → 手动替换文件」，不属于这一屏。
 *
 * ## 为什么校验必须是按钮
 *
 * `verify()` 会 `ATTACH` 一份快照并跑 `quick_check`，读几百 MB 是常态。
 * 挂载时自动验一遍会让抽屉一打开就卡住，而且每次打开都卡。
 */

import { useCallback, useEffect, useState } from 'react'
import { getSnapshots, verifySnapshot } from '../lib/api.ts'
import type { SnapshotState } from '../lib/api.ts'

/** 字节数翻成人话。只用 KB / MB 两档，再多一档在窄栏里就挤了。 */
function sizeText(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 相对时间：与记忆体检同一套措辞，不另起一套。 */
function sinceText(at: number): string {
  const diff = Date.now() - at
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${String(Math.floor(diff / 60_000))} 分钟前`
  if (diff < 86_400_000) return `${String(Math.floor(diff / 3_600_000))} 小时前`
  return `${String(Math.floor(diff / 86_400_000))} 天前`
}

/** 一份快照的校验状态。`undefined` 表示还没验过——这个状态必须与「验过且好」分开。 */
type Check = 'ok' | 'bad'

/** 渲染快照。 */
export function SnapshotBlock(): React.JSX.Element | null {
  const [state, setState] = useState<SnapshotState | undefined>(undefined)
  /** 按 id 记校验结果。没记录 = 没验过。 */
  const [checked, setChecked] = useState<Record<string, Check>>({})
  const [verifying, setVerifying] = useState<string | undefined>(undefined)

  useEffect(() => {
    let alive = true
    void getSnapshots()
      .then((next) => { if (alive) setState(next) })
      .catch(() => {
        if (alive) setState({ loaded: false, available: false, reason: 'unreachable' })
      })
    return () => { alive = false }
  }, [])

  /** 验一份。结果记在本地，不写库——验证是只读动作，没有需要持久化的东西。 */
  const runVerify = useCallback((id: string): void => {
    setVerifying(id)
    void verifySnapshot(id)
      .then((result) => {
        setChecked(prev => ({ ...prev, [id]: result.ok ? 'ok' : 'bad' }))
      })
      .catch(() => {
        setChecked(prev => ({ ...prev, [id]: 'bad' }))
      })
      .finally(() => { setVerifying(undefined) })
  }, [])

  if (state !== undefined && state.loaded === false) {
    return (
      <section className="snap" aria-label="快照">
        <p className="snap__idle">备份这一块还没接上</p>
      </section>
    )
  }

  const items = state?.items ?? []

  return (
    <section className="snap" aria-label="快照">
      <header className="snap__head">
        <span className="snap__title">快照</span>
        {state?.keep !== undefined ? (
          <span className="snap__keep">{`保留 ${String(state.keep)} 份`}</span>
        ) : null}
      </header>

      {/* 不可用：原因已经是人话，直接说，别包装。 */}
      {state?.available === false ? (
        <p className="snap__idle">{state.reason ?? '备份暂时不可用'}</p>
      ) : null}

      {/*
       * 可用但没有快照：说「还没做过」，**不说「备份不可用」**。
       * 这两件事在依赖坏掉时会长得一模一样，而结论完全相反。
       */}
      {state?.available === true && items.length === 0 ? (
        <p className="snap__idle">还没有快照。做梦或遗忘前会自动做一份</p>
      ) : null}

      {items.length > 0 ? (
        <ul className="snap__list">
          {items.map(item => {
            const verdict = checked[item.id]
            return (
              <li key={item.id} className="snap__item">
                <div className="snap__item-main">
                  <span className="snap__item-time">{sinceText(item.createdAtMs)}</span>
                  <span className="snap__item-size">{sizeText(item.sizeBytes)}</span>
                  {/*
                   * 库版本：`null` 是**如实值**，不是读取失败。
                   *
                   * 真机核过：这个项目的原库 `PRAGMA user_version` 本来就是 0
                   * （没用 SQLite 的版本号机制，迁移版本记在自己的表里），
                   * 所以快照读出来也是 0 → 插件按契约归成 `null`。
                   * 显示成「未标注」而不是留空：留空会被读成「没读到」，
                   * 而这两件事对「这份备份能不能用」的判断完全不同。
                   */}
                  <span className="snap__item-schema">
                    {item.schemaVersion === null ? '版本未标注' : `v${String(item.schemaVersion)}`}
                  </span>
                  {/*
                   * 校验结果三态分开：
                   * 没验过 / 验过且好 / 验过且坏。
                   * 合成两态（好 / 坏）会把「没验过」画成「好」——那是这个块
                   * 存在的全部理由被抹掉。
                   */}
                  {verdict === 'ok' ? (
                    <span className="snap__item-ok">可读</span>
                  ) : verdict === 'bad' ? (
                    <span className="snap__item-bad">读不了</span>
                  ) : (
                    <span className="snap__item-raw">没验过</span>
                  )}
                </div>
                <button
                  type="button"
                  className="snap__verify"
                  disabled={verifying !== undefined}
                  onClick={() => { runVerify(item.id) }}
                >
                  {verifying === item.id ? '验…' : '验'}
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}

      {/* 总量：一行小字，不与逐份信息争注意力。 */}
      {items.length > 0 && state?.totalBytes !== undefined ? (
        <p className="snap__stamp">{`共 ${sizeText(state.totalBytes)}`}</p>
      ) : null}

      {/*
       * 待恢复登记：**只提醒，不执行**。
       * 这不是一个可点的入口——插件要求库已关闭，而宿主正持有着库。
       * 给它一个按钮只会返回 `db-open`，是替一个做不到的动作画门。
       */}
      {state?.pendingRestore === true ? (
        <p className="snap__note">有一份恢复登记着还没执行。这需要退出应用后手动替换文件，这里不做</p>
      ) : null}
    </section>
  )
}
