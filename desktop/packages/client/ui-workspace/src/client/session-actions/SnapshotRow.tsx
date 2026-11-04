/**
 * 开发者模式 · 备份与还原（时间机器同款）。
 *
 * WHAT IT DOES. Snapshots the Ondra home on an interval the person chooses, and
 * puts one back on demand. The work happens in the shell (see
 * `apps/desktop/src/snapshot-service.ts`): unchanged files are hard-linked, so a
 * snapshot that follows another costs only what changed — that is what makes a
 * five-minute interval affordable, and it is why this is a real restore point
 * rather than an export button.
 *
 * WHERE IT IS. `settings.developer.item`, next to the trash. Snapshots are a
 * recovery tool for people who broke something while working on the product;
 * they are not a feature the everyday surface should advertise.
 *
 * WHAT IT DOES NOT COVER. `node_modules`, the runtime payloads, caches, logs and
 * attachments — hundreds of megabytes of rebuildable material. The row says so
 * instead of letting a restore look more complete than it is.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Modal, Switch } from '@ntars/ondra-client-ui-primitives'
import type { SessionTrashButtonProps } from '../contract/slots.ts'
import css from './SessionTrash.module.css'

/** One restorable snapshot, as the shell reports it. */
interface SnapshotRow {
  readonly id: string
  readonly createdAt: number
  readonly files: number
  readonly addedBytes: number
}

/** The shell's snapshot API, exposed by the preload bridge. */
interface SnapshotBridge {
  list: () => Promise<readonly SnapshotRow[]>
  capture: (keep?: number) => Promise<SnapshotRow>
  restore: (id: string) => Promise<number>
  remove: (id: string) => Promise<boolean>
}

/** Read the bridge, or undefined outside the desktop shell (web build). */
function snapshotBridge(): SnapshotBridge | undefined {
  return (globalThis as typeof globalThis & { __ONDRA_SNAPSHOTS__?: SnapshotBridge }).__ONDRA_SNAPSHOTS__
}

/** Intervals the row offers, in minutes. */
const INTERVALS: readonly number[] = [5, 15, 30, 60, 180]

/** Preferences are per machine, not per Session: they belong to the shell's UI. */
const PREFERENCE_KEY = 'ondra.snapshots.interval'

/**
 * Whether the timer loop runs at all. Off by default: an unattended writer that
 * hard-links the whole data directory every few minutes is a choice the person
 * makes, not something a recovery tool should start doing on its own.
 */
const ROLLING_KEY = 'ondra.snapshots.rolling'

/**
 * The settings row: interval control, snapshot-now, and the restorable list.
 * @returns the developer row.
 */
