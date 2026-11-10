/**
 * 做梦（`ondra-memory-dream` 的界面入口）。
 *
 * ## 它为什么必须存在
 *
 * 那个插件把三支分支、四道闸、五类卡片的规则挖掘、三张表全写完了，但
 * `run()` 全仓零调用方。装上之后 `available=true`、配置段能读能写、
 * `stats()` 一切正常——**唯独一场梦都不会发生**，`dream_log` 恒 0 行。
 * 这类「写完了但没人问」的服务，在界面上与「这个功能本来就没有」完全同形。
 *
 * 它同时也是**唯一能让人看见梦做完了没有**的地方：`written` / `rejected` /
 * `cards` 三个数只在报告里，库和日志都不直接给出「这一晚到底成了什么」。
 *
 * ## 三条显示纪律
 *
 * 1. **没装载 / 不可用 / 今天跑过 / 素材为空**：四种「没跑」说法必须不同。
 *    合成一句「做梦失败」是最坏的——它把「还没接上」与「今天已经做过了」
 *    说成同一件事，而后者恰好是正常状态。
 * 2. **拒收要说出来**：四道闸拒掉的候选比写进去的更能解释「今晚为什么没长记忆」。
 *    只报「写了 0 条」会让人以为插件坏了。
 * 3. **备份那一格如实**：`backup: skipped` 的意思是「没装快照插件」，
 *    不是「备份过了」。把它显示成对勾就是在替一个没发生的动作背书。
 *
 * ## 为什么不在挂载时自己跑一场
 *
 * 做一场梦要读原文层、调一次模型、往记忆库写事实——**不可逆**。
 * 打开面板就自动跑，等于把一次按钮点击变成了「看一眼就写库」。
 * 挂载只读状态（GET），跑要人按（POST）。
 */

import { useCallback, useEffect, useState } from 'react'
import { getDreamState, runDreamNow } from '../lib/api.ts'
import type { DreamRunResult, DreamState } from '../lib/api.ts'

/** 分支的中文名。`gate` 是最稳的默认（只补带逐字出处的事实）。 */
const MODE_LABEL: Record<string, string> = {
  gate: '闸式',
  lightweight: '轻量',
  surreal: '荒诞',
}

/** 分支的一句话说明。 */
const MODE_HINT: Record<string, string> = {
  gate: '只补带逐字出处的事实',
  lightweight: '纯规则挖五类卡片，不调模型',
  surreal: '荒诞联想与梦话',
}

/** 没跑的原因码翻成人话。**四句各不相同**，见文件头第一条。 */
const SKIP_TEXT: Record<string, string> = {
  'already-today': '今天已经做过一场了',
  'not-loaded': '做梦这一块还没接上',
  unavailable: '做梦不可用',
  'no-material': '还没有可做素材的对话',
}

/** 日期键 `YYYY-MM-DD` → `M 月 D 日`，避免在窄栏里塞一串数字。 */
function dayText(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (match === null) return date
  return `${String(Number(match[2]))} 月 ${String(Number(match[3]))} 日`
}

