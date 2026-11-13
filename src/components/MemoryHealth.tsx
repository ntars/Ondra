/**
 * 记忆库体检（`ondra-memory-heal` 的界面入口）。
 *
 * ## 它为什么必须存在
 *
 * 那个插件把七类问题判定、三档修复、二次确认闸全写完了，但 `diagnose()`
 * 全仓零调用方。装上之后 `available=true`、配置段能读能写、`stats()` 一切正常
 * ——**唯独巡检从不发生**。这类「写完了但没人问」的服务，在界面上与
 * 「这个功能本来就没有」完全同形，所以入口不是锦上添花，是这个插件
 * 唯一的用途。
 *
 * ## 三条显示纪律
 *
 * 1. **没装载 / 不可用 / 查过零问题**：三种状态说法必须不同。
 *    混成一句「体检暂无问题」是最坏的一种——它把「没查」说成了「没问题」。
 * 2. **三档分开列**：`auto`（无损可修）/ `confirm`（必须点名）/ `advise`（归别人）。
 *    合并成一堆会让人以为都能一键清掉，而 `confirm` 那档是不可逆删除。
 * 3. **`complete=false` 要显式说**：撞了巡检上限时清单只是部分结果，
 *    不说这一句，「就这些」与「还没扫完」会被读成同一件事。
 *
 * ## 巡检不跟渲染走
 *
 * 打开面板只读统计（`run=false`，不扫库）；巡检要翻几百条记忆并逐条算强度，
 * 必须由人按一下。刷新按钮与「体检」按钮是同一颗——按它就是跑一次。
 */

import { useCallback, useEffect, useState } from 'react'
import { getMemoryHealth, repairMemory } from '../lib/api.ts'
import type { MemoryFinding, MemoryHealth } from '../lib/api.ts'
import { sinceText } from '../lib/time.ts'

/** 三档的中文名与一句话说明。顺序即显示顺序：最安全的在最前。 */
const TIERS: ReadonlyArray<{
  tier: MemoryFinding['tier']
  label: string
  hint: string
}> = [
  { tier: 'auto', label: '可自动修', hint: '不损失任何数据' },
  { tier: 'confirm', label: '需确认', hint: '不可逆' },
  { tier: 'advise', label: '建议别人修', hint: '不归这里' },
]