export function SnapshotSettingsRow(_props: SessionTrashButtonProps) {
  const bridge = snapshotBridge()
  const [interval, setInterval_] = useState<number>(() => {
    const stored = Number(globalThis.localStorage?.getItem(PREFERENCE_KEY))
    return INTERVALS.includes(stored) ? stored : 30
  })
  const [rows, setRows] = useState<readonly SnapshotRow[]>([])
  const [rolling, setRolling] = useState<boolean>(() => globalThis.localStorage?.getItem(ROLLING_KEY) === '1')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // One pending question at a time: restore overwrites data, delete throws a
  // restore point away, and neither happens on a single click.
  const [pending, setPending] = useState<{ readonly row: SnapshotRow; readonly kind: 'restore' | 'remove' } | null>(null)

  const refresh = useCallback(() => {
    if (bridge === undefined) return
    bridge.list().then(setRows).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }, [bridge])

  useEffect(() => { refresh() }, [refresh])

  // Rolling backups are a promise, so the timer has to be kept while the app
  // runs: it lives here, in the surface that owns the choice, and re-arms when
  // the choice changes. `capture` takes the retention cap so old snapshots are
  // pruned by the shell in the same pass. Off by default — nothing runs until
  // the switch is turned on.
  const keep = Math.max(4, Math.round((24 * 60) / interval))
  useEffect(() => {
    if (bridge === undefined || !rolling) return
    const timer = globalThis.setInterval(() => {
      bridge.capture(keep).then(() => { refresh() }).catch(() => {})
    }, interval * 60_000)
    return () => { globalThis.clearInterval(timer) }
  }, [bridge, interval, keep, refresh, rolling])

  const setRollingMode = (next: boolean): void => {
    setRolling(next)
    try {
      globalThis.localStorage?.setItem(ROLLING_KEY, next ? '1' : '0')
    } catch {
      // A blocked storage only costs the preference, not the feature.
    }
  }

  const choose = (minutes: number): void => {
    setInterval_(minutes)
    try {
      globalThis.localStorage?.setItem(PREFERENCE_KEY, String(minutes))
    } catch {
      // A blocked storage only costs the preference, not the feature.
    }
  }

  const captureNow = (): void => {
    if (bridge === undefined) return
    setBusy(true)
    setError(null)
    bridge.capture(keep).then(() => { refresh() }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { setBusy(false) })
  }

  const restore = (row: SnapshotRow): void => {
    if (bridge === undefined) return
    setBusy(true)
    setError(null)
    bridge.restore(row.id).then(() => {
      setPending(null)
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { setBusy(false) })
  }

  // Throwing one restore point away: the row is the only handle on it, so the
  // question is asked here rather than assumed from the click.
  const remove = (row: SnapshotRow): void => {
    if (bridge === undefined) return
    setBusy(true)
    setError(null)
    bridge.remove(row.id).then(() => {
      setPending(null)
      refresh()
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { setBusy(false) })
  }

  if (bridge === undefined) {
    return (
      <div className={css.row}>
        <div className={css.rowText}>
          <span className={css.rowTitle}>备份与还原</span>
          <span className={css.rowHint}>只在桌面版可用</span>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className={css.row}>
        <div className={css.rowText}>
          <span className={css.rowTitle}>备份与还原</span>
          <span className={css.rowHint}>
            {rows.length === 0
              ? '还没有备份。备份不包含依赖、缓存与附件。'
              : `${String(rows.length)} 个还原点，最新 ${formatTime(rows[0]!.createdAt)}`}
          </span>
        </div>
        <div className={css.controls}>
          <label className={css.rolling}>
            <Switch
              checked={rolling}
              onChange={setRollingMode}
              label="滚动备份"
              title="开启后按下面的间隔自动备份并只保留最近一天"
            />
            <span className={css.rollingText}>滚动备份</span>
          </label>
          <select
            className={css.select}
            aria-label="备份间隔"
            value={interval}
            disabled={!rolling}
            onChange={event => { choose(Number(event.target.value)) }}
          >
            {INTERVALS.map(minutes => (
              <option key={minutes} value={minutes}>{formatInterval(minutes)}</option>
            ))}
          </select>
          <Button size="sm" variant="outline" disabled={busy} onClick={captureNow}>
            {busy ? '处理中…' : '立即备份'}
          </Button>
        </div>
      </div>
      {rows.length === 0 ? null : (
        <ul className={css.list} aria-label="还原点">
          {rows.map(row => (
            <li key={row.id} className={css.item}>
              <span className={css.title} title={row.id}>
                {formatTime(row.createdAt)} · {String(row.files)} 个文件
              </span>
              <span className={css.rowHint}>{formatBytes(row.addedBytes)}</span>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => { setPending({ row, kind: 'remove' }) }}>
                删除
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => { setPending({ row, kind: 'restore' }) }}>
                还原
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error !== null && <div className={css.error} role="alert">{error}</div>}
      {pending === null ? null : (
        <Modal
          open
          onClose={() => { if (!busy) setPending(null) }}
          closeLabel="关闭"
          title={pending.kind === 'restore' ? '还原到这个还原点？' : '删除这个还原点？'}
          description={pending.kind === 'restore'
            ? `${formatTime(pending.row.createdAt)} 的状态会写回当前数据。备份之后新建的文件不会被删除。`
            : `${formatTime(pending.row.createdAt)} 的还原点会被删除，之后无法用它还原。其余还原点不受影响。`}
          footer={(
            <>
              <Button variant="outline" disabled={busy} onClick={() => { setPending(null) }}>取消</Button>
              <Button
                variant="outline"
                className={css.danger}
                disabled={busy}
                onClick={() => { pending.kind === 'restore' ? restore(pending.row) : remove(pending.row) }}
              >
                {pending.kind === 'restore'
                  ? (busy ? '还原中…' : '还原')
                  : (busy ? '删除中…' : '删除')}
              </Button>
            </>
          )}
        >
          {error !== null && <div className={css.error} role="alert">{error}</div>}
        </Modal>
      )}
    </>
  )
}

/** `09:41` for a snapshot taken today, `3月2日 09:41` for older ones. */
function formatTime(at: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return time
  return `${String(date.getMonth() + 1)}月${String(date.getDate())}日 ${time}`
}

/** Human interval label. */
function formatInterval(minutes: number): string {
  if (minutes < 60) return `每 ${String(minutes)} 分钟`
  return `每 ${String(Math.round(minutes / 60))} 小时`
}

/** Human size, one decimal above a megabyte. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}
