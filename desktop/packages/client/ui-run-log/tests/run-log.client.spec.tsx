/**
 * The run log's projection: Session events in, narrated rows out.
 *
 * These are the only guarantees the column has — that every row comes from a
 * durable event it can point at, that a tool result lands on the call it
 * answers, and that spans are measured from the events themselves rather than
 * guessed. The rendering is deliberately not exercised here; it has nothing to
 * decide beyond the copy.
 */
import { describe, expect, it } from 'vitest'
import { deriveRunLog, summarizeRunLog, type RunLogRecord } from '../src/client/entries.ts'

/** One durable event at a fixed wall clock. */
function event(type: string, data: unknown, time = Date.UTC(2026, 10, 1, 12, 0, 0)): RunLogRecord {
  return { type: 'event', event: { type, time, data } }
}

/** One client-only live chunk, which the log must ignore. */
function chunk(type = 'assistant/live-chunk'): RunLogRecord {
  return { type: 'transient', event: { type, time: 0, data: null } }
}

/** A user message carrying plain text. */
function message(text: string, time?: number): RunLogRecord {
  return event('user/message', { id: 'm1', content: [{ type: 'text', text }], source: {} }, time)
}

describe('deriveRunLog', () => {
  it('narrates the shape of one exchange, in order', () => {
    const rows = deriveRunLog([
      event('turn/start', { turn: 1 }, 1_000),
      message('你好', 1_000),
      event('step/start', { turn: 1, step: 1 }, 1_000),
      event('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '在的' }] } }, 2_500),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3_000),
    ])

    expect(rows.map(row => row.line.kind)).toEqual([
      'turnStarted', 'received', 'thinking', 'replied', 'turnCompleted',
    ])
    // The reply is timed from its own step, the turn from its own opening.
    expect(rows[3]?.line).toMatchObject({ characters: 2, seconds: 1.5 })
    expect(rows[4]?.line).toMatchObject({ seconds: 2 })
    expect(rows.map(row => row.category)).toEqual(['pace', 'channel', 'model', 'model', 'pace'])
    expect(rows[1]?.at).toBe(1_000)
  })

  it('lands a tool result on the call it answers, by durable id', () => {
    const rows = deriveRunLog([
      event('tool/call', { turn: 1, step: 1, callId: 'a', name: 'Bash', arguments: '{}' }),
      event('tool/call', { turn: 1, step: 1, callId: 'b', name: 'Read', arguments: '{}' }),
      // The results arrive out of order; each must keep its own name.
      event('tool/result', { message: { toolCallId: 'b', isError: true } }),
      event('tool/result', { message: { toolCallId: 'a' } }),
    ])

    expect(rows.map(row => row.line)).toEqual([
      { kind: 'toolStarted', tool: 'Bash', detail: null },
      { kind: 'toolStarted', tool: 'Read', detail: null },
      { kind: 'toolFailed', tool: 'Read', detail: null, elapsedMs: 0 },
      { kind: 'toolFinished', tool: 'Bash', detail: null, elapsedMs: 0 },
    ])
    expect(rows.map(row => row.category)).toEqual(['tool', 'tool', 'tool', 'tool'])
  })

  it('leaves out what only means something to a protocol reader', () => {
    const rows = deriveRunLog([
      chunk(),
      event('request/header', { header: {} }),
      event('system/message', { turn: 1, step: 1, message: {} }),
      // An injected context block is the machine talking to itself, not a person.
      event('user/message', { id: 'c1', content: [{ type: 'text', text: '' }], source: {} }),
      event('tool/call', { turn: 1, step: 1, callId: 'a', name: 'Bash', arguments: '{}' }),
    ])

    expect(rows.map(row => row.line.kind)).toEqual(['toolStarted'])
  })

  it('reports a cut-off reply as its own line, with no timing claim', () => {
    const rows = deriveRunLog([
      event('step/start', { turn: 1, step: 1 }, 1_000),
      event('assistant/message', {
        turn: 1, step: 1, interrupted: true,
        message: { content: [{ type: 'text', text: '说到一半' }] },
      }, 2_000),
    ])

    expect(rows[1]).toMatchObject({ category: 'error', line: { kind: 'replyInterrupted', characters: 4 } })
  })

  it('names why a turn failed, without dumping the failure', () => {
    const long = 'x'.repeat(200)
    const rows = deriveRunLog([
      event('turn/start', { turn: 2 }, 1_000),
      event('turn/end', { turn: 2, reason: { kind: 'error', error: { message: long, code: 'UNKNOWN' } } }, 2_000),
    ])

    expect(rows[1]?.category).toBe('error')
    expect(rows[1]?.line).toMatchObject({ kind: 'turnFailed' })
    const reason = rows[1]?.line.kind === 'turnFailed' ? rows[1].line.reason : null
    expect(reason?.endsWith('…')).toBe(true)
    expect([...(reason ?? '')].length).toBe(121)
  })

  it('keeps blocked and stopped turns apart from failures', () => {
    const rows = deriveRunLog([
      event('turn/start', { turn: 1 }, 1_000),
      event('turn/end', { turn: 1, reason: { kind: 'blocked' } }, 1_100),
      event('turn/start', { turn: 2 }, 2_000),
      event('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 2_100),
    ])

    expect(rows.filter(row => row.category === 'pace').map(row => row.line.kind)).toEqual([
      'turnStarted', 'turnBlocked', 'turnStarted', 'turnAborted',
    ])
  })

  it('counts a message without text as no message at all', () => {
    expect(deriveRunLog([message('')])).toEqual([])
    expect(deriveRunLog([event('user/message', { id: 'i1', content: {}, source: {} })])).toEqual([])
  })

  it('has nothing to say about a session with no events', () => {
    expect(deriveRunLog([])).toEqual([])
  })

  it('names the subject of a tool call so a line answers "which one"', () => {
    const rows = deriveRunLog([
      event('tool/call', { callId: 'a', name: 'Read', arguments: '{"file_path":"/w/src/deep/nested/file.ts"}' }),
      event('tool/call', { callId: 'b', name: 'Bash', arguments: '{"command":"pnpm run build"}' }),
      // A path is shown by its tail: the column already says where she is.
      event('tool/call', { callId: 'c', name: 'Write', arguments: '{"path":"out.txt"}' }),
    ])

    expect(rows.map(row => row.line.kind === 'toolStarted' ? row.line.detail : 'x')).toEqual([
      'file.ts', 'pnpm run build', 'out.txt',
    ])
  })

  it('degrades an unreadable tool payload to no detail instead of failing', () => {
    const rows = deriveRunLog([
      event('tool/call', { callId: 'a', name: 'Bash', arguments: 'not json' }),
      event('tool/call', { callId: 'b', name: 'Bash', arguments: '{}' }),
      event('tool/call', { callId: 'c', name: 'Bash' }),
      event('tool/call', { callId: 'd', name: 'Bash', arguments: '{"unrelated":1}' }),
    ])

    expect(rows.map(row => (row.line.kind === 'toolStarted' ? row.line.detail : 'bad'))).toEqual([
      null, null, null, null,
    ])
  })

  it('attributes rows to the turn that opened them, and to none outside a turn', () => {
    const rows = deriveRunLog([
      // Before any turn opened: belongs to no turn.
      event('user/message', { id: 'm0', content: [{ type: 'text', text: 'hi' }], source: {} }, 900),
      event('turn/start', { turn: 1 }, 1_000),
      event('step/start', { turn: 1, step: 1 }, 1_010),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1_500),
      // After the turn closed: also belongs to no turn.
      event('user/message', { id: 'm1', content: [{ type: 'text', text: 'again' }], source: {} }, 2_000),
      event('turn/start', { turn: 2 }, 3_000),
      event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 3_500),
    ])

    expect(rows.map(row => row.turn)).toEqual([null, 1, 1, 1, null, 2, 2])
  })

  it('summarises totals, families, span and turn count for the header strip', () => {
    const rows = deriveRunLog([
      event('turn/start', { turn: 1 }, 1_000),
      event('user/message', { id: 'm', content: [{ type: 'text', text: 'hi' }], source: {} }, 1_100),
      event('step/start', { turn: 1, step: 1 }, 1_200),
      event('tool/call', { callId: 'a', name: 'Read', arguments: '{}' }, 1_300),
      event('tool/result', { message: { toolCallId: 'a' } }, 1_400),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5_000),
    ])
    const summary = summarizeRunLog(rows)

    expect(summary.total).toBe(6)
    expect(summary.turns).toBe(1)
    expect(summary.from).toBe(1_000)
    expect(summary.to).toBe(5_000)
    expect(summary.byCategory).toEqual({ channel: 1, model: 1, tool: 2, pace: 2, error: 0 })
  })

  it('summarises an empty reading without inventing a span', () => {
    const summary = summarizeRunLog([])
    expect(summary).toEqual({
      total: 0,
      byCategory: { channel: 0, model: 0, tool: 0, pace: 0, error: 0 },
      from: null,
      to: null,
      turns: 0,
    })
  })
})
