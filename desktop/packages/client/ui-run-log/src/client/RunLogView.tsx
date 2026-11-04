/**
 * The run log's rendering: 「运行日志」, the middle column's second reading.
 *
 * WHAT THIS VIEW IS. The conversation view shows what was said. This view shows
 * what she DID to say it — a message came in, she started working out a reply,
 * picked up a tool, finished it, closed the turn. Every line is plain language,
 * and the only taxonomy on screen is the five category words beside the
 * timestamps.
 *
 * WHERE THE ROWS COME FROM. The Session's own event window, handed in by this
 * plugin's `inject` face (see entries.ts for the projection). The view holds no
 * copy of the transcript and no sample data: switching to the log reads the same
 * evidence the conversation does, which is the only way the two columns can
 * never disagree.
 *
 * WHAT IT DELIBERATELY IS NOT. There is no code-level reading and no switch to
 * reach one. The platform's own trajectory view already exists and is a
 * developer instrument — model ids, token counts, timings — and it stays behind
 * the developer-tools preference where it belongs. A person living with a
 * companion should never be handed a protocol dump under the label "log"; if
 * the technical reading is needed, that is a developer's errand with its own
 * surface, not a tab on the companion's own screen.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale } from '@ntars/ondra-client-ui-slots'
import type { ConvViewProps } from '@ntars/ondra-client-ui-conversation/client'
import { deriveRunLog, type RunLogEntry, type RunLogLine, type RunLogSource } from './entries.ts'
import type { RunLogKey } from './locales.ts'
import css from './RunLogView.module.css'

/**
 * What this view needs from its host: the Session's event window.
 *
 * The source is declared as a `hooks` entry so the framework hands the view an
 * observable hook (`useFeed`) instead of a bare store: the column subscribes
 * only while it is the visible reading.
 */
export interface RunLogInjected {
  readonly hooks: {
    /** The contiguous Session event window, as published by the Session binding. */
    readonly feed: RunLogSource
  }
}

/** How close to the bottom still counts as "following along". */
const STICK_THRESHOLD_PX = 48

/**
 * The tools whose names a reader should not have to decode.
 *
 * Anything absent keeps its own name: a tool this build has never seen is still
 * a real thing she picked up, and renaming it would be the log guessing.
 */
const TOOL_KEYS: Readonly<Record<string, RunLogKey>> = {
  bash: 'tool.bash',
  shell: 'tool.bash',
  terminal: 'tool.bash',
  read: 'tool.read',
  readfile: 'tool.read',
  write: 'tool.write',
  writefile: 'tool.write',
  edit: 'tool.edit',
  multiedit: 'tool.edit',
  applypatch: 'tool.edit',
  glob: 'tool.find',
  grep: 'tool.find',
  search: 'tool.find',
  filesearch: 'tool.find',
  websearch: 'tool.web',
  webfetch: 'tool.web',
  fetch: 'tool.web',
  task: 'tool.delegate',
  agent: 'tool.delegate',
}

/** The view's own translate seat. */
type Translate = PropsLocale<'runLog'>['t']

/**
 * Say a tool's name the way the reader can follow.
 * @param name - the wire tool name, possibly empty.
 * @param t - the log's own copy.
 * @returns the translated verb, the raw name, or a neutral noun.
 */
function plainTool(name: string, t: Translate): string {
  const key = TOOL_KEYS[name.toLowerCase()]
  if (key !== undefined) return t(key)
  return name === '' ? t('tool.unknown') : name
}

/**
 * Format one timestamp the way the column shows time.
 * @param at - epoch ms, or null when the event carried none.
 * @returns `HH:MM:SS` in the reader's own zone, or an empty cell.
 */
function clockTime(at: number | null): string {
  if (at === null) return ''
  const date = new Date(at)
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(part => String(part).padStart(2, '0'))
    .join(':')
}

/** The sentence for one line, and the numbers it names. */
interface LineCopy {
  readonly key: RunLogKey
  readonly params?: Record<string, string | number>
}