/** 渲染记忆体检。 */
export function MemoryHealthBlock(): React.JSX.Element | null {
  const [health, setHealth] = useState<MemoryHealth | undefined>(undefined)
  const [running, setRunning] = useState(false)
  const [repairing, setRepairing] = useState(false)
  /** 上一次修复的结果。置空表示没有可说的。 */
  const [note, setNote] = useState<string | undefined>(undefined)

  /*
   * 挂载时只读统计（`run=false`）：这条请求不扫库，可以跟着面板打开走。
   * 真正的巡检由人按按钮触发，见下面的 `runScan`。
   */
  useEffect(() => {
    let alive = true
    void getMemoryHealth(false)
      .then((next) => {
        if (alive) setHealth(next)
      })
      .catch(() => {
        // 读统计失败不该让整个抽屉变成错误页：列表那部分仍然有用。
        if (alive) setHealth({ loaded: false, reason: 'unreachable' })
      })
    return () => {
      alive = false
    }
  }, [])

  /** 跑一次真正的巡检。 */
  const runScan = useCallback((): void => {
    setRunning(true)
    setNote(undefined)
    void getMemoryHealth(true)
      .then((next) => { setHealth(next) })
      .catch(() => { setNote('这次检查失败，稍后再试') })
      .finally(() => { setRunning(false) })
  }, [])

  /** 修一批。传进来的 key 已经由点击者逐个选中，这里不再批量补全。 */
  const runRepair = useCallback((keys: string[]): void => {
    if (keys.length === 0) return
    setRepairing(true)
    setNote(undefined)
    void repairMemory(keys)
      .then((result) => {
        setNote(result.ok > 0 ? `修好 ${String(result.ok)} 项` : '这些项现在都修不了')
        // 修完立刻重量一次：清单是「上次」的快照，留着会显示已经不存在的问题。
        return getMemoryHealth(true)
      })
      .then((next) => { setHealth(next) })
      .catch(() => { setNote('修复失败，清单已保留') })
      .finally(() => { setRepairing(false) })
  }, [])

  // 没装载：说清是「没有这个能力」，不是「没有发现问题」。
  if (health !== undefined && health.loaded === false) {
    return (
      <section className="health" aria-label="记忆库体检">
        <p className="health__idle">记忆检查未装载</p>
      </section>
    )
  }

  const findings = health?.findings ?? []
  const counted = health?.counts
  const scanned = health?.scanned
  const ran = health?.ran === true

  return (
    <section className="health" aria-label="记忆库体检">
      <header className="health__head">
        <span className="health__title">体检</span>
        <button
          type="button"
          className="health__run"
          disabled={running === true || health?.available === false}
          onClick={runScan}
        >
          {running === true ? '检查中…' : ran ? '重新检查' : '执行检查'}
        </button>
      </header>

      {/* 不可用：给出原因码，但不写内部错误码本身——那是给查代码的人看的。 */}
      {health?.available === false ? (
        <p className="health__idle">记忆内核未就绪，暂时无法执行检查</p>
      ) : null}

      {/* 还没查过：说清「一次都没跑」，不要摆一个 0。 */}
      {health?.available !== false && !ran ? (
        <p className="health__idle">
          {typeof health?.stats?.['diagnoses'] === 'number' && health.stats['diagnoses'] > 0
            ? `本轮尚未检查。上次检查 ${String(health.stats['diagnoses'])} 次，累计发现 ${String(health.stats['findings'] ?? 0)} 项`
            : '尚未检查。执行检查以确认是否存在冗余记忆'}
        </p>
      ) : null}

      {/* 查过：先给总数，再按三档分组。 */}
      {ran ? (
        <>
          <p className="health__summary">
            {findings.length === 0
              ? `已检查 ${String(scanned ?? 0)} 条，未发现问题`
              : `已检查 ${String(scanned ?? 0)} 条，发现 ${String(findings.length)} 项`}
            {health?.complete === false ? '（未完成，清单不完整）' : ''}
          </p>

          {health?.missing !== undefined && health.missing.length > 0 ? (
            /*
             * 缺席的上游要说出来：少查一类与「那一类没问题」在清单上
             * 长得一模一样，而两者的含义正相反。
             */
            <p className="health__missing">
              {`${String(health.missing.length)} 个上游服务未就绪，以下类别未检查`}
            </p>
          ) : null}

          {TIERS.map(({ tier, label, hint }) => {
            const items = findings.filter((item) => item.tier === tier)
            if (items.length === 0) return null
            return (
              <div key={tier} className="health__group">
                <p className="health__group-head">
                  <span className="health__group-label">{label}</span>
                  <span className="health__group-hint">{hint}</span>
                  <span className="health__group-count">{String(items.length)}</span>
                </p>
                <ul className="health__list">
                  {items.map((item) => (
                    <li key={`${item.code}:${item.id}`} className="health__item">
                      <span className="health__item-text">{item.detail}</span>
                      {item.action !== null ? (
                        <button
                          type="button"
                          className="health__fix"
                          disabled={repairing}
                          onClick={() => { runRepair([`${item.code}:${item.id}`]) }}
                        >
                          修
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}

          {/* 可执行项多于零时给一个整组修的入口：仍是逐个点名，不传「全部」。 */}
          {(counted?.auto ?? 0) > 0 ? (
            <button
              type="button"
              className="health__fix-all"
              disabled={repairing}
              onClick={() => {
                runRepair(
                  findings
                    .filter((item) => item.tier === 'auto' && item.action !== null)
                    .map((item) => `${item.code}:${item.id}`),
                )
              }}
            >
              {`清除 ${String(counted?.auto ?? 0)} 项可自动修复项`}
            </button>
          ) : null}

          {health?.at !== undefined ? (
            <p className="health__stamp">{`查于${sinceText(health.at)}`}</p>
          ) : null}
        </>
      ) : null}

      {note !== undefined ? <p className="health__note">{note}</p> : null}
    </section>
  )
}