/** 渲染做梦。 */
export function DreamBlock(): React.JSX.Element | null {
  const [state, setState] = useState<DreamState | undefined>(undefined)
  const [running, setRunning] = useState(false)
  /** 上一次跑的结果。置空表示这一屏还没有跑过。 */
  const [result, setResult] = useState<DreamRunResult | undefined>(undefined)

  /*
   * 挂载只读状态。`getDreamState()` 不扫库、不调模型、不写任何字节，
   * 跟着面板打开走是安全的。
   */
  useEffect(() => {
    let alive = true
    void getDreamState()
      .then((next) => { if (alive) setState(next) })
      .catch(() => {
        // 读状态失败不该让记忆抽屉变成错误页：下面的列表仍然有用。
        if (alive) setState({ loaded: false, available: false, reason: 'unreachable' })
      })
    return () => { alive = false }
  }, [])

  /**
   * 做一场梦。
   * @param force 绕开宿主那道「一天一场」的闸。
   */
  const run = useCallback((force: boolean): void => {
    setRunning(true)
    void runDreamNow(force)
      .then((next) => {
        setResult(next)
        // 跑完立刻重量状态：记账与卡片都变了，留着旧快照会显示「一场都没做过」。
        return getDreamState()
      })
      .then((next) => { setState(next) })
      .catch(() => { setResult({ ran: false, note: '这次没做成，稍后再试' }) })
      .finally(() => { setRunning(false) })
  }, [])

  if (state !== undefined && state.loaded === false) {
    return (
      <section className="dream" aria-label="做梦">
        <p className="dream__idle">做梦这一块还没接上</p>
      </section>
    )
  }

  const history = state?.history ?? []
  const cards = (state?.cards ?? []).filter(card => !card.archived)
  const pending = state?.pendingTalk ?? 0
  const mode = state?.mode
  /** 最近一场。本仓开了 `noUncheckedIndexedAccess`，取第 0 项要显式判空。 */
  const latest = history[0]

  return (
    <section className="dream" aria-label="做梦">
      <header className="dream__head">
        <span className="dream__title">做梦</span>
        <button
          type="button"
          className="dream__run"
          disabled={running || state?.available !== true}
          onClick={() => { run(false) }}
        >
          {running ? '正在做…' : '做一场'}
        </button>
      </header>

      {/* 不可用：给一句人话，不摆内部原因码（那是给查代码的人看的）。 */}
      {state?.available === false ? (
        <p className="dream__idle">
          {state.reason === 'no-core' ? '记忆内核没接上，暂时做不了梦' : '做梦暂时不可用'}
        </p>
      ) : null}

      {/* 可用：先说清用什么方式做，再说做过几场。 */}
      {state?.available === true ? (
        <p className="dream__mode">
          {`${MODE_LABEL[mode ?? 'gate'] ?? mode ?? '闸式'} · ${MODE_HINT[mode ?? 'gate'] ?? ''}`}
        </p>
      ) : null}

      {/* 一次都没做过：不要摆一个「0 场」，那读起来像「做过、什么也没留」。 */}
      {state?.available === true && history.length === 0 && result === undefined ? (
        <p className="dream__idle">还一场都没做过。攒够一天的话再按</p>
      ) : null}

      {/* 刚跑完：把这一场的四个数摊开。 */}
      {result !== undefined ? (
        <div className="dream__result">
          <p className="dream__summary">{result.note}</p>
          {result.ran ? (
            <p className="dream__counts">
              {`候选 ${String(result.candidates ?? 0)} · 写入 ${String(result.written ?? 0)}`
                + ` · 拒 ${String(result.rejected ?? 0)} · 卡片 ${String(result.cards ?? 0)}`}
            </p>
          ) : (
            <p className="dream__counts">{SKIP_TEXT[result.skipped ?? ''] ?? '这一场没跑'}</p>
          )}
          {/*
           * 拒收要说出来：只报「写入 0」会让人以为插件坏了，而真实原因
           * 往往是四道闸之一按设计拒掉了（没逐字出处、改人格、重复、无人称）。
           */}
          {result.ran && (result.rejected ?? 0) > 0 ? (
            <p className="dream__note">有候选被四道闸拒了：梦只补带出处的事实，宁缺不滥</p>
          ) : null}
          {/*
           * 备份那一格如实，且**三种值分开说**。
           *
           * 初版只写了 `skipped` 一句「快照插件没装」——那时它确实是唯一成因。
           * 但 `ondra-snapshot` 本轮已装载，这句话会开始说假话：
           * `skipped` 还能来自「装了但不可用」（内存后端、路径服务缺席），
           * 而 `failed` 是**真的做失败了**（库未关、不可写），两者的严重程度
           * 差一个量级，混成一句就等于把故障说成配置。
           */}
          {result.ran && result.backup === 'skipped' ? (
            <p className="dream__note">这一场没做开工前备份（快照服务不可用）</p>
          ) : null}
          {result.ran && result.backup === 'failed' ? (
            <p className="dream__note">这一场备份失败了，照常做完（快照那份可能不可用）</p>
          ) : null}
          {result.ran && result.backup === 'created' ? (
            <p className="dream__note">开工前已备份一份</p>
          ) : null}
          {/* 已经做过一场之后，给一个能绕开「一天一场」的入口。 */}
          {!result.ran && result.skipped === 'already-today' ? (
            <button
              type="button"
              className="dream__again"
              disabled={running}
              onClick={() => { run(true) }}
            >
              再来一场
            </button>
          ) : null}
        </div>
      ) : null}

      {/* 待注入的梦话：它会在下一次对话里出现一次，说过就不再出现。 */}
      {pending > 0 ? (
        <p className="dream__note">{`有 ${String(pending)} 句梦话等着下次说话时用`}</p>
      ) : null}

      {/* 卡片：纯规则挖出来的五类，按权重降序。只显示未归档的几张。 */}
      {cards.length > 0 ? (
        <div className="dream__cards">
          <p className="dream__cards-head">留下的卡片</p>
          <ul className="dream__list">
            {cards.slice(0, 3).map(card => (
              <li key={card.id} className="dream__card">
                <span className="dream__card-title">{card.title}</span>
                <span className="dream__card-body">{card.body}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* 做过几场：只报最近一次，不铺一整张表——这里不是记账页面。 */}
      {latest !== undefined ? (
        <p className="dream__stamp">
          {`做过 ${String(history.length)} 场，最近一次 ${dayText(latest.date)}`
            + `，写了 ${String(latest.facts)} 条`}
        </p>
      ) : null}
    </section>
  )
}