/**
 * Turn one structural line into copy plus its numbers.
 * @param line - the named event.
 * @param t - the log's own copy.
 * @returns the dictionary key and interpolation values.
 */
function copyOf(line: RunLogLine, t: Translate): LineCopy {
  switch (line.kind) {
    case 'received':
      return { key: 'line.received', params: { characters: line.characters } }
    case 'thinking':
      return { key: 'line.thinking' }
    case 'replied':
      return line.seconds === null
        ? { key: 'line.replied', params: { characters: line.characters } }
        : { key: 'line.repliedTimed', params: { characters: line.characters, seconds: line.seconds } }
    case 'replyInterrupted':
      return { key: 'line.replyInterrupted', params: { characters: line.characters } }
    case 'turnStarted':
      return { key: 'line.turnStarted' }
    case 'turnCompleted':
      return line.seconds === null
        ? { key: 'line.turnCompleted' }
        : { key: 'line.turnCompletedTimed', params: { seconds: line.seconds } }
    case 'turnBlocked':
      return { key: 'line.turnBlocked' }
    case 'turnAborted':
      return { key: 'line.turnAborted' }
    case 'turnFailed':
      return line.reason === null
        ? { key: 'line.turnFailed' }
        : { key: 'line.turnFailedReason', params: { reason: line.reason } }
    case 'toolStarted':
      return { key: 'line.toolStarted', params: { tool: plainTool(line.tool, t) } }
    case 'toolFinished':
      return { key: 'line.toolFinished', params: { tool: plainTool(line.tool, t) } }
    case 'toolFailed':
      return { key: 'line.toolFailed', params: { tool: plainTool(line.tool, t) } }
    case 'contextInjected':
      return { key: 'line.contextInjected', params: { characters: line.characters } }
    case 'compacted':
      return { key: 'line.compacted' }
  }
}

/**
 * How long a TOOL step took, as a separate figure.
 *
 * Only tools report this as a detached number: a reply and a turn already say
 * their own duration inside the sentence ("想了 10.1 秒"), so repeating it as a
 * trailing figure printed the same time twice. Tools have no such sentence, so
 * the figure is the only place their duration appears.
 * @param entry - the row.
 * @returns e.g. `1.2s`, or null when the row carries no detached duration.
 */
function rowDuration(entry: RunLogEntry): string | null {
  const line = entry.line
  if (line.kind !== 'toolFinished' && line.kind !== 'toolFailed') return null
  return line.elapsedMs === null ? null : `${(line.elapsedMs / 1000).toFixed(1)}s`
}

/**
 * Draw the run log.
 * @param props - the view's runtime share plus this plugin's event-window source.
 * @returns the timestamped narration list, or its empty state.
 */
