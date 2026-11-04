/**
 * The run log's reading of a Session's own event stream.
 *
 * WHAT THIS FILE IS. A pure projection: Session events in, narrated lines out.
 * Nothing here renders and nothing here fetches, so the whole reading is
 * testable without a browser, and the view stays a dumb list.
 *
 * WHERE THE ROWS COME FROM. The Session binding's contiguous event window —
 * the same durable log the conversation is assembled from. That is deliberate:
 * the log is the *other* reading of one transcript, so it must be the same
 * evidence, not a parallel bookkeeping that can disagree with what was said.
 *
 * WHAT IS LEFT OUT. Chunks, request headers, system/developer prompts, token
 * usage, model ids — everything that only means something to someone holding
 * the protocol. A reader who does not know what an API is must understand every
 * line, which is why the vocabulary below is about what she did, not about what
 * the wire carried.
 *
 * The payloads are read structurally (`unknown` narrowed by tiny guards) rather
 * than by importing the Session event union: this package owns a *reading*, and
 * an event it does not recognise must degrade to "no line", never to a type
 * error that would stop the whole column from rendering.
 */

/** The families of work the reader sees as a chip. */
export type RunLogCategory = 'channel' | 'model' | 'tool' | 'pace' | 'error'

/** One thing she did, named the way a person would name it. */
export type RunLogLine =
  | { readonly kind: 'received'; readonly characters: number }
  | { readonly kind: 'thinking'; readonly characters: number }
  | { readonly kind: 'replied'; readonly characters: number; readonly seconds: number | null; readonly preview: string | null }
  | { readonly kind: 'replyInterrupted'; readonly characters: number }
  | { readonly kind: 'turnStarted' }
  | { readonly kind: 'turnCompleted'; readonly seconds: number | null }
  | { readonly kind: 'turnBlocked' }
  | { readonly kind: 'turnAborted' }
  | { readonly kind: 'turnFailed'; readonly reason: string | null }
  | { readonly kind: 'toolStarted'; readonly tool: string; readonly detail: string | null }
  | { readonly kind: 'toolFinished'; readonly tool: string; readonly detail: string | null; readonly elapsedMs: number | null }
  | { readonly kind: 'toolFailed'; readonly tool: string; readonly detail: string | null; readonly elapsedMs: number | null }
  | { readonly kind: 'contextInjected'; readonly characters: number; readonly preview: string | null }
  | { readonly kind: 'compacted' }

/** Which side of the exchange a row came from, for the sender badge. */
export type RunLogSender = 'user' | 'assistant' | 'system'

/** One log row: when, which family, what happened, and which turn it belongs to. */
export interface RunLogEntry {
  /** Stable row identity; position-based because the projection is append-only. */
  readonly id: string
  /** Unix epoch ms of the source event, or null when the event carried none. */
  readonly at: number | null
  readonly category: RunLogCategory
  readonly line: RunLogLine
  /**
   * The turn this row belongs to, or null before the first `turn/start`.
   *
   * Rows carry it so the view can group them: a reader scanning the log is
   * asking "what did she do in THIS exchange", and turn boundaries are the only
   * grouping the wire itself declares. Null is honest — an event that arrived
   * before any turn opened is not part of one.
   */
  readonly turn: number | null
  /** Which side produced this row; drives the sender badge. */
  readonly sender: RunLogSender
  /** The step inside its turn, when the event named one. */
  readonly step: number | null
  /**
   * The long-form text this row carries, when it has one: her reasoning, or what
   * she replied. The narration line stays short; this is what the reader opens
   * when they want the actual words. Null on rows with nothing to expand.
   */
  readonly body: string | null
}

/** What the log says at a glance, before reading any single line. */
export interface RunLogSummary {
  /** How many rows the reading holds. */
  readonly total: number
  /** Rows per family, so the column can both label and filter them. */
  readonly byCategory: Readonly<Record<RunLogCategory, number>>
  /** Epoch ms of the first and last row, or null on an empty reading. */
  readonly from: number | null
  readonly to: number | null
  /** How many turns the window covers. */
  readonly turns: number
}

/**
 * One entry of the Session event window, structurally.
 *
 * The window interleaves durable events with client-only live chunks; only the
 * durable ones are narrated, because a chunk is the same sentence half-typed.
 */
