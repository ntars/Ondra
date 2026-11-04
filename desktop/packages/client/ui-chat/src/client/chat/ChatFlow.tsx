/**
 * Ordered Chat rows, local echoes, and (since they are the whole transcript)
 * nothing else.
 *
 * The flow shows a conversation the way a messenger does: what the user said,
 * what she answered, and the artifacts she produced inside the answer. The
 * machine's own work — reasoning blocks, tool invocations, injected context,
 * compaction notices, the "深度求索中，用时 N 秒" running line — belongs to the
 * run log, which the left column's 对话 / 日志 switch opens. Rendering it here
 * as well would put the same event on screen twice.
 */
import { memo } from 'react'
import { assertNever } from '@ntars/ondra-util-values'
import type { ChatFlowSlotProps } from '../contract/slots.ts'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import { PendingSteeringBubble, PendingSubmissionBubble } from './MessageItem.tsx'
import { chatRenderKey } from './render-entry.ts'

/**
 * Node kinds the conversation shows: the two speakers and the result tail.
 * Everything else is machine work and lives in the run log only.
 */
const CONVERSATION_KINDS: ReadonlySet<string> = new Set([
  'user',
  'steering',
  'assistant-step',
  'turn-tail',
  'turn-error',
  'turn-max-tokens',
])

/** Render the flow without adding a DOM parent or changing keyed row positions. */
export const ChatFlow = memo(function ChatFlow({
  entries, pendingInputs, deferCollapse,
  useChat, useChatNode, useChatNodeBottom, useChatNodeProcess, usePresentation,
  useStore, actions, renderSlot, renderFactorySlot, t, useGroupAction,
  cwd, openFile, inspectCall, forkAt, loadImage, fileMentions,
}: ChatFlowSlotProps) {
  const nodeStore = useChat(snapshot => snapshot.nodes)
  const seatProps = {
    nodeStore, useChatNode, useChatNodeBottom, useChatNodeProcess, usePresentation,
    useStore, actions, renderSlot, t, useGroupAction, deferCollapse,
    cwd, openFile, inspectCall, forkAt, loadImage, fileMentions,
  }
  const rows = entries.flatMap((entry) => {
    switch (entry.kind) {
      case 'node': {
        const kind = nodeStore.get(entry.key)?.kind
        if (kind === undefined || !CONVERSATION_KINDS.has(kind)) return []
        return [<ChatNodeSeat {...seatProps} key={chatRenderKey(entry)} nodeKey={entry.key}
          {...entry.groupPart === undefined ? {} : { groupPart: entry.groupPart }} />]
      }
      // A process group is the folded machine work of one Turn: the run log
      // owns it, so the conversation skips it whole.
      case 'group':
        return []
      default:
        return assertNever(entry)
    }
  })
  const pendingRows = pendingInputs.map(item => ('requestId' in item
    ? <PendingSubmissionBubble key={item.requestId} submission={item}
      loadImage={loadImage} renderFactorySlot={renderFactorySlot} t={t} />
    : <PendingSteeringBubble key={item.id} content={item.content}
      loadImage={loadImage} renderFactorySlot={renderFactorySlot} t={t} />))
  return [...rows, ...pendingRows]
})