export function RunLogView({ t, useFeed }: ConvViewProps & PropsLocale<'runLog'> & InjectFace<RunLogInjected>): ReactNode {
  const window = useFeed(value => value)
  // The window identity only changes when events land, so the projection is
  // recomputed exactly once per publish rather than on every render.
  const entries = useMemo(() => deriveRunLog(window.entries), [window.entries])
  const root = useRef<HTMLDivElement | null>(null)
  const following = useRef(true)

  // A log that does not follow its own tail is a log nobody reads: pin to the
  // newest line unless the reader has scrolled up to study something.
  const onScroll = useCallback((): void => {
    const element = root.current
    if (element === null) return
    following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_THRESHOLD_PX
  }, [])

  useEffect(() => {
    const element = root.current
    if (element === null || !following.current) return
    element.scrollTop = element.scrollHeight
  }, [entries])

  // Group rows by turn so the list reads as a sequence of exchanges rather than
  // one undifferentiated stream. Rows before the first turn (or after the last)
  // share a null group and render without a heading — the wire itself says they
  // belong to no turn, so inventing a heading would be the log guessing.
  const groups = useMemo(() => {
    const out: { turn: number | null; rows: RunLogEntry[] }[] = []
    for (const entry of entries) {
      const last = out.at(-1)
      if (last !== undefined && last.turn === entry.turn) last.rows.push(entry)
      else out.push({ turn: entry.turn, rows: [entry] })
    }
    return out
  }, [entries])

  return (
    <div className={css.root} ref={root} onScroll={onScroll} data-run-log="">
      <div className={css.rows} role="log" aria-label={t('view.runlog')}>
        {entries.length === 0
          ? (
            <div className={css.empty} data-run-log-empty>
              <p className={css.emptyTitle}>{t('log.empty')}</p>
              <p className={css.emptyHint}>{t('log.emptyHint')}</p>
            </div>
          )
          : groups.map((group, index) => (
            <section key={group.rows[0]!.id} className={css.group} data-run-log-group={group.turn ?? undefined}>
              {group.turn === null ? null : (
                <h3 className={css.groupHeading}>
                  <span className={css.groupLabel}>{t('group.turn', { turn: group.turn })}</span>
                  <span className={css.groupTime}>
                    {clockTime(group.rows.find(row => row.at !== null)?.at ?? null)}
                  </span>
                  <span className={css.groupCount}>{t('group.count', { count: group.rows.length })}</span>
                </h3>
              )}
              {group.rows.map((entry: RunLogEntry) => {
                const copy = copyOf(entry.line, t)
                const line = entry.line
                // A tool's subject is on its CALL line; a tool's duration is on
                // its RESULT line. Showing each where it belongs keeps both
                // readable instead of cramming them into one row.
                const detail = line.kind === 'toolStarted' ? line.detail : null
                const duration = rowDuration(entry)
                // The bodies that make the log a record rather than a ticker:
                // what she thought and what she said. Collapsed by default so
                // the list stays scannable, and always present so the reader
                // never has to leave the view to see it.
                const thinking = line.kind === 'thinking' ? entry.body : null
                const reply = line.kind === 'replied' ? entry.body : null
                const said = line.kind === 'received' ? entry.body : null
                return (
                  <div key={entry.id} className={css.row} data-run-log-entry={entry.category} data-sender={entry.sender}>
                    <time className={css.time} dateTime={entry.at === null ? undefined : new Date(entry.at).toISOString()}>
                      {clockTime(entry.at)}
                    </time>
                    <span className={css.badge} data-category={entry.category}>
                      {t(`log.${entry.category}` as RunLogKey)}
                    </span>
                    <span className={css.sender} data-sender={entry.sender}>
                      {t(`sender.${entry.sender}`)}
                    </span>
                    <span className={css.text}>
                      {t(copy.key, copy.params)}
                      {detail === null ? null : <span className={css.detail}>{detail}</span>}
                      {duration === null ? null : <span className={css.duration}>{duration}</span>}
                    </span>
                    {said === null ? null : (
                      <details className={css.body} data-body="message">
                        <summary className={css.bodySummary}>
                          {t('section.message')}
                          <span className={css.bodySize}>{t('line.messageBody', { characters: [...said].length })}</span>
                        </summary>
                        <p className={css.bodyText}>{said}</p>
                      </details>
                    )}
                    {thinking === null ? null : (
                      <details className={css.body} data-body="thinking">
                        <summary className={css.bodySummary}>
                          {t('section.thinking')}
                          <span className={css.bodySize}>{t('line.messageBody', { characters: [...thinking].length })}</span>
                        </summary>
                        <p className={css.bodyText}>{thinking}</p>
                      </details>
                    )}
                    {reply === null ? null : (
                      <details className={css.body} data-body="reply">
                        <summary className={css.bodySummary}>
                          {t('section.reply')}
                          <span className={css.bodySize}>{t('line.messageBody', { characters: [...reply].length })}</span>
                        </summary>
                        <p className={css.bodyText}>{reply}</p>
                      </details>
                    )}
                  </div>
                )
              })}
              {index === groups.length - 1 ? null : <div className={css.divider} aria-hidden="true" />}
            </section>
          ))}
      </div>
    </div>
  )
}