export interface RunLogRecord {
  readonly type: string
  readonly event: {
    readonly type: string
    readonly time: number
    readonly data: unknown
  }
}

/** The observable the view reads: the Session's contiguous event window. */
export interface RunLogSource {
  getSnapshot(): { readonly entries: readonly RunLogRecord[] }
  subscribe(listener: () => void): () => void
}

/** Read the reasoning text of an assistant message, when the wire carried one. */
function reasoningText(data: unknown): string {
  const message = field(data, 'message')
  const content = field(message, 'content')
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    const type = field(block, 'type')
    if (type !== 'reasoning' && type !== 'thinking') continue
    const body = field(block, 'text') ?? field(block, 'thinking')
    if (typeof body === 'string') out += body
  }
  return out
}

/**
 * Trim a message body to something a log line can show.
 *
 * The log is a narration, not a transcript: one long reply would push every
 * other row off screen. The cap is generous enough to carry the shape of what
 * was said (and the reader can always switch to 对话 for the whole thing) while
 * still keeping the list scannable.
 * @param text - the full spoken text.
 * @param max - code points to keep.
 * @returns the trimmed text with an ellipsis, or null when empty.
 */
function preview(text: string, max = 160): string | null {
  const trimmed = text.trim().replace(/\s+/gu, ' ')
  if (trimmed === '') return null
  const points = [...trimmed]
  return points.length > max ? `${points.slice(0, max).join('')}…` : trimmed
}
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

/** Read a nested string. */
function text(value: unknown, key: string): string | undefined {
  const found = field(value, key)
  return typeof found === 'string' ? found : undefined
}

/** Read a nested finite number. */
function count(value: unknown, key: string): number | undefined {
  const found = field(value, key)
  return typeof found === 'number' && Number.isFinite(found) ? found : undefined
}

/**
 * The visible text of a content block list.
 *
 * Only text blocks count toward a length: an image is not a word, and a tool
 * block is not speech.
 * @param content - a message's block list, of unknown shape.
 * @returns the concatenated text, empty when there is none.
 */
function spokenText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (field(block, 'type') !== 'text') continue
    const body = field(block, 'text')
    if (typeof body === 'string') out += body
  }
  return out
}

/**
 * How many characters a reader would say were spoken.
 * @param content - a message's block list.
 * @returns code-point length, so one Chinese character counts once.
 */
function spokenLength(content: unknown): number {
  return [...spokenText(content)].length
}

/**
 * The one thing a reader would want named about a tool call.
 *
 * A line saying only "picked up: read a file" leaves the obvious next question
 * — which file? — unanswered, and that is the difference between a log that
 * narrates and a log that just ticks. The argument keys below are the ones the
 * common tools use for their subject; the first present one wins. Anything
 * longer than the cap is trimmed, because this is a log line, not a payload
 * dump.
 *
 * The wire carries the arguments as a JSON STRING (`tool/call` declares
 * `arguments`, not an object), so it is parsed here and every failure — bad
 * JSON, a non-object, no known key — degrades to "nothing nameable" rather than
 * breaking the whole column.
 * @param raw - the call's argument payload, of unknown shape.
 * @returns the named subject, or null when the call carried nothing nameable.
 */
function toolDetail(raw: unknown): string | null {
  let args: unknown = raw
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (typeof args !== 'object' || args === null) return null
  const candidates = [
    'file_path', 'filePath', 'path', 'notebook_path',
    'command', 'pattern', 'query', 'url', 'description', 'prompt',
  ]
  for (const key of candidates) {
    const value = field(args, key)
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed === '') continue
    // A path is most useful as its tail: the column already says where she is.
    const shown = key === 'file_path' || key === 'filePath' || key === 'path' || key === 'notebook_path'
      ? (trimmed.split('/').at(-1) ?? trimmed)
      : trimmed
    return [...shown].length > 64 ? `${[...shown].slice(0, 64).join('')}…` : shown
  }
  return null
}

/**
 * Whole seconds between two event timestamps, rounded the way a person rounds.
 * @param from - start, epoch ms.
 * @param to - end, epoch ms.
 * @returns one decimal place of seconds, or null when the span is unusable.
 */
