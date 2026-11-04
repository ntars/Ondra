/**
 * The run log's copy, in two languages.
 *
 * The log is the plain-language reading of what she did: every line narrates an
 * event the way a person would say it, and nothing in it is a developer detail.
 * That is a copy decision as much as a rendering one — the category labels below
 * are the only taxonomy the reader ever sees, so they are translated rather than
 * borrowed from the wire.
 *
 * The tool names are the one place the wire leaks through: a tool she invoked
 * has a name and the log keeps it, because inventing a different wording for
 * every future tool would make the log lie about what she picked up. The common
 * ones are translated; the rest are shown as they are.
 */

/** Every key the run log renders. */
export type RunLogKey =
  | 'view.runlog'
  | 'log.channel'
  | 'log.model'
  | 'log.tool'
  | 'log.pace'
  | 'log.error'
  | 'log.empty'
  | 'log.emptyHint'
  | 'sender.user'
  | 'sender.assistant'
  | 'sender.system'
  | 'step.label'
  | 'section.thinking'
  | 'section.reply'
  | 'section.context'
  | 'section.message'
  | 'group.turn'
  | 'group.count'
  | 'line.compacted'
  | 'line.received'
  | 'line.thinking'
  | 'line.thinkingBody'
  | 'line.replied'
  | 'line.repliedTimed'
  | 'line.repliedBody'
  | 'line.messageBody'
  | 'line.replyInterrupted'
  | 'line.turnStarted'
  | 'line.turnCompleted'
  | 'line.turnCompletedTimed'
  | 'line.turnBlocked'
  | 'line.turnAborted'
  | 'line.turnFailed'
  | 'line.turnFailedReason'
  | 'line.toolStarted'
  | 'line.toolFinished'
  | 'line.toolFailed'
  | 'line.contextInjected'
  | 'tool.bash'
  | 'tool.read'
  | 'tool.write'
  | 'tool.edit'
  | 'tool.find'
  | 'tool.web'
  | 'tool.delegate'
  | 'tool.unknown'

/** Chinese copy. */
export const zh: Record<RunLogKey, string> = {
  'view.runlog': '运行日志',
  'log.channel': '通道',
  'log.model': '模型',
  'log.tool': '工具',
  'log.pace': '节律',
  'log.error': '异常',
  'log.empty': '还没有动静',
  'log.emptyHint': '等她收到第一条消息，这里会记下她做了什么。',
  'sender.user': '你',
  'sender.assistant': '她',
  'sender.system': '系统',
  'step.label': '第 {step} 步',
  'section.thinking': '思考',
  'section.reply': '回复',
  'section.context': '上下文',
  'section.message': '消息',
  'group.turn': '第 {turn} 轮',
  'group.count': '{count} 条',
  'line.compacted': '上下文已压缩',
  'line.received': '收到一条消息 · {characters} 字',
  'line.thinking': '开始思考',
  'line.thinkingBody': '{characters} 字思考',
  'line.replied': '说完了 · {characters} 字',
  'line.repliedTimed': '说完了 · {characters} 字 · 想了 {seconds} 秒',
  'line.repliedBody': '回复 {characters} 字',
  'line.messageBody': '{characters} 字',
  'line.replyInterrupted': '说到一半被叫停 · 已经说了 {characters} 字',
  'line.turnStarted': '开始这一轮',
  'line.turnCompleted': '这一轮结束了',
  'line.turnCompletedTimed': '这一轮结束了 · 用了 {seconds} 秒',
  'line.turnBlocked': '这一轮停住了 · 有东西等她确认',
  'line.turnAborted': '这一轮被叫停',
  'line.turnFailed': '这一轮没能走完',
  'line.turnFailedReason': '这一轮没能走完 · {reason}',
  'line.toolStarted': '动手做：{tool}',
  'line.toolFinished': '做完了：{tool}',
  'line.toolFailed': '没做成：{tool}',
  'line.contextInjected': '注入上下文 · {characters} 字',
  'tool.bash': '在终端里跑命令',
  'tool.read': '看一个文件',
  'tool.write': '写一个文件',
  'tool.edit': '改一个文件',
  'tool.find': '找东西',
  'tool.web': '上网查',
  'tool.delegate': '派一个子任务',
  'tool.unknown': '一件工具',
}

/** English copy. */
export const en: Record<RunLogKey, string> = {
  'view.runlog': 'Run log',
  'log.channel': 'Channel',
  'log.model': 'Model',
  'log.tool': 'Tools',
  'log.pace': 'Pace',
  'log.error': 'Alerts',
  'log.empty': 'Nothing yet',
  'log.emptyHint': 'Once she receives a message, what she did will appear here.',
  'sender.user': 'You',
  'sender.assistant': 'Her',
  'sender.system': 'System',
  'step.label': 'Step {step}',
  'section.thinking': 'Thinking',
  'section.reply': 'Reply',
  'section.context': 'Context',
  'section.message': 'Message',
  'group.turn': 'Turn {turn}',
  'group.count': '{count} lines',
  'line.compacted': 'Context compacted',
  'line.received': 'A message came in · {characters} characters',
  'line.thinking': 'Started thinking',
  'line.thinkingBody': '{characters} characters of reasoning',
  'line.replied': 'Replied · {characters} characters',
  'line.repliedTimed': 'Replied · {characters} characters · {seconds}s of thinking',
  'line.repliedBody': 'Reply · {characters} characters',
  'line.messageBody': '{characters} characters',
  'line.replyInterrupted': 'Cut off mid-sentence · {characters} characters out',
  'line.turnStarted': 'This turn began',
  'line.turnCompleted': 'This turn finished',
  'line.turnCompletedTimed': 'This turn finished · {seconds}s',
  'line.turnBlocked': 'This turn is waiting on a confirmation',
  'line.turnAborted': 'This turn was stopped',
  'line.turnFailed': 'This turn did not finish',
  'line.turnFailedReason': 'This turn did not finish · {reason}',
  'line.toolStarted': 'Picked up: {tool}',
  'line.toolFinished': 'Done: {tool}',
  'line.toolFailed': 'Failed: {tool}',
  'line.contextInjected': 'Context injected · {characters} characters',
  'tool.bash': 'ran a command in the terminal',
  'tool.read': 'read a file',
  'tool.write': 'wrote a file',
  'tool.edit': 'edited a file',
  'tool.find': 'searched the workspace',
  'tool.web': 'looked something up online',
  'tool.delegate': 'handed off a subtask',
  'tool.unknown': 'a tool',
}