function secondsBetween(from: number | undefined, to: number | undefined): number | null {
  if (from === undefined || to === undefined || to < from) return null
  return Math.round((to - from) / 100) / 10
}

/**
 * The chip family for one line.
 * @param line - the named event.
 * @returns its family.
 */
function categoryOf(line: RunLogLine): RunLogCategory {
  switch (line.kind) {
    case 'received':
    case 'contextInjected':
      return 'channel'
    case 'thinking':
    case 'replied':
    case 'compacted':
      return 'model'
    case 'toolStarted':
    case 'toolFinished':
    case 'toolFailed':
      return 'tool'
    case 'turnStarted':
    case 'turnCompleted':
    case 'turnBlocked':
    case 'turnAborted':
      return 'pace'
    case 'replyInterrupted':
    case 'turnFailed':
      return 'error'
  }
}

/**
 * Which side of the exchange a line belongs to.
 *
 * The badge exists so a reader can tell at a glance who is acting: the person
 * spoke, she is working, or the machine told itself something. It is derived
 * from the line itself rather than tracked alongside it, so the two can never
 * disagree.
 * @param line - the named event.
 * @returns the sender.
 */
function senderOf(line: RunLogLine): RunLogSender {
  switch (line.kind) {
    case 'received':
      return 'user'
    case 'thinking':
    case 'replied':
    case 'replyInterrupted':
      return 'assistant'
    case 'contextInjected':
    case 'compacted':
      return 'system'
    default:
      return 'system'
  }
}

/**
 * Project a Session event window into log rows.
 *
 * Turns and steps are tracked only to time the two spans a reader cares about —
 * how long she thought before answering, and how long a whole Turn took — and
 * tool calls are paired by their durable call id so a result is never attributed
 * to whichever call happened to be last.
 * @param records - the Session's event window entries, in order.
 * @returns the narrated rows, oldest first.
 */
export function deriveRunLog(records: readonly RunLogRecord[]): readonly RunLogEntry[] {
  const entries: RunLogEntry[] = []
  const turnStarts = new Map<number, number>()
  const stepStarts = new Map<string, number>()
  const callNames = new Map<string, string>()
  // When each tool call started, so its result can report how long it took.
  const callStarts = new Map<string, number>()
  // The turn a row belongs to: opened by `turn/start`, closed by `turn/end`.
  let currentTurn: number | null = null

  const push = (
    record: RunLogRecord,
    line: RunLogLine,
    step: number | null = null,
    body: string | null = null,
  ): void => {
    entries.push({
      id: `run-log/${entries.length}`,
      at: Number.isFinite(record.event.time) ? record.event.time : null,
      category: categoryOf(line),
      line,
      turn: currentTurn,
      sender: senderOf(line),
      step,
      body,
    })
  }

  for (const record of records) {
    // A live chunk is the same sentence half-typed; only durable events narrate.
    if (record.type !== 'event' || record.event === undefined) continue
    const { type, time, data } = record.event

    switch (type) {
      case 'user/message': {
        const spoken = spokenText(field(data, 'content'))
        const characters = [...spoken].length
        // An injected context block (a file-change notice, a skill body) is not
        // someone talking; it is the machine telling itself something. It is
        // still worth one line — the reader should be able to see that context
        // arrived, and roughly how much — but as a CONTEXT badge, not a message.
        if (characters === 0) {
          const injected = spokenLength(field(data, 'content'))
          if (injected > 0) push(record, { kind: 'contextInjected', characters: injected, preview: null })
          break
        }
        push(record, { kind: 'received', characters }, null, preview(spoken, 400))
        break
      }
      case 'step/start': {
        const turn = count(data, 'turn')
        const step = count(data, 'step')
        if (turn !== undefined && step !== undefined) stepStarts.set(`${turn}/${step}`, time)
        push(record, { kind: 'thinking', characters: 0 }, step ?? null)
        break
      }
      case 'tool/call': {
        const name = text(data, 'name') ?? ''
        const callId = text(data, 'callId')
        if (callId !== undefined) {
          callNames.set(callId, name)
          // Start times feed the result line's duration: "how long did that
          // take" is the question a reader asks about a tool, and only the pair
          // can answer it.
          callStarts.set(callId, time)
        }
        push(record, { kind: 'toolStarted', tool: name, detail: toolDetail(field(data, 'arguments')) }, count(data, 'step') ?? null)
        break
      }
      case 'tool/result': {
        const message = field(data, 'message')
        const callId = text(message, 'toolCallId')
        const tool = (callId === undefined ? undefined : callNames.get(callId)) ?? ''
        const started = callId === undefined ? undefined : callStarts.get(callId)
        const elapsedMs = started === undefined ? null : time - started
        const failed = field(message, 'isError') === true
        push(record, { kind: failed ? 'toolFailed' : 'toolFinished', tool, detail: null, elapsedMs })
        break
      }
      case 'assistant/message': {
        const message = field(data, 'message')
        const spoken = spokenText(field(message, 'content'))
        const characters = [...spoken].length
        const interrupted = field(data, 'interrupted') === true
        const turn = count(data, 'turn')
        const step = count(data, 'step')
        const started = turn === undefined || step === undefined
          ? undefined
          : stepStarts.get(`${turn}/${step}`)
        // Reasoning rides the same event as the reply. Emitting it as its own
        // row is what makes the log a record of how she got there rather than
        // just what came out — the "思考过程" the reader asked for.
        const reasoning = reasoningText(data)
        if (reasoning.trim() !== '') {
          push(record, { kind: 'thinking', characters: [...reasoning].length }, step ?? null, reasoning.trim())
        }
        if (interrupted) {
          push(record, { kind: 'replyInterrupted', characters }, step ?? null)
          break
        }
        push(record, {
          kind: 'replied',
          characters,
          seconds: secondsBetween(started, time),
          preview: preview(spoken),
        }, step ?? null, spoken.trim() === '' ? null : spoken.trim())
        break
      }
      case 'turn/start': {
        const turn = count(data, 'turn')
        if (turn !== undefined) {
          turnStarts.set(turn, time)
          currentTurn = turn
        }
        push(record, { kind: 'turnStarted' })
        break
      }
      case 'turn/end': {
        const turn = count(data, 'turn')
        const started = turn === undefined ? undefined : turnStarts.get(turn)
        const reason = field(data, 'reason')
        switch (text(reason, 'kind')) {
          case 'completed':
            push(record, { kind: 'turnCompleted', seconds: secondsBetween(started, time) })
            break
          case 'aborted':
            push(record, { kind: 'turnAborted' })
            break
          case 'blocked':
            push(record, { kind: 'turnBlocked' })
            break
          case 'error':
            push(record, { kind: 'turnFailed', reason: errorReason(field(reason, 'error')) })
            break
          default:
            push(record, { kind: 'turnCompleted', seconds: secondsBetween(started, time) })
        }
        // The turn is over: rows after it and before the next `turn/start` are
        // not part of it.
        currentTurn = null
        break
      }
      default:
        break
    }
  }

  return entries
}

/**
 * Summarise a reading for the log's header strip.
 *
 * The counts are what a reader scans for before reading anything: how much
 * happened, how much of it was tooling, how long the span is, and how many
 * exchanges it covers. Everything here is derived from the rows themselves, so
 * the header can never disagree with the list under it.
 * @param entries - the narrated rows, oldest first.
 * @returns totals and the span the rows cover.
 */
export function summarizeRunLog(entries: readonly RunLogEntry[]): RunLogSummary {
  const byCategory: Record<RunLogCategory, number> = {
    channel: 0, model: 0, tool: 0, pace: 0, error: 0,
  }
  let from: number | null = null
  let to: number | null = null
  const turns = new Set<number>()
  for (const entry of entries) {
    byCategory[entry.category] += 1
    if (entry.turn !== null) turns.add(entry.turn)
    if (entry.at === null) continue
    if (from === null || entry.at < from) from = entry.at
    if (to === null || entry.at > to) to = entry.at
  }
  return { total: entries.length, byCategory, from, to, turns: turns.size }
}

/**
 * The shortest human-readable gist of a turn failure.
 * @param error - the failure facts, of unknown shape.
 * @returns the message when there is one, otherwise null.
 */
function errorReason(error: unknown): string | null {
  const message = text(error, 'message')
  if (message === undefined || message.trim() === '') return null
  const trimmed = message.trim()
  return trimmed.length > 120 ? `${[...trimmed].slice(0, 120).join('')}…` : trimmed
}
