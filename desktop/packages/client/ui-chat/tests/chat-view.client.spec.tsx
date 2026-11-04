// @vitest-environment jsdom

import type { ProcessGroupData } from '../src/client/contract/process-groups.ts'
import type { InboxState } from '@ntars/ondra-agent/types'
import { MessageId } from '@ntars/ondra-llm/brand'
import type { GlobalStandardProps, PropsRenderFactories, PropsRenderSlots } from '@ntars/ondra-client-ui-slots'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { useMemo } from 'react'
import type {
  AssistantMessageNode, ChatFlowHookContext, ChatFlowOwnerProps, ChatFlowSlotProps,
  ChatNode, ChatNodeHookContext, ChatNodeOwnerProps, ChatSnapshot, UserBeforeOwnerProps,
  ChatViewSlotProps, ConversationNode,
  LegacyConversationSlice, StartedToolCall, SteeringMessageNode,
  ToolCallBlock, ToolResultNode, TurnErrorNode, TurnMaxTokensNode,
  TranscriptViewMode, UserContentInput, UserMessageNode,
} from '@ntars/ondra-client-ui-chat/client'
import type {
  SessionListState, SessionSnapshot,
} from '@ntars/ondra-api-session-controller/client'
import type {
  ConversationGroupedView,
  ConversationSnapshot, ConversationViewSnapshotStore, GroupKey, GroupSnapshot,
  MessageImagesOwnerProps, NodeKey,
} from '@ntars/ondra-client-ui-conversation/client'
import type { WorkspaceSnapshot } from '@ntars/ondra-api-workspace-controller/client'
import type { SessionId } from '@ntars/ondra-session/types'
import type { SessionStatusSnapshot } from '@ntars/ondra-client-ui-session/client'
import type { KeyedSnapshotSelectorHook, SnapshotSelectorHook } from '@ntars/ondra-client-ui-slots'
import { allowAllAccess, bindSnapshotSelector, makeTranslate } from '@ntars/ondra-client-test-runtime'
import { createSnapshotStore, type ObservableSnapshot } from '@ntars/ondra-client-store'
import type { ConnectionState } from '@ntars/ondra-client-connection/client'
import { EMPTY_CONVERSATION_SNAPSHOT } from '@ntars/ondra-client-ui-conversation/client'
import { en as commonEn } from '@ntars/ondra-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@ntars/ondra-client-locale/src/locales/zh.ts'
import { PartialArguments } from '@ntars/ondra-util-values'
import { createChatStore } from '../src/client/stores.ts'
import { derivePresentationPolicy, type CollapseTiming, type FoldedReplies } from '../src/client/presentation-policy.ts'
import { CHAT_FLOW_INJECT, CHAT_NODE_INJECT } from '../src/client/apply.ts'
import { ChatView } from '../src/client/chat/ChatView.tsx'
import { ChatFlow } from '../src/client/chat/ChatFlow.tsx'
import { en, zh } from '../src/client/locale.ts'
import { AssistantNodeView } from '../src/client/chat/AssistantNodeView.tsx'
import { CommandNodeView, ManualCompactionNodeView } from '../src/client/chat/CommandNodeView.tsx'
import {
  CompactionNodeView, ContextMessageNodeView, RetryNodeView, TurnErrorNodeView,
  TurnMaxTokensNodeView, UnknownNodeView, UserMessageNodeView,
} from '../src/client/chat/MessageItem.tsx'
import { TurnTailNodeView } from '../src/client/chat/TurnTailNodeView.tsx'
import { TurnProcessNodeView } from '../src/client/chat/TurnProcessNodeView.tsx'
import { SystemPromptNodeView } from '../src/client/chat/SystemPromptRow.tsx'
import { formatRunDuration as durationParts } from '../src/client/chat/message-chrome.ts'
import { ChatSnapshotBuilder } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'
import { installTurnNavigatorObserver } from './turn-navigator-fixture.ts'
import { renderReasoningSlot } from './reasoning-component-fixture.tsx'
import { createUserContentFixture } from './user-content-component-fixture.tsx'
import { ConversationGroupStore } from '../../ui-conversation/src/client/conversation/group-store.ts'

// Every session-scope fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined })) as GlobalStandardProps['useResource']

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
// Keyless create() persists under the bare declared key; clear between cases
// so one harness's selection cannot rehydrate into the next.
beforeEach(() => {
  localStorage.clear()
  installTurnNavigatorObserver()
})

const SID = 's1' as SessionId
type RoutedChatNodeOwner = Parameters<NodeRenderer>[1]

interface TestSessionSnapshot extends SessionSnapshot {
  readonly testInbox?: InboxState
}

function sessionSnapshot(overrides: Partial<TestSessionSnapshot> = {}): TestSessionSnapshot {
  return {
    sessionId: SID,
    pendingSubmissions: [],
    running: false,
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    subagent: null,
    lastAgentError: null,
    promptAttempted: true,
    awaitingFirstTurn: false,
    ...overrides,
  }
}

/** Scripted Session source: set() swaps the top-level object like the real Controller binding. */
function makeSessionSource(init: Partial<TestSessionSnapshot> = {}) {
  let snap = sessionSnapshot(init)
  const subs = new Set<() => void>()
  return {
    set: (next: Partial<TestSessionSnapshot>) => {
      snap = { ...snap, ...next }
      for (const fn of [...subs]) fn()
    },
    source: {
      getSnapshot: () => snap,
      subscribe: (fn: () => void) => {
        subs.add(fn)
        return () => subs.delete(fn)
      },
    },
  }
}

type ChatSlice = Partial<LegacyConversationSlice> & {
  readonly turnUsages?: NonNullable<Parameters<typeof chatSnapshotFixture>[0]>['turnUsages']
}
type HarnessUpdate = ChatSlice & Partial<TestSessionSnapshot> & { readonly chat?: ChatSnapshot }

/** Scripted Chat target source, independent from Session lifecycle state. */
function makeChatSource(init: ChatSlice = {}, snapshot?: ChatSnapshot) {
  let snap = snapshot ?? chatSnapshotFixture(init)
  const subs = new Set<() => void>()
  return {
    set: (next: ChatSlice) => {
      snap = chatSnapshotFixture({ ...snap.legacy, ...next }, snap)
      for (const fn of [...subs]) fn()
    },
    replace: (next: ChatSnapshot) => {
      snap = next
      for (const fn of [...subs]) fn()
    },
    source: {
      getSnapshot: () => snap,
      subscribe: (fn: () => void) => {
        subs.add(fn)
        return () => subs.delete(fn)
      },
    },
  }
}

const user = (seq: number, text: string): UserMessageNode => ({
  kind: 'user',
  seq,
  time: seq * 1000,
  content: [{ type: 'text', text }] as never,
  source: null,
})
const userInTurn = (seq: number, text: string, turn: number): ConversationNode => ({
  ...user(seq, text),
  // The production Location index owns this association. The legacy fixture
  // accepts the extra coordinate so component tests can build the same view.
  turn,
} as unknown as ConversationNode)
const assistant = (seq: number, text: string, turn = 1, step = 1): AssistantMessageNode => ({
  kind: 'assistant', seq, time: seq * 1_000, turn, step, blocks: [{ kind: 'text', text }],
})
const steering = (seq: number, text: string, turn: number): SteeringMessageNode & { turn: number } => ({
  kind: 'steering', messageId: `steering-${String(seq)}` as SteeringMessageNode['messageId'],
  seq, time: seq * 1_000, turn, content: [{ type: 'text', text }], source: null,
})
const turnError = (seq: number, code?: string): TurnErrorNode => ({
  kind: 'turn-error', seq, time: seq * 1_000, turn: 1, step: 0,
  message: seq === 2 ? 'API key is invalid' : 'plugin exploded',
  ...(code === undefined ? {} : { code }),
})
const turnMaxTokens = (seq: number): TurnMaxTokensNode => ({
  kind: 'turn-max-tokens', seq, time: seq * 1_000, turn: 1, step: 0,
})
const toolResult = (seq: number, callId: string, name = 'bash'): ToolResultNode => ({
  kind: 'tool-result', seq, time: seq * 1_000, callId,
  name, args: PartialArguments.fromText(`{"command":"cmd-${callId}","description":"run ${callId}"}`),
  call: { name, argsRaw: `{"command":"cmd-${callId}","description":"run ${callId}"}` },
  callTime: seq * 1_000 - 500,
  content: [], isError: false, subCalls: [],
})
const runningCall = (callId: string, name = 'bash'): StartedToolCall => ({
  phase: 'start' as const, args: PartialArguments.fromText(`{"command":"cmd-${callId}"}`), callId, name, argsRaw: `{"command":"cmd-${callId}"}`, turn: 2, step: 1, time: 1_000, subCalls: [],
})

/** Empty sessions-list hook for the global standard-kit seat. */
function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} })
  return bindSnapshotSelector(store)
}

function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  })
  return bindSnapshotSelector(store)
}

function bindKeyedSnapshotSelector<Value>(
  resolve: (key: string) => ObservableSnapshot<Value>,
): KeyedSnapshotSelectorHook<Value> {
  const hooks = new WeakMap<object, SnapshotSelectorHook<Value>>()
  return ((key: string, selector?: (value: Value) => unknown, equal?: (left: unknown, right: unknown) => boolean) => {
    const source = resolve(key)
    let useValue = hooks.get(source)
    if (useValue === undefined) {
      useValue = bindSnapshotSelector(source)
      hooks.set(source, useValue)
    }
    return useValue(selector ?? ((value: Value) => value), equal)
  }) as KeyedSnapshotSelectorHook<Value>
}

declare const nodeDispatch: PropsRenderSlots<'conversation.chat.node'>['renderSlot']
declare const flowDispatch: PropsRenderSlots<'conversation.chat.flow'>['renderSlot']
type NodeRenderer = typeof nodeDispatch<'conversation.chat.node'>
type FlowRenderer = typeof flowDispatch<'conversation.chat.flow'>
type ImageRenderer = (owner: MessageImagesOwnerProps) => React.ReactNode
declare const userChainDispatch: PropsRenderSlots<'conversation.chat.user.before'>['renderSlotChain']
type UserChainRenderer = typeof userChainDispatch<'conversation.chat.user.before'>
type UserChainState = { readonly renderer: UserChainRenderer | undefined }
type HarnessStandardProps = ChatViewSlotProps & PropsRenderFactories

function isImageOwner(owner: object): owner is MessageImagesOwnerProps {
  return 'images' in owner && Array.isArray(owner.images)
    && 'loadImage' in owner && typeof owner.loadImage === 'function'
    && 'align' in owner && (owner.align === 'start' || owner.align === 'end')
}
type ToolOwner = Pick<ChatNodeOwnerProps, 'openFile' | 'inspectCall'> & {
  readonly callId: string
  readonly toolName: string
  readonly block: ToolCallBlock
}

const renderCommandSlot: React.ComponentProps<typeof CommandNodeView>['renderSlot'] =
  (_key, _owner, opts) => opts?.fallback ?? null
const renderTurnTailSlot: React.ComponentProps<typeof TurnTailNodeView>['renderSlot'] = () => null

function HarnessChatFlow({ standard, owner, hookContext, renderSlot, useConnectionState }: {
  readonly standard: HarnessStandardProps
  readonly owner: ChatFlowOwnerProps
  readonly hookContext: ChatFlowHookContext
  readonly renderSlot: ChatFlowSlotProps['renderSlot']
  readonly useConnectionState: ChatFlowSlotProps['useConnectionState']
}) {
  const hooks = useMemo(() => ({
    useGroupAction: CHAT_FLOW_INJECT.hooks.groupAction(standard, hookContext),
    useGroupHeaderAction: CHAT_FLOW_INJECT.hooks.groupHeaderAction(standard, hookContext),
  }), [standard, hookContext])
  const { renderSlot: _rootRenderSlot, __renders: _rootRenders, ...shared } = standard
  return <ChatFlow {...shared} {...owner} {...hooks} renderSlot={renderSlot}
    useConnectionState={useConnectionState} />
}

function HarnessUserOrigin({ useRenderer, owner, options }: {
  readonly useRenderer: SnapshotSelectorHook<UserChainState>
  readonly owner: UserBeforeOwnerProps
  readonly options: Parameters<UserChainRenderer>[2]
}) {
  const renderer = useRenderer(value => value.renderer)
  return renderer?.('conversation.chat.user.before', owner, options) ?? options?.fallback ?? null
}

function HarnessChatNode({
  standard, owner, hookContext, usePerformanceUsage, toolOwners, fallback, renderAssistantSlot, renderUserChain,
}: {
  readonly standard: HarnessStandardProps
  readonly owner: RoutedChatNodeOwner
  readonly hookContext: ChatNodeHookContext
  readonly usePerformanceUsage: React.ComponentProps<typeof TurnTailNodeView>['usePerformanceUsage']
  readonly toolOwners: ToolOwner[]
  readonly fallback: React.ReactNode
  readonly renderAssistantSlot: React.ComponentProps<typeof AssistantNodeView>['renderSlot']
  readonly renderUserChain: PropsRenderSlots<'conversation.chat.user.before'>['renderSlotChain']
}) {
  const hooks = useMemo(() => ({
    useTurnData: CHAT_NODE_INJECT.hooks.turnData(standard, hookContext),
    useDisclosure: CHAT_NODE_INJECT.hooks.disclosure(standard, hookContext),
    useGroupAction: CHAT_NODE_INJECT.hooks.groupAction(standard, hookContext),
  }), [standard, hookContext])
  const { renderSlot: _rootRenderSlot, __renders: _rootRenders, ...shared } = standard
  const nodeProps = { ...shared, ...owner, ...hooks }
  switch (owner.node.kind) {
    case 'user':
      return <UserMessageNodeView {...nodeProps} node={owner.node} renderSlotChain={renderUserChain} />
    case 'steering':
      return <UserMessageNodeView {...nodeProps} node={owner.node} renderSlotChain={() => null} />
    case 'context':
      return <ContextMessageNodeView {...nodeProps} node={owner.node} />
    case 'assistant-step':
      return <AssistantNodeView {...nodeProps} node={owner.node} renderSlot={renderAssistantSlot} />
    case 'command':
      return <CommandNodeView {...nodeProps} node={owner.node} renderSlot={renderCommandSlot} />
    case 'manual-compaction':
      return <ManualCompactionNodeView {...nodeProps} node={owner.node} />
    case 'compaction':
      return <CompactionNodeView {...nodeProps} node={owner.node} />
    case 'model-retry':
      return <RetryNodeView {...nodeProps} node={owner.node} />
    case 'turn-error':
      return <TurnErrorNodeView {...nodeProps} node={owner.node} />
    case 'turn-max-tokens':
      return <TurnMaxTokensNodeView {...nodeProps} node={owner.node} />
    case 'turn-process':
      return <TurnProcessNodeView {...nodeProps} node={owner.node} />
    case 'system-prompt':
      return <SystemPromptNodeView {...nodeProps} node={owner.node} />
    case 'turn-tail':
      return <TurnTailNodeView {...nodeProps} node={owner.node}
        usePerformanceUsage={usePerformanceUsage} renderSlot={renderTurnTailSlot} />
    case 'unknown':
      return <UnknownNodeView {...nodeProps} node={owner.node} />
    case 'tool-call': {
      const block = owner.node.data.root
      const toolName = 'kind' in block ? block.call?.name ?? '' : block.name
      const tool = { callId: block.callId, toolName, block, openFile: owner.openFile, inspectCall: owner.inspectCall }
      toolOwners.push(tool)
      return (
        <div
          data-testid={`tool-seat-${tool.callId}`}
          data-chat-anchor-key={`call:${tool.callId}`}
          data-chat-call-id={tool.callId}
        >
          {tool.toolName || '(unnamed)'}:{tool.callId}
        </div>
      )
    }
    default:
      return fallback ?? null
  }
}

function makeHarness(
  init: HarnessUpdate = {},
  sessionOverrides: Partial<TestSessionSnapshot> = {},
  chatSnapshot?: ChatSnapshot,
) {
  const {
    chat: initialChat, nodes, partial, runningCalls, turnTimings, turnEnds, turnUsages,
    ...sessionInit
  } = init
  const chatSlice: ChatSlice = {
    ...(nodes === undefined ? {} : { nodes }),
    ...(partial === undefined ? {} : { partial }),
    ...(runningCalls === undefined ? {} : { runningCalls }),
    ...(turnTimings === undefined ? {} : { turnTimings }),
    ...(turnEnds === undefined ? {} : { turnEnds }),
    ...(turnUsages === undefined ? {} : { turnUsages }),
  }
  const session = makeSessionSource({ ...sessionInit, ...sessionOverrides })
  const useTestSession = bindSnapshotSelector(session.source)
  const chatSource = makeChatSource(chatSlice, initialChat ?? chatSnapshot)
  const useChatNode = bindKeyedSnapshotSelector(
    key => chatSource.source.getSnapshot().nodes.source(key),
  )
  const useChatNodeProcess = bindKeyedSnapshotSelector(
    key => chatSource.source.getSnapshot().nodes.processSource(key),
  )
  let grouped: ConversationGroupedView<ProcessGroupData> | undefined
  const absentGroup = createSnapshotStore<GroupSnapshot<ProcessGroupData> | undefined>(undefined)
  const conversation = createSnapshotStore<ConversationSnapshot>({
    ...EMPTY_CONVERSATION_SNAPSHOT,
    views: {
      ...EMPTY_CONVERSATION_SNAPSHOT.views,
      grouped: (() => grouped) as ConversationViewSnapshotStore['grouped'],
    },
  })
  const useChatGroup = bindKeyedSnapshotSelector(
    key => grouped?.groupSource(key as GroupKey) ?? absentGroup,
  )
  const openFile = vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined)
  const openUserFile = vi.fn<(path: string) => void>()
  const renderUserContent = createUserContentFixture({ openFile: openUserFile })
  const loadOlder = vi.fn()
  const loadThrough = vi.fn<(seq: number) => Promise<void>>().mockResolvedValue(undefined)
  // Mutable outline holder: tests swap the value and drive a re-render via set().
  let outlineValue: unknown
  const openView = vi.fn<(view: string, focus: string) => void>()
  // In-memory scroll memory matching the apply.ts per-session map contract.
  let savedScroll: ReturnType<ChatViewSlotProps['chatScroll']['read']> = null
  const chatScroll: ChatViewSlotProps['chatScroll'] = {
    save: (position) => { savedScroll = position },
    read: () => savedScroll,
  }
  const forkAt = vi.fn()
  // Rows and the harness must observe the same chat-store instance.
  const chat = createChatStore().create()
  const transcriptView = createSnapshotStore<TranscriptViewMode>('compact')
  const collapseTiming = createSnapshotStore<CollapseTiming>('completion')
  const foldedReplies = createSnapshotStore<FoldedReplies>('all')
  const performanceUsage = createSnapshotStore<'compact' | 'detailed'>('detailed')
  const originRenderer = createSnapshotStore<UserChainState>({ renderer: undefined })
  const t = makeTranslate(zh, commonZh)
  const toolOwners: ToolOwner[] = []
  const usePerformanceUsage = bindSnapshotSelector(performanceUsage)
  const useOriginRenderer = bindSnapshotSelector(originRenderer)
  let nodeSlotOverride: NodeRenderer | undefined
  let imageSlotOverride: ImageRenderer | undefined
  const renderImages = (name: string, owner: object, options?: { fallback?: React.ReactNode }) => {
    if ((name !== 'conversation.chat.user.images' && name !== 'conversation.chat.message.images') || !isImageOwner(owner)) {
      throw new Error(`Unexpected Chat image Slot: ${name}`)
    }
    return imageSlotOverride?.(owner) ?? options?.fallback ?? null
  }
  const renderAssistantSlot: React.ComponentProps<typeof AssistantNodeView>['renderSlot'] = (name, owner, options) =>
    name === 'conversation.chat.message.images' ? renderImages(name, owner, options) : renderReasoningSlot(name, owner, options)
  const renderNodeSlot: NodeRenderer = (key, owner, opts) => {
    if (nodeSlotOverride !== undefined) return nodeSlotOverride(key, owner, opts)
    return <HarnessChatNode standard={props} owner={owner}
      hookContext={opts.hookContext} usePerformanceUsage={usePerformanceUsage}
      toolOwners={toolOwners} fallback={opts.fallback} renderAssistantSlot={renderAssistantSlot}
      renderUserChain={renderUserChain} />
  }
  const renderFlowSlot: ChatFlowSlotProps['renderSlot'] = (key: string, owner: object, opts?: {
    fallback?: React.ReactNode
    hookContext?: unknown
  }) => {
    if (key === 'conversation.chat.node') {
      return renderNodeSlot(key, owner as RoutedChatNodeOwner, opts as Parameters<NodeRenderer>[2])
    }
    throw new Error(`Undeclared flow child: ${key}`)
  }
  const renderUserChain: PropsRenderSlots<'conversation.chat.user.before'>['renderSlotChain'] = (key, owner, opts) => {
    if (key !== 'conversation.chat.user.before') throw new Error(`Undeclared user chain: ${key}`)
    return <HarnessUserOrigin useRenderer={useOriginRenderer} owner={owner as UserBeforeOwnerProps} options={opts} />
  }
  const renderFactorySlot: PropsRenderFactories['renderFactorySlot'] = (name, owner) => {
    if (name !== 'conversation.chat.user.content') throw new Error(`Unexpected Chat Factory: ${name}`)
    return renderUserContent(owner as UserContentInput, renderImages, props.t)
  }
  const renderSlot = (key: string, owner: ChatFlowOwnerProps, opts: Parameters<FlowRenderer>[2]) => {
    if (key === 'conversation.chat.text-interaction') return null
    if (key !== 'conversation.chat.flow') throw new Error(`Undeclared ChatView child: ${key}`)
    if ('renderSlot' in owner || 'useStore' in owner || 'actions' in owner) {
      throw new Error('Flow owner data must not replace its rendering or store authority')
    }
    return <HarnessChatFlow standard={props} owner={owner} hookContext={opts.hookContext} renderSlot={renderFlowSlot}
      useConnectionState={useConnectionState} />
  }
  // SessionProvider seat arrives with the session-scope child declaration;
  // ChatView never invokes it (pass-through stub).
  const connection = createSnapshotStore<ConnectionState | undefined>('connected')
  const useConnectionState = bindSnapshotSelector(connection)
  const SessionProviderStub: ChatViewSlotProps['SessionProvider'] = ({ children }) => <>{children}</>
  const props: HarnessStandardProps = {
    fileDrag,
    renderFactorySlot,
    usePanelInfo: selector => selector({ activePanelId: null }),
    sessionId: SID,
    useSession: bindSnapshotSelector(session.source),
    useChat: bindSnapshotSelector(chatSource.source),
    useChatNode,
    useChatNodeBottom: bindKeyedSnapshotSelector(key => chatSource.source.getSnapshot().nodes.bottomSource(key)),
    useChatNodeProcess,
    useChatGroup,
    useConversation: bindSnapshotSelector(conversation),
    useTrajectory: (() => { throw new Error('unused') }),
    useSessions: emptySessions(),
    useSessionRetainInfo: () => undefined,
    useResource,
    useSessionStatus: bindSnapshotSelector(
      createSnapshotStore<SessionStatusSnapshot>(new Map()),
    ),
    useWorkspaces: emptyWorkspaces(),
    ...allowAllAccess,
    useProjection: (key: string) => {
      const inbox = useTestSession(snapshot => snapshot.testInbox)
      return key === 'inbox' ? inbox : outlineValue
    },
    useInput: (() => { throw new Error('unused') }),
    inputActions: {
      insertQuote: () => false,
      captureInsertion: () => ({ start: 0, end: 0, draftRev: 0 }),
      insertText: () => false,
      setDraft: () => {},
      persistDraft: () => {},
      addAttachments: () => true,
      removeAttachment: () => {},
      pruneAttachments: () => {},
      submit: () => {},
    },
    useStore: bindSnapshotSelector(chat),
    actions: chat.actions,
    useInteractionIds: bindSnapshotSelector(createSnapshotStore<readonly string[]>([])),
    dispatchInteraction: () => null,
    usePresentation: bindSnapshotSelector(derivePresentationPolicy(transcriptView, collapseTiming, foldedReplies)),
    // The fixture implements the concrete flow dispatch behind the generic slot signature.
    renderSlot: renderSlot as ChatViewSlotProps['renderSlot'],
    SessionProvider: SessionProviderStub,
    inspectCall: (callId: string) => { openView('trajectory', callId) },
    viewRequest: null,
    openView,
    completeViewRequest: () => {},
    openFile,
    openExternalLink: vi.fn(),
    loadOlder,
    loadThrough,
    loadImage: vi.fn(() => Promise.reject(new Error('not used'))),
    chatScroll,
    forkAt,
    // Absent-service default; mention tests override with a real resolver.
    fileMentions: () => undefined,
    t,
  }
  const set = (next: HarnessUpdate): void => {
    const {
      chat: explicitChat, nodes, partial, runningCalls, turnTimings, turnEnds,
      ...sessionUpdate
    } = next
    if (explicitChat !== undefined) chatSource.replace(explicitChat)
    else if (nodes !== undefined || partial !== undefined || runningCalls !== undefined
      || turnTimings !== undefined || turnEnds !== undefined) {
      chatSource.set({
        ...(nodes === undefined ? {} : { nodes }),
        ...(partial === undefined ? {} : { partial }),
        ...(runningCalls === undefined ? {} : { runningCalls }),
        ...(turnTimings === undefined ? {} : { turnTimings }),
        ...(turnEnds === undefined ? {} : { turnEnds }),
      })
    }
    session.set(sessionUpdate)
  }
  return {
    set, setSession: session.set, setChat: chatSource.set, ChatView, props,
    setConnection: (state: ConnectionState) => { connection.set(state) },
    openFile, openUserFile, loadOlder, loadThrough, openView,
    setOutline: (value: unknown) => { outlineValue = value },
    chatScroll, forkAt, toolOwners,
    setPerformanceUsage: (mode: 'compact' | 'detailed') => { performanceUsage.set(mode) },
    setGrouped: (value: ConversationGroupedView<ProcessGroupData> | undefined) => {
      grouped = value
      conversation.set({ ...conversation.getSnapshot() })
    },
    setTranscriptView: (mode: TranscriptViewMode) => { transcriptView.set(mode) },
    setCollapseTiming: (timing: CollapseTiming) => { collapseTiming.set(timing) },
    setFoldedReplies: (replies: FoldedReplies) => { foldedReplies.set(replies) },
    setNodeRenderer: (renderer: NodeRenderer) => { nodeSlotOverride = renderer },
    setImageRenderer: (renderer: ImageRenderer) => { imageSlotOverride = renderer },
    setOriginRenderer: (renderer: UserChainRenderer | undefined) => { originRenderer.set({ renderer }) },
  }
}

/** Simulate reader input (any device): a delivered position that deviates
 * from the observed-top ledger of programmatic writes. */
function readerScroll(element: HTMLElement, top: number): void {
  fireEvent.wheel(element)
  element.scrollTop = top
  fireEvent.scroll(element)
  fireEvent(element, new Event('scrollend'))
}

function installScrollMetrics(element: HTMLElement, initialHeight: number, clientHeight: number) {
  let scrollHeight = initialHeight
  let scrollTop = 0
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => clientHeight })
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => { scrollTop = Math.max(0, Math.min(value, scrollHeight - clientHeight)) },
  })
  return {
    setHeight: (value: number) => { scrollHeight = value },
    setLayout: (height: number, top: number) => {
      scrollHeight = height
      scrollTop = Math.max(0, Math.min(top, scrollHeight - clientHeight))
    },
  }
}

function formatRunDuration(ms: number, t: Parameters<typeof durationParts>[1]): string {
  return durationParts(ms, t).map(part => part.text).join('')
}

describe('Chat node rendering', () => {

  it('opens Markdown references to unmodified files with line navigation', () => {
    const h = makeHarness({
      nodes: [user(1, 'explain'), assistant(2, '[source](src/index.ts#L24-L30)', 1)],
      turnEnds: new Map([[1, 2]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    fireEvent.click(view.getByRole('button', { name: 'source' }))
    expect(h.openFile).toHaveBeenCalledWith('src/index.ts', { line: 24 })
  })

  it('threads the injected file-mention vocabulary into the closing prose only', () => {
    const wrote = (seq: number, callId: string): ToolResultNode => ({
      ...toolResult(seq, callId, 'write'),
    })
    const h = makeHarness({
      nodes: [
        user(1, 'build it'),
        assistant(2, 'writing `report.html` now', 1),
        wrote(3, 'w'),
        assistant(4, 'Wrote `report.html`; `notes.md` untouched.', 1),
      ],
      turnEnds: new Map([[1, 4]]),
    })
    h.props.fileMentions = owner => ({
      resolve: (value) => {
        if (value !== 'report.html') return undefined
        return {
          open: () => { void h.openFile(`for-seq-${String(owner.seq)}/site/report.html`) },
          label: '打开 site/report.html',
          title: 'site/report.html',
        }
      },
    })
    const view = render(<h.ChatView {...h.props} />)
    // Exactly one live mention: the closing message links, the mid-turn
    // narration stays inert code, and the unknown file resolves to nothing.
    const mentions = view.container.querySelectorAll('code button')
    expect(mentions).toHaveLength(1)
    const mention = view.getByRole('button', { name: '打开 site/report.html' })
    expect(mention.getAttribute('title')).toBe('site/report.html')
    fireEvent.click(mention)
    // The vocabulary was built from the closing message's own owner currency.
    expect(h.openFile).toHaveBeenCalledWith('for-seq-4/site/report.html')
  })

  it('formatRunDuration localizes units and floors partial seconds', () => {
    const t = makeTranslate(zh, commonZh)
    expect(formatRunDuration(0, t)).toBe('0秒')
    expect(formatRunDuration(-500, t)).toBe('0秒')
    expect(formatRunDuration(15_999, t)).toBe('15秒')
    expect(formatRunDuration(125_000, t)).toBe('2分5秒')
    // The hour rolls at exactly 3600s, never at 60 displayed minutes.
    expect(formatRunDuration(3_599_999, t)).toBe('59分59秒')
    expect(formatRunDuration(3_600_000, t)).toBe('1小时0分0秒')
    expect(formatRunDuration(3_903_000, t)).toBe('1小时5分3秒')
    expect(formatRunDuration(7_261_000, t)).toBe('2小时1分1秒')
  })

  it('formatRunDuration uses the English hour template', () => {
    const t = makeTranslate(en, commonEn)
    expect(formatRunDuration(3_903_000, t)).toBe('1h 5m 3s')
  })

})

describe('ChatView', () => {
  it('renders only referenced Nodes without deleting unreferenced Node data', () => {
    const snapshot = chatSnapshotFixture({ nodes: [user(1, 'included'), user(2, 'omitted')] })
    const h = makeHarness({}, {}, snapshot)
    const [included, omitted] = snapshot.order
    if (included === undefined || omitted === undefined) throw new Error('expected two Nodes')
    const groupStore = new ConversationGroupStore<ProcessGroupData>()
    groupStore.prepareAndInstall({
      entries: [{ kind: 'node', key: included as NodeKey }],
      groups: { kind: 'replace', snapshots: [] },
    }, id => snapshot.nodes.get(id))
    h.setGrouped(groupStore)

    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByText('included')).toBeTruthy()
    expect(view.queryByText('omitted')).toBeNull()
    expect(snapshot.nodes.get(omitted)).toBeDefined()
  })

  it('leaves the turn rail unrendered when an unrelated Chat update commits', () => {
    const snapshot = chatSnapshotFixture({
      nodes: [
        userInTurn(1, 'first prompt', 1),
        assistant(2, 'first response', 1),
        userInTurn(4, 'second prompt', 2),
        assistant(5, 'second response', 2),
      ],
      turnEnds: new Map([[1, 3], [2, 6]]),
    })
    const h = makeHarness({}, {}, snapshot)
    // The rail asks for its own accessible name once per render, so counting
    // that key counts renders without reaching into the component.
    let railRenders = 0
    const translate = h.props.t
    const counting = ((key: string, vars?: Record<string, unknown>) => {
      if (key === 'chat.turnNavigation.label') railRenders += 1
      return (translate as (k: string, v?: Record<string, unknown>) => string)(key, vars)
    }) as ChatViewSlotProps['t']
    render(<h.ChatView {...h.props} t={counting} />)
    const afterMount = railRenders
    expect(afterMount).toBeGreaterThan(0)

    act(() => { h.setTranscriptView('compact') })

    expect(railRenders).toBe(afterMount)
  })

  it('projects loaded turns into prompt and response navigation previews', async () => {
    const snapshot = chatSnapshotFixture({
      nodes: [
        userInTurn(1, 'first prompt', 1),
        assistant(2, 'first response', 1),
        userInTurn(4, 'second prompt', 2),
        assistant(5, 'second response', 2),
      ],
      turnEnds: new Map([[1, 3], [2, 6]]),
    })
    expect(snapshot.navigation.items()).toEqual([
      { turn: 1, anchorKey: 'fixture:user:1', prompt: 'first prompt', response: 'first response' },
      { turn: 2, anchorKey: 'fixture:user:4', prompt: 'second prompt', response: 'second response' },
    ])
    const h = makeHarness({}, {}, snapshot)
    const view = render(<h.ChatView {...h.props} />)
    const navigation = view.getByRole('navigation', { name: '轮次导航' })
    const first = await view.findByRole('button', { name: '跳转到第 1 轮' })
    expect(within(navigation).getAllByRole('button').map(mark => mark.getAttribute('aria-label'))).toEqual([
      '跳转到第 1 轮', '跳转到第 2 轮',
    ])
    const second = view.getByRole('button', { name: '跳转到第 2 轮' })
    expect(second.getAttribute('aria-current')).toBe('true')
    fireEvent.focus(first)
    const preview = view.getByRole('tooltip')
    expect(preview.textContent).toContain('first prompt')
    expect(preview.textContent).toContain('first response')
  })

  it('jumps to a turn anchor and reflows stable marks after an older page arrives', async () => {
    const later = [
      userInTurn(4, 'second prompt', 2), assistant(5, 'second response', 2),
      userInTurn(7, 'third prompt', 3), assistant(8, 'third response', 3),
    ]
    const h = makeHarness({ nodes: later }, { hasMore: true })
    const view = render(<h.ChatView {...h.props} />)
    const second = await view.findByRole('button', { name: '跳转到第 2 轮' })

    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    const metrics = installScrollMetrics(scroller, 1_000, 300)
    metrics.setLayout(1_000, 700)
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 300 } as DOMRect)
    const secondRow = view.container.querySelector('[data-chat-flow-key="fixture:user:4"]') as HTMLElement
    vi.spyOn(secondRow, 'getBoundingClientRect').mockReturnValue({ top: -500, bottom: -440 } as DOMRect)
    fireEvent.click(second)
    expect(scroller.scrollTop).toBe(176)
    expect(second.getAttribute('aria-current')).toBe('true')

    act(() => {
      h.setChat({
        nodes: [userInTurn(1, 'first prompt', 1), assistant(2, 'first response', 1), ...later],
        turnTimings: new Map([[1, { startTime: 1_000 }], [2, { startTime: 4_000 }], [3, { startTime: 7_000 }]]),
      })
    })
    const movedSecond = view.getByRole('button', { name: '跳转到第 2 轮' })
    expect(movedSecond).toBe(second)
    expect(within(view.getByRole('navigation')).getAllByRole('button').map(mark => mark.getAttribute('aria-label'))).toEqual([
      '跳转到第 1 轮', '跳转到第 2 轮', '跳转到第 3 轮',
    ])
  })

  it('extends the rail with unloaded outline turns, pages on click, and falls back when nothing lands', async () => {
    const later = [userInTurn(8, 'third prompt', 3), assistant(9, 'third response', 3)]
    const h = makeHarness({ nodes: later }, { hasMore: true })
    h.setOutline([
      { turn: 1, seq: 0, prompt: 'first prompt from outline', response: 'first answer from outline' },
      { turn: 2, seq: 4, prompt: 'second prompt from outline', response: '' },
      { turn: 3, seq: 8, prompt: 'third prompt', response: 'third response' },
    ])
    const view = render(<h.ChatView {...h.props} />)
    const first = await view.findByRole('button', { name: '加载并跳转到第 1 轮' })
    view.getByRole('button', { name: '加载并跳转到第 2 轮' })
    const third = view.getByRole('button', { name: '跳转到第 3 轮' })
    expect(third.getAttribute('aria-current')).toBe('true')
    fireEvent.focus(first)
    // An unloaded turn previews both sides from the outline.
    expect(view.getByRole('tooltip').textContent).toContain('first prompt from outline')
    expect(view.getByRole('tooltip').textContent).toContain('first answer from outline')

    fireEvent.click(first)
    expect(h.loadThrough).toHaveBeenCalledWith(0)
    expect(first.getAttribute('aria-busy')).toBe('true')

    // The fake loader never delivers rows: settlement repages once for the
    // unmoved head, then lands on the nearest rendered turn and un-busies.
    await waitFor(() => { expect(first.getAttribute('aria-busy')).toBeNull() })
    expect(h.loadThrough.mock.calls).toEqual([[0], [0]])
    expect(view.getByRole('button', { name: '跳转到第 3 轮' }).getAttribute('aria-current')).toBe('true')
  })

  it('uses a known turn landing without hit testing or consuming rail scroll as transcript input', async () => {
    const original = Object.getOwnPropertyDescriptor(document, 'elementsFromPoint')
    const hitTest = vi.fn((): Element[] => [])
    Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: hitTest })
    try {
      const h = makeHarness({ nodes: [
        userInTurn(1, 'first', 1), assistant(2, 'first answer', 1),
        userInTurn(4, 'second', 2), assistant(5, 'second answer', 2),
      ] })
      const view = render(<h.ChatView {...h.props} />)
      const first = await view.findByRole('button', { name: '跳转到第 1 轮' })
      const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
      installScrollMetrics(scroller, 1_500, 300)
      const row = view.container.querySelector('[data-chat-anchor-key="fixture:user:1"]') as HTMLElement
      vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 300))
      vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 100 - scroller.scrollTop, 800, 40))
      readerScroll(scroller, 600)
      scroller.scrollTop = 500
      fireEvent.scroll(scroller)
      hitTest.mockClear()

      fireEvent.click(first)
      fireEvent.scroll(scroller)
      fireEvent(scroller, new Event('scrollend'))
      const rail = view.getByRole('navigation').firstElementChild as HTMLElement
      fireEvent.scroll(rail)
      fireEvent(rail, new Event('scrollend', { bubbles: true }))

      expect(scroller.scrollTop).toBe(76)
      expect(first.getAttribute('aria-current')).toBe('true')
      expect(hitTest).not.toHaveBeenCalled()
    } finally {
      if (original === undefined) Reflect.deleteProperty(document, 'elementsFromPoint')
      else Object.defineProperty(document, 'elementsFromPoint', original)
    }
  })

  it('a jump from the pinned tail releases bottom ownership so the follow snap cannot cancel it', async () => {
    const later = [userInTurn(8, 'third prompt', 3), assistant(9, 'third response', 3)]
    const h = makeHarness({ nodes: later }, { hasMore: true })
    h.setOutline([
      { turn: 1, seq: 0, prompt: 'first prompt', response: '' },
      { turn: 3, seq: 8, prompt: 'third prompt', response: '' },
    ])
    let releaseJump: (() => void) | undefined
    h.loadThrough.mockImplementation(() => new Promise<void>((resolve) => { releaseJump = resolve }))
    const view = render(<h.ChatView {...h.props} />)
    // Pinned to the tail on open: the back-to-bottom control is absent.
    expect(view.queryByRole('button', { name: '回到底部' })).toBeNull()

    const first = await view.findByRole('button', { name: '加载并跳转到第 1 轮' })
    fireEvent.click(first)
    // The click itself leaves the tail...
    expect(view.getByRole('button', { name: '回到底部' })).toBeTruthy()
    // ...so a non-reader scroll delivery at the floor (the first prepend's
    // compensation fires one) no longer snaps to the tail and cancel the jump.
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLElement
    fireEvent.scroll(scroller)
    expect(first.getAttribute('aria-busy')).toBe('true')
    await act(async () => { releaseJump?.() })
  })

  it('holds a jump issued while a plain pull owns the pager and resumes it when the pull settles', async () => {
    const later = [userInTurn(8, 'third prompt', 3), assistant(9, 'third response', 3)]
    const h = makeHarness({ nodes: later }, { hasMore: true, loadingOlder: true })
    h.setOutline([
      { turn: 1, seq: 0, prompt: 'first prompt', response: '' },
      { turn: 3, seq: 8, prompt: 'third prompt', response: '' },
    ])
    const view = render(<h.ChatView {...h.props} />)
    const first = await view.findByRole('button', { name: '加载并跳转到第 1 轮' })
    fireEvent.click(first)
    // The session-side guard refuses the busy-pager jump instantly, yet the
    // mark stays busy instead of degrading to the nearest loaded turn.
    await act(async () => {})
    expect(h.loadThrough.mock.calls).toEqual([[0]])
    expect(first.getAttribute('aria-busy')).toBe('true')

    // The plain pull settles: the flip re-settles the jump, which repages.
    act(() => { h.setSession({ loadingOlder: false }) })
    await waitFor(() => { expect(first.getAttribute('aria-busy')).toBeNull() })
    expect(h.loadThrough.mock.calls).toEqual([[0], [0]])
  })

  it('scrolls the fixed-pitch rail inside its frame with gradient fades at the scrollable ends', async () => {
    const h = makeHarness(
      { nodes: [userInTurn(8, 'latest prompt', 60), assistant(9, 'latest response', 60)] },
      { hasMore: true },
    )
    h.setOutline(Array.from({ length: 60 }, (_, index) => ({
      turn: index + 1,
      seq: index * 4,
      prompt: `p${String(index + 1)}`,
      response: '',
    })))
    const view = render(<h.ChatView {...h.props} />)
    const nav = view.getByRole('navigation', { name: '轮次导航' })
    const scroller = nav.querySelector('[class*="scroller"]') as HTMLElement
    const latest = await within(nav).findByRole('button', { name: '跳转到第 60 轮' })
    expect(scroller.scrollTop).toBe(302)
    expect(within(nav).getAllByRole('button').length).toBeLessThan(60)
    expect(latest.getAttribute('aria-current')).toBe('true')
    scroller.scrollTop = 0
    fireEvent.scroll(scroller)
    expect(scroller.className).toContain('fadeBottom')
    expect(scroller.className).not.toContain('fadeTop')

    scroller.scrollTop = 150
    fireEvent.scroll(scroller)
    expect(scroller.className).toContain('fadeTop')
    expect(scroller.className).toContain('fadeBottom')
    fireEvent.pointerMove(within(nav).getByRole('button', { name: '加载并跳转到第 25 轮' }))
    expect(view.getByRole('tooltip').textContent).toContain('p25')
  })

  it('lands a jump on its turn once the paged rows commit', async () => {
    const later = [userInTurn(8, 'third prompt', 3), assistant(9, 'third response', 3)]
    const h = makeHarness({ nodes: later }, { hasMore: true })
    h.setOutline([
      { turn: 1, seq: 0, prompt: 'first prompt', response: '' },
      { turn: 3, seq: 8, prompt: 'third prompt', response: '' },
    ])
    let releaseJump: (() => void) | undefined
    h.loadThrough.mockImplementation(() => new Promise<void>((resolve) => { releaseJump = resolve }))
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    installScrollMetrics(scroller, 1_000, 300)
    scroller.scrollTop = 700
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.chatAnchorKey === 'fixture:user:0') {
        const top = 100 - scroller.scrollTop
        return { top, bottom: top + 40 } as DOMRect
      }
      return { top: 0, bottom: 300 } as DOMRect
    })

    fireEvent.click(await view.findByRole('button', { name: '加载并跳转到第 1 轮' }))
    expect(h.loadThrough).toHaveBeenCalledWith(0)

    // The paged window commits: turn 1's rows and rail item enter the snapshot.
    act(() => {
      h.setChat({
        nodes: [userInTurn(0, 'first prompt', 1), assistant(1, 'first response', 1), ...later],
        turnTimings: new Map([[1, { startTime: 1_000 }], [3, { startTime: 8_000 }]]),
      })
    })
    const first = view.getByRole('button', { name: '跳转到第 1 轮' })
    expect(first.getAttribute('aria-current')).toBe('true')
    expect(scroller.scrollTop).toBe(76)
    // The mark stays busy until the jump settles: the loader's completion
    // runs the final landing correction after the load-earlier button leaves.
    expect(first.getAttribute('aria-busy')).toBe('true')
    await act(async () => { releaseJump?.() })
    await waitFor(() => { expect(first.getAttribute('aria-busy')).toBeNull() })
    expect(first.getAttribute('aria-current')).toBe('true')
    expect(scroller.scrollTop).toBe(76)
  })

  it('prepend keeps the reader\'s latest pending-request scroll position anchored', () => {
    const h = makeHarness(
      { nodes: [user(9, 'first visible'), user(10, 'next visible')] },
      { hasMore: true },
    )
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    const first = view.container.querySelector('[data-chat-flow-key="fixture:user:9"]') as HTMLDivElement
    const next = view.container.querySelector('[data-chat-flow-key="fixture:user:10"]') as HTMLDivElement
    let firstTop = 100
    let nextTop = 300
    vi.spyOn(scroller, 'getBoundingClientRect').mockImplementation(
      () => ({ top: 0, bottom: 200 } as DOMRect),
    )
    vi.spyOn(first, 'getBoundingClientRect').mockImplementation(
      () => ({ top: firstTop, bottom: firstTop + 40 } as DOMRect),
    )
    vi.spyOn(next, 'getBoundingClientRect').mockImplementation(
      () => ({ top: nextTop, bottom: nextTop + 40 } as DOMRect),
    )
    Object.defineProperty(scroller, 'scrollHeight', { value: 800, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 200, writable: true })
    readerScroll(scroller, 50)
    fireEvent.click(view.getByText('加载更早'))
    act(() => { h.set({ loadingOlder: true }) })
    // The reader moves after the request starts; this, not the click-time
    // row, is the intent the arriving page must preserve.
    firstTop = -200
    nextTop = 60
    readerScroll(scroller, 90)
    Object.defineProperty(scroller, 'scrollHeight', { value: 1300, writable: true })
    nextTop = 560
    act(() => {
      h.set({ nodes: [assistant(2, 'older'), user(9, 'first visible'), user(10, 'next visible')], loadingOlder: false })
    })
    expect(scroller.scrollTop).toBe(590) // latest 90 + the anchored row's 500px prepend shift
  })

  it('bounds no-anchor hit testing before using the mounted-row fallback', () => {
    const originalHitTest = Object.getOwnPropertyDescriptor(document, 'elementsFromPoint')
    const hitTest = vi.fn((): Element[] => [])
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: hitTest,
    })
    try {
      const h = makeHarness({ nodes: [user(1, 'visible row')] })
      const view = render(<h.ChatView {...h.props} />)
      const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
      const anchor = view.container.querySelector('[data-chat-anchor-key="fixture:user:1"]') as HTMLElement
      installScrollMetrics(scroller, 4_000, 2_000)
      vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({
        top: 0, bottom: 2_000, left: 0, right: 1_000,
      } as DOMRect)
      vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
        top: 100, bottom: 140, left: 0, right: 1_000,
      } as DOMRect)

      readerScroll(scroller, 100)

      expect(hitTest).toHaveBeenCalledTimes(1)
      expect(h.chatScroll.read()?.anchorKey).toBe('fixture:user:1')
    } finally {
      if (originalHitTest !== undefined) {
        Object.defineProperty(document, 'elementsFromPoint', originalHitTest)
      } else {
        Reflect.deleteProperty(document, 'elementsFromPoint')
      }
    }
  })

  it('anchors the first transcript row for paging regardless of the viewport reading line', () => {
    const originalHitTest = Object.getOwnPropertyDescriptor(document, 'elementsFromPoint')
    const nodes = Array.from({ length: 16 }, (_, index) => user(20 + index, `row ${String(index)}`))
    const h = makeHarness(
      { nodes },
      { hasMore: true },
    )
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    const rows = [...view.container.querySelectorAll<HTMLElement>('[data-chat-flow-key]')]
    let prepended = false
    let rowRectCalls = 0
    vi.spyOn(scroller, 'getBoundingClientRect').mockImplementation(
      () => ({ top: 0, bottom: 200 } as DOMRect),
    )
    rows.forEach((row, index) => {
      vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => {
        rowRectCalls += 1
        const shift = prepended ? (index === 8 ? 400 : 500) : 0
        const top = 20 + (index - 8) * 60 + shift
        return { top, bottom: top + 40 } as DOMRect
      })
    })
    Object.defineProperty(scroller, 'scrollHeight', { value: 800, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 200, writable: true })
    readerScroll(scroller, 50)

    const hitTest = vi.fn((_x: number, _y: number): Element[] => [])
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: hitTest,
    })
    try {
      rowRectCalls = 0
      fireEvent.click(view.getByText('加载更早'))
      expect(hitTest).not.toHaveBeenCalled()
      expect(rowRectCalls).toBe(1)

      Object.defineProperty(scroller, 'scrollHeight', { value: 1_300, writable: true })
      prepended = true
      act(() => {
        h.setChat({ nodes: [assistant(2, 'older'), ...nodes] })
      })
      expect(scroller.scrollTop).toBe(550)
      expect(h.chatScroll.read()?.anchorKey).toBe('fixture:user:20')
    } finally {
      if (originalHitTest !== undefined) {
        Object.defineProperty(document, 'elementsFromPoint', originalHitTest)
      } else {
        Reflect.deleteProperty(document, 'elementsFromPoint')
      }
    }
  })

  it('updates the user-before chain without remounting message content or decorating steering', () => {
    const h = makeHarness({ nodes: [userInTurn(1, 'question', 1), steering(2, 'direction', 1)] })
    const origin = vi.fn<UserChainRenderer>((_key, owner) => <span data-test-origin="">{owner.kind}</span>)
    const empty = vi.fn<UserChainRenderer>(() => null)
    const view = render(<h.ChatView {...h.props} />)
    const userRow = view.container.querySelector<HTMLElement>('[data-chat-flow-kind="user"]')!
    const steeringRow = view.container.querySelector<HTMLElement>('[data-chat-flow-kind="steering"]')!
    expect(userRow).not.toBeNull()
    expect(steeringRow).not.toBeNull()
    const bubble = userRow.querySelector('[data-message-bubble]')
    const text = within(userRow).getByText('question').firstChild
    const copy = within(userRow).getByRole('button', { name: '复制' })
    const actions = copy.closest('[data-clock]')
    const steeringBubble = steeringRow.querySelector('[data-message-bubble]')
    const steeringText = within(steeringRow).getByText('direction').firstChild
    const steeringCopy = within(steeringRow).getByRole('button', { name: '复制' })
    expect(bubble).not.toBeNull()
    expect(text?.nodeType).toBe(Node.TEXT_NODE)
    expect(actions).not.toBeNull()
    expect(steeringBubble).not.toBeNull()
    expect(steeringText?.nodeType).toBe(Node.TEXT_NODE)
    expect(origin).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-test-origin]')).toBeNull()

    for (const renderer of [origin, empty, undefined]) {
      act(() => { h.setOriginRenderer(renderer) })

      expect(view.container.querySelector('[data-chat-flow-kind="user"]')).toBe(userRow)
      expect(userRow.querySelector('[data-message-bubble]')).toBe(bubble)
      expect(within(userRow).getByText('question').firstChild).toBe(text)
      expect(within(userRow).getByRole('button', { name: '复制' })).toBe(copy)
      expect(copy.closest('[data-clock]')).toBe(actions)
      expect(view.container.querySelector('[data-chat-flow-kind="steering"]')).toBe(steeringRow)
      expect(steeringRow.querySelector('[data-message-bubble]')).toBe(steeringBubble)
      expect(within(steeringRow).getByText('direction').firstChild).toBe(steeringText)
      expect(within(steeringRow).getByRole('button', { name: '复制' })).toBe(steeringCopy)
      expect(steeringRow.querySelector('[data-test-origin]')).toBeNull()
      const label = userRow.querySelector('[data-test-origin]')
      if (renderer === origin) {
        expect(label?.textContent).toBe('user')
        expect(label!.compareDocumentPosition(bubble!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
      } else {
        expect(label).toBeNull()
      }
    }
    expect(origin).toHaveBeenCalledExactlyOnceWith(
      'conversation.chat.user.before', { source: null, kind: 'user' }, { fallback: null },
    )
    expect(empty).toHaveBeenCalledExactlyOnceWith(
      'conversation.chat.user.before', { source: null, kind: 'user' }, { fallback: null },
    )
  })

  it('keeps pending file mentions non-interactive until admission enables the reference injector', () => {
    const pending: InboxState['next-step'][number] = {
      id: MessageId('pending-file-mention'), role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: 'Read @src/review.ts' }],
    }
    const h = makeHarness({}, { testInbox: { 'next-turn': [], 'next-step': [pending] }, running: true })
    const view = render(<h.ChatView {...h.props} />)
    const mention = view.getByText('review.ts')
    expect(mention.closest('[data-pending-steering]')).not.toBeNull()
    expect(view.queryByRole('button', { name: 'review.ts' })).toBeNull()
    fireEvent.click(mention)
    expect(h.openUserFile).not.toHaveBeenCalled()
    expect(h.openFile).not.toHaveBeenCalled()
    act(() => {
      h.setSession({ testInbox: { 'next-turn': [], 'next-step': [] } })
      h.setChat({ nodes: [{
        kind: 'steering', messageId: pending.id, seq: 1, time: 1_000,
        content: pending.content, source: pending.source,
      }] })
    })
    expect(view.container.querySelector('[data-pending-steering]')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'review.ts' }))
    expect(h.openUserFile).toHaveBeenCalledWith('src/review.ts')
    expect(h.openFile).not.toHaveBeenCalled()
  })

  it('keeps a later pending occurrence visible when it reuses a durable MessageId', () => {
    const pending = {
      id: 'steer-occurrence-later' as never,
      role: 'user' as const,
      source: { kind: 'user' as const },
      content: [{ type: 'text' as const, text: 'same steering' }],
      preview: 'same steering',
      text: 'same steering',
    }
    const h = makeHarness({
      nodes: [{
        kind: 'user', seq: 2, time: 2_000,
        content: pending.content, source: null,
      }],
    }, { testInbox: { 'next-turn': [], 'next-step': [pending] }, running: true })
    const view = render(<h.ChatView {...h.props} />)

    expect(view.getAllByText('same steering')).toHaveLength(2)
    expect(view.container.querySelectorAll('[data-pending-steering]')).toHaveLength(1)
  })

  it('renders local submission echoes at the flow tail and swaps atomically with the durable node', () => {
    const h = makeHarness(
      { nodes: [assistant(1, 'working')] },
      {
        pendingSubmissions: [
          {
            requestId: 'req-1' as never, placement: 'transcript',
            time: 5_000, text: '即发即显', attachments: [],
          },
        ],
      },
    )
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByText('即发即显').closest('[data-submission-echo]')).not.toBeNull()
    const echo = view.getByText('即发即显').closest('[data-submission-echo]')
    act(() => { h.setSession({ testInbox: { 'next-step': [], 'next-turn': [{
      id: 'idle-occurrence' as never, role: 'user', source: { kind: 'user', rpcId: 'req-1' as never },
      content: [{ type: 'text', text: '即发即显' }],
    }] } }) })
    expect(view.getByText('即发即显').closest('[data-submission-echo]')).toBe(echo)
    act(() => { h.setSession({ testInbox: { 'next-step': [], 'next-turn': [] } }) })
    expect(view.getByText('即发即显').closest('[data-submission-echo]')).toBe(echo)

    // The durable node arrives while the echo is STILL in the session
    // snapshot: the render-time rpcId dedupe keeps exactly one bubble.
    act(() => {
      h.setChat({
        nodes: [
          assistant(1, 'working'),
          {
            kind: 'user', seq: 2, time: 2_000,
            content: [{ type: 'text', text: '即发即显' }] as never,
            source: { kind: 'user', rpcId: 'req-1' },
          },
        ],
      })
    })
    expect(view.getAllByText('即发即显')).toHaveLength(1)
    expect(view.container.querySelector('[data-submission-echo]')).toBeNull()

    // The delayed snapshot retirement changes nothing visible.
    act(() => { h.setSession({ pendingSubmissions: [] }) })
    expect(view.getAllByText('即发即显')).toHaveLength(1)
  })

  it('matches echoes past an input Node whose payload carries no message source', () => {
    const base = chatSnapshotFixture({ nodes: [user(1, 'question')] })
    const snapshot = new ChatSnapshotBuilder().replace({
      nodes: [...base.nodes.values(), {
        key: 'plugin-input', id: 'plugin-input', kind: 'plugin-input', target: 'chat', anchorSeq: 2,
        location: { kind: 'session' }, visibility: 'visible', groupTree: 'input', data: null,
      }],
      timeline: base.timeline,
    })
    const h = makeHarness({}, { pendingSubmissions: [{
      requestId: 'pending' as never, placement: 'transcript', time: 1_000, text: 'pending text', attachments: [],
    }] }, snapshot)
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByText('pending text')).toBeTruthy()
    expect(view.container.querySelector('[data-submission-echo]')).not.toBeNull()
  })

  it('does not pull the reader back to the tail when a local steer becomes Host-pending', () => {
    const h = makeHarness({ nodes: [assistant(1, 'working')] }, { running: true })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement!
    installScrollMetrics(scroller, 1_000, 300)
    act(() => { h.setSession({ pendingSubmissions: [{
      requestId: 'req-steer' as never, placement: 'steering', time: 5_000, text: 'continue here', attachments: [],
    }] }) })
    expect(scroller.scrollTop).toBe(700)
    readerScroll(scroller, 100)

    act(() => { h.setSession({ testInbox: { 'next-turn': [], 'next-step': [{
      id: 'steer-occurrence' as never, role: 'user', source: { kind: 'user', rpcId: 'req-steer' as never },
      content: [{ type: 'text', text: 'continue here' }],
    }] } }) })
    expect(view.getAllByText('continue here')).toHaveLength(1)
    expect(scroller.scrollTop).toBe(100)
    expect(view.getByLabelText('回到底部')).toBeTruthy()
  })

  it.each(['compact', 'standard', 'detailed'] as const)(
    'hides an admitted local steer while its Inbox claim projection is delayed (%s)', (mode) => {
      const pending: InboxState['next-step'] = ['first', 'second'].map(text => ({
        id: text as never, role: 'user', source: { kind: 'user', rpcId: text as never },
        content: [{ type: 'text', text: `steer ${text}` }],
      }))
      const submissions: SessionSnapshot['pendingSubmissions'] = ['first', 'second'].map(text => ({
        requestId: text as never, placement: 'steering', time: 5_000,
        text: `steer ${text}`, attachments: [],
      }))
      const h = makeHarness({ nodes: [assistant(1, 'working')] }, {
        running: true, pendingSubmissions: submissions,
        testInbox: { 'next-turn': [], 'next-step': pending },
      })
      h.setTranscriptView(mode)
      const view = render(<h.ChatView {...h.props} />)
      const second = view.getByText('steer second').closest('[data-submission-echo]')
      expect(view.getAllByText('steer first')).toHaveLength(1)

      act(() => { h.setChat({ nodes: [assistant(1, 'working'), {
        ...steering(2, 'steer first', 1), source: pending[0]!.source,
      }] }) })
      expect(view.getAllByText('steer first')).toHaveLength(1)
      expect(view.getByText('steer first').closest('[data-pending-steering]')).toBeNull()
      expect(view.getByText('steer second').closest('[data-submission-echo]')).toBe(second)

      act(() => { h.setSession({ testInbox: { 'next-turn': [], 'next-step': [pending[1]!] } }) })
      act(() => { h.setSession({ pendingSubmissions: [submissions[1]!] }) })
      expect(view.getAllByText('steer first')).toHaveLength(1)
      expect(view.getByText('steer second').closest('[data-submission-echo]')).toBe(second)
    },
  )

  it('retains the same local steer bubble through Host acceptance and claim until its durable node arrives', () => {
    const h = makeHarness(
      { nodes: [assistant(1, 'working')] },
      {
        running: true,
        pendingSubmissions: [{
          requestId: 'req-steer' as never,
          placement: 'steering',
          time: 5_500,
          text: '带图纠偏',
          attachments: [{
            type: 'image', value: { previewUrl: 'blob:steer-preview', name: 'steer.png' },
          }],
        }],
      },
    )
    const view = render(<h.ChatView {...h.props} />)
    const local = view.getByText('带图纠偏').closest('[data-submission-echo]')
    expect(local?.hasAttribute('data-pending-steering')).toBe(true)

    act(() => {
      h.setSession({
        testInbox: { 'next-turn': [], 'next-step': [{
          id: 'steer-occurrence' as never,
          content: [{ type: 'text', text: '带图纠偏' }],

          role: 'user', source: { kind: 'user', rpcId: 'req-steer' as never },
        }] },
      })
    })
    expect(view.getAllByText('带图纠偏')).toHaveLength(1)
    expect(view.container.querySelector('[data-submission-echo]')).toBe(local)
    expect(view.container.querySelectorAll('[data-pending-steering]')).toHaveLength(1)

    act(() => { h.setSession({ testInbox: { 'next-turn': [], 'next-step': [] } }) })
    expect(view.container.querySelector('[data-submission-echo]')).toBe(local)
    expect(view.getAllByText('带图纠偏')).toHaveLength(1)

    act(() => { h.setChat({ nodes: [assistant(1, 'working'), {
      ...steering(2, '带图纠偏', 1), source: { kind: 'user', rpcId: 'req-steer' as never },
    }] }) })
    expect(view.getAllByText('带图纠偏')).toHaveLength(1)
    expect(view.container.querySelector('[data-submission-echo]')).toBeNull()
    act(() => { h.setSession({ pendingSubmissions: [] }) })
    expect(view.getAllByText('带图纠偏')).toHaveLength(1)
  })

  it('keeps Host Inbox order across local and other-client steering without remounting the local echo', () => {
    const h = makeHarness({ nodes: [assistant(1, 'working')] }, {
      running: true,
      pendingSubmissions: [{
        requestId: 'local-steer' as never, placement: 'steering', time: 5_000, text: 'local A', attachments: [],
      }],
    })
    const view = render(<h.ChatView {...h.props} />)
    const local = view.getByText('local A').closest('[data-submission-echo]')
    const first = {
      id: 'local-occurrence' as never, role: 'user' as const,
      source: { kind: 'user' as const, rpcId: 'local-steer' as never },
      content: [{ type: 'text' as const, text: 'local A' }],
    }
    const second = {
      id: 'remote-occurrence' as never, role: 'user' as const,
      source: { kind: 'user' as const, rpcId: 'remote-steer' as never },
      content: [{ type: 'text' as const, text: 'remote B' }],
    }
    act(() => { h.setSession({ testInbox: { 'next-turn': [], 'next-step': [first, second] } }) })
    const pendingText = () => [...view.container.querySelectorAll('[data-pending-steering]')]
      .map(element => element.textContent)
    expect(pendingText()).toEqual([expect.stringContaining('local A'), expect.stringContaining('remote B')])
    expect(view.getByText('local A').closest('[data-submission-echo]')).toBe(local)

    act(() => { h.setSession({ testInbox: { 'next-turn': [], 'next-step': [second, first] } }) })
    expect(pendingText()).toEqual([expect.stringContaining('remote B'), expect.stringContaining('local A')])
    expect(view.getByText('local A').closest('[data-submission-echo]')).toBe(local)

    act(() => { h.setSession({ pendingSubmissions: [] }) })
    expect(view.container.querySelector('[data-submission-echo]')).toBeNull()
    expect(pendingText()).toEqual([expect.stringContaining('remote B'), expect.stringContaining('local A')])
  })

  it('keeps a queued echo out of the Chat flow before and after Host admission', () => {
    const h = makeHarness(
      { nodes: [assistant(1, 'working')] },
      {
        running: true,
        pendingSubmissions: [
          {
            requestId: 'req-q' as never, placement: 'queued',
            time: 6_000, text: '排队中', attachments: [],
          },
        ],
      },
    )
    const view = render(<h.ChatView {...h.props} />)
    expect(view.queryByText('排队中')).toBeNull()
    act(() => {
      h.setSession({
        testInbox: { 'next-step': [], 'next-turn': [{
          id: 'q-occurrence' as never,
          content: [{ type: 'text' as const, text: '排队中' }],

          role: 'user', source: { kind: 'user', rpcId: 'req-q' as never },
        }] },
      })
    })
    // The queued occurrence and its local predecessor both belong to the
    // queue dock, never the Chat flow.
    expect(view.queryByText('排队中')).toBeNull()
  })

  it('an image echo renders its previews through the message-image slot', () => {
    const h = makeHarness(
      { nodes: [] },
      {
        pendingSubmissions: [{
          requestId: 'req-img' as never,
          placement: 'transcript',
          time: 7_000,
          text: '',
          attachments: [
            {
              type: 'image', value: { previewUrl: 'blob:echo-a', name: 'a.png', width: 4, height: 3 },
            },
            { type: 'image', value: { previewUrl: 'blob:echo-b' } },
          ],
        }],
      },
    )
    h.setImageRenderer(({ images, compact }) => (
      <div
        data-testid="echo-image"
        data-count={images.length}
        data-compact={String(compact)}
        data-first={JSON.stringify(images[0])}
      />
    ))
    const view = render(<h.ChatView {...h.props} />)
    const images = view.getAllByTestId('echo-image')
    expect(images).toHaveLength(2)
    expect(images.every(image => image.getAttribute('data-count') === '1')).toBe(true)
    expect(images.every(image => image.getAttribute('data-compact') === 'true')).toBe(true)
    expect(images[0]?.parentElement).toBe(images[1]?.parentElement)
    expect(JSON.parse(images[0]?.getAttribute('data-first') ?? '{}')).toEqual({
      preview: { url: 'blob:echo-a', name: 'a.png', width: 4, height: 3 },
    })
  })

  it('a mixed echo renders the Web file card between its selected images', () => {
    const h = makeHarness(
      { nodes: [] },
      {
        pendingSubmissions: [{
          requestId: 'req-mixed' as never,
          placement: 'transcript',
          time: 7_500,
          text: '',
          attachments: [
            { type: 'image', value: { previewUrl: 'blob:first', name: 'first.png' } },
            {
              type: 'file',
              value: { attachmentId: 'file-1' as never, name: 'notes.txt', bytes: 23 },
            },
            { type: 'image', value: { previewUrl: 'blob:last', name: 'last.png' } },
          ],
        }],
      },
    )
    h.setImageRenderer(({ images, compact }) => {
      const first = images[0]
      const name = first !== undefined && 'preview' in first ? first.preview.name : undefined
      return (
        <div
          data-testid={`images-${name ?? 'unknown'}`}
          data-compact={String(compact)}
        />
      )
    })
    const view = render(<h.ChatView {...h.props} />)
    const first = view.getByTestId('images-first.png')
    const file = view.getByTitle('notes.txt')
    const last = view.getByTestId('images-last.png')
    expect(first.getAttribute('data-compact')).toBe('true')
    expect(last.getAttribute('data-compact')).toBe('true')
    expect(first.parentElement).toBe(file.parentElement)
    expect(file.parentElement).toBe(last.parentElement)
    expect(first.compareDocumentPosition(file) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(file.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(view.getByText('TXT 23B')).toBeTruthy()
  })

  it('renders every terminal failure inline with neutral quota copy and no transient notice', () => {
    const h = makeHarness({ nodes: [
      user(1, 'try'), turnError(2, 'AUTH'), turnError(3), turnError(4, 'QUOTA'), turnError(5, 'ACCOUNT_QUOTA'),
      turnError(6, 'INTERRUPTED'),
    ] })
    const view = render(<h.ChatView {...h.props} />)
    const statuses = view.getAllByRole('status')
    expect(statuses.map(status => status.textContent)).toEqual([
      '本轮运行失败API 密钥无效AUTH',
      '本轮运行失败plugin exploded',
      '本轮运行失败当前请求的额度已用尽QUOTA',
      '本轮运行失败当前请求的额度已用尽ACCOUNT_QUOTA',
      '任务已停止Ondra 进程在本轮完成前退出（例如被强制结束、崩溃或关闭超时），重新启动后本轮已中止。未完成的工具调用结果未知。',
    ])
    // The transient notice is the frame-wide host's job; the failure row keeps
    // neither a recharge affordance nor a toast of its own.
    expect(view.queryByRole('alert')).toBeNull()
    expect(view.queryByRole('dialog')).toBeNull()
    expect(view.queryByRole('button', { name: '去充值' })).toBeNull()
  })

  it('renders the max-tokens notice with localized guidance, distinct from turn errors', () => {
    const h = makeHarness({ nodes: [user(1, 'try'), assistant(2, 'truncated'), turnMaxTokens(3)] })
    const view = render(<h.ChatView {...h.props} />)
    const statuses = view.getAllByRole('status')
    expect(statuses.map(status => status.textContent)).toEqual([
      '已达到输出 token 上限回答被截断，已有输出保留在对话中。发送“继续”可让模型接着输出。',
    ])
    expect(view.queryByText('本轮运行失败')).toBeNull()
  })

  it('shows assistant IconActions only on the last content message of each turn', () => {
    const h = makeHarness({
      nodes: [
        user(1, 'hi'),
        assistant(2, 'mid-turn text', 1, 1),
        toolResult(3, 'a'),
        assistant(4, 'final answer', 1, 2),
        user(5, 'next'),
        assistant(6, 'second turn', 2),
      ],
      turnEnds: new Map([[1, 4], [2, 6]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    // Branch renders only under assistant answers; user bubbles keep copy alone.
    expect(view.getAllByRole('button', { name: '复制' })).toHaveLength(4)
    const branchButtons = view.getAllByRole('button', { name: '在新对话中分支' })
    expect(branchButtons).toHaveLength(2)
    expect(branchButtons.map(button => button.getAttribute('aria-disabled'))).toEqual([null, null])
  })

  it('withholds assistant IconActions while the turn is still running', () => {
    const h = makeHarness({
      runningCalls: [runningCall('a')],
      nodes: [
        user(1, 'first'),
        assistant(2, 'previous answer', 1),
        user(4, 'second'),
        assistant(5, 'mid-turn text', 2),
      ],
      // Boundary seqs follow the log: a turn/end is strictly after its own nodes.
      turnEnds: new Map([[1, 3]]),
    }, { running: true })
    const view = render(<h.ChatView {...h.props} />)
    // 2 user + the settled turn-1 tail, which keeps its seat while a later
    // turn runs; turn 2's narration stays chrome-free while its tool runs, so
    // the footer never appears and then moves.
    expect(view.getAllByRole('button', { name: '复制' })).toHaveLength(3)
    expect(view.getByText('mid-turn text')).toBeTruthy()
    // turn/end lands: the same node becomes the settled answer and takes the seat.
    act(() => {
      h.setSession({ running: false })
      h.setChat({ runningCalls: [], turnEnds: new Map([[1, 3], [2, 6]]) })
    })
    expect(view.getAllByRole('button', { name: '复制' })).toHaveLength(4)
  })

  it('the assistant footer omits turn run time', () => {
    const h = makeHarness({
      nodes: [
        user(1, 'hi'), // time 1_000
        assistant(2, 'mid-turn text', 1, 1),
        assistant(16, 'final answer', 1, 2),
        toolResult(18, 'trailing'),
      ],
      turnTimings: new Map([[1, { startTime: 1_000, endTime: 20_000 }]]),
      turnEnds: new Map([[1, 20]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    // The exact turn/end includes trailing tool activity after the final text.
    expect(view.container.querySelector('[data-turn-tail="1"]')?.textContent).not.toContain('已完成，用时 19秒')
  })

  it('the assistant footer omits hour-scale run time', () => {
    const h = makeHarness({
      nodes: [
        user(1, 'hi'),
        assistant(2, 'mid-turn text', 1, 1),
        assistant(16, 'final answer', 1, 2),
        toolResult(18, 'trailing'),
      ],
      turnTimings: new Map([[1, { startTime: 1_000, endTime: 3_904_000 }]]),
      turnEnds: new Map([[1, 20]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.container.querySelector('[data-turn-tail="1"]')?.textContent)
      .not.toContain('已完成，用时 1小时5分3秒')
  })

  it('withholds ttft and throughput while the turn is still running', () => {
    const settled: AssistantMessageNode = {
      kind: 'assistant', seq: 2, time: 2_000, turn: 1, step: 1, blocks: [{ kind: 'text', text: 'answer' }],
      timing: { stepStartTime: 1_000, firstTokenTime: 1_500, completedTime: 2_000 },
      usage: { outputTokens: 10 },
    }
    const h = makeHarness({
      nodes: [user(1, 'hi'), settled],
      turnTimings: new Map([[1, { startTime: 1_000 }]]),
      turnEnds: new Map(),
    }, { running: true })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.queryByText(/首 token|tok\/s/)).toBeNull()
  })

  it('keeps only the latest turn tail actions permanently visible', () => {
    const h = makeHarness({
      nodes: [
        user(1, 'hi'),
        assistant(2, 'answer'),
        user(4, 'again'),
        assistant(5, 'later answer', 2),
      ],
      turnTimings: new Map([
        [1, { startTime: 1_000, endTime: 2_000 }],
        [2, { startTime: 4_000, endTime: 5_000 }],
      ]),
      turnEnds: new Map([[1, 3], [2, 6]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    const tails = view.container.querySelectorAll('[data-turn-tail]')
    expect(new Map([...tails].map(tail => [
      tail.getAttribute('data-turn-tail'), tail.getAttribute('data-actions-reveal'),
    ]))).toEqual(new Map([['1', 'hover'], ['2', 'always']]))
    expect(view.container.querySelectorAll('[data-chat-flow-kind="user"]')).toHaveLength(2)
  })

  it('the run-time label is withheld when the turn start is outside the window', () => {
    const h = makeHarness({
      nodes: [assistant(16, 'tail without trigger')],
      turnEnds: new Map([[1, 16]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.queryByText(/用时/)).toBeNull()
  })

  it('enables fork only on the finalized assistant at the completed transcript tail', () => {
    const h = makeHarness({
      nodes: [user(1, 'question'), assistant(2, 'answer')],
      turnEnds: new Map([[1, 3]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    // The user bubble offers no branch; the settled answer's is live.
    const buttons = view.getAllByRole('button', { name: '在新对话中分支' })
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(buttons[0]!)
    expect(h.forkAt.mock.calls).toEqual([[3]])
  })

  it('disables fork when the indexed Turn has a later steering Node', () => {
    const base = chatSnapshotFixture({
      nodes: [user(1, 'question'), assistant(2, 'answer')],
      turnEnds: new Map([[1, 4]]),
    })
    const later: ChatNode<'steering'> = {
      key: 'fixture:steering:3', id: '3', target: 'chat', kind: 'steering',
      anchorSeq: 3, visibility: 'visible',
      location: { kind: 'turn', turn: base.timeline.turns.get(1)! },
      data: steering(3, 'change direction', 1),
    }
    const builder = new ChatSnapshotBuilder()
    const chat = builder.replace({ nodes: [...base.nodes.values(), later], timeline: base.timeline })
    const h = makeHarness({}, {}, chat)
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByText('change direction')).toBeTruthy()
    expect(chat.locations.getTurn(1)).toContain(later.key)
    const branch = view.getByRole('button', { name: '在新对话中分支' })
    expect(branch.getAttribute('aria-disabled')).toBe('true')
    fireEvent.pointerDown(branch, { pointerType: 'touch' })
    fireEvent.click(branch)
    expect(h.forkAt).not.toHaveBeenCalled()
    expect(view.getByRole('tooltip', { hidden: true }).textContent).toBe(h.props.t('message.branchUnavailable'))
    fireEvent.pointerDown(branch, { pointerType: 'touch' })
    fireEvent.click(branch)
    expect(view.queryByRole('tooltip', { hidden: true })).toBeNull()
  })

  it('keeps final content actions but disables branch when Tool and interrupted Think follow it', () => {
    const interruptedThink: AssistantMessageNode = {
      kind: 'assistant', seq: 4.1, time: 4_100, turn: 1, step: 2,
      blocks: [{ kind: 'reasoning', text: 'bad path' }], interrupted: true,
    }
    const h = makeHarness({
      nodes: [user(1, 'question'), assistant(2, 'answer'), toolResult(3, 'a'), interruptedThink],
      turnEnds: new Map([[1, 5]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getAllByRole('button', { name: '复制' })).toHaveLength(2)
    const buttons = view.getAllByRole('button', { name: '在新对话中分支' })
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(buttons[0]!)
    expect(h.forkAt).not.toHaveBeenCalled()
  })

  it('omits the Turn Tail branch action when the Session access snapshot excludes session/fork', () => {
    const h = makeHarness({ nodes: [user(1, 'question'), assistant(2, 'answer')], turnEnds: new Map([[1, 3]]) })
    const useAccess = vi.fn((endpoint: string) => endpoint !== 'session/fork')
    // Chat Node renderers read the harness's standard props object, so the override goes there.
    Object.assign(h.props, { useAccess })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getAllByRole('button', { name: '复制' }).length).toBeGreaterThan(0)
    expect(view.queryByRole('button', { name: '在新对话中分支' })).toBeNull()
    expect(useAccess).toHaveBeenCalledWith('session/fork')
  })

  it('renders assistant Markdown across history, streaming, final, and interrupted states while user text stays literal', () => {
    const markdown = '# Rendered\n\n- **one**\n- `two`'
    const h = makeHarness({ nodes: [user(1, markdown), assistant(2, markdown)] })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.container.querySelectorAll('h1')).toHaveLength(1)
    const literal = view.getByText((_content, element) => (
      element?.tagName === 'SPAN' && element.childElementCount === 0 && element.textContent === markdown
    ))
    expect(literal.querySelector('h1')).toBeNull()

    act(() => {
      h.setChat({ partial: { turn: 2, step: 1, blocks: [{ kind: 'text', text: markdown }] } })
    })
    expect(view.container.querySelectorAll('h1')).toHaveLength(2)
    expect(view.container.querySelector('[data-streaming="true"] h1')?.textContent).toBe('Rendered')

    act(() => {
      h.setChat({
        nodes: [user(1, markdown), assistant(2, markdown), assistant(3, markdown)],
        partial: null,
      })
    })
    expect(view.container.querySelectorAll('h1')).toHaveLength(2)
    expect(view.container.querySelector('[data-streaming="true"]')).toBeNull()

    act(() => {
      h.setChat({
        nodes: [
          user(1, markdown),
          assistant(2, markdown, 1, 1),
          { ...assistant(3, markdown, 1, 2), interrupted: true },
        ],
      })
    })
    expect(view.getByText('已停止')).toBeTruthy()
    expect(view.container.querySelectorAll('h1')).toHaveLength(2)
  })

  it('prepend preserves a semantic row; a trailing user node force-scrolls', () => {
    const h = makeHarness(
      { nodes: [user(5, 'later'), assistant(6, 'a')] },
      { hasMore: true },
    )
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    // jsdom has no layout: fake the metrics the anchor math reads.
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 400, writable: true })
    const anchored = view.container.querySelector('[data-chat-flow-key="fixture:user:5"]') as HTMLDivElement
    let anchoredTop = 100
    vi.spyOn(anchored, 'getBoundingClientRect').mockImplementation(
      () => ({ top: anchoredTop, bottom: anchoredTop + 40 } as DOMRect),
    )
    readerScroll(scroller, 80)
    // Arm the paging anchor, then deliver an older page (head seq decreases).
    fireEvent.click(view.getByText('加载更早'))
    Object.defineProperty(scroller, 'scrollHeight', { value: 1600, writable: true })
    anchoredTop = 700
    act(() => {
      h.setChat({ nodes: [user(1, 'old'), assistant(2, 'b'), user(5, 'later'), assistant(6, 'a')] })
    })
    expect(scroller.scrollTop).toBe(680) // reader offset 80 + the anchored row's 600px shift
    // A new trailing user bubble (own words) force-scrolls to the bottom.
    act(() => {
      h.setChat({
        nodes: [user(1, 'old'), assistant(2, 'b'), user(5, 'later'), assistant(6, 'a'), user(9, 'mine')],
      })
    })
    expect(scroller.scrollTop).toBe(1200)
  })

  it('back-to-bottom cancels an in-flight paging anchor', () => {
    const h = makeHarness({ nodes: [user(9, 'late')] }, { hasMore: true })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 800, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 200, writable: true })
    readerScroll(scroller, 50)
    fireEvent.click(view.getByText('加载更早'))
    fireEvent.click(view.getByLabelText('回到底部'))
    Object.defineProperty(scroller, 'scrollHeight', { value: 1_300, writable: true })
    act(() => { h.setChat({ nodes: [assistant(2, 'older'), user(9, 'late')] }) })
    expect(scroller.scrollTop).toBe(1_100)
    expect(h.chatScroll.read()).toBeNull()
  })

  it('scrolling away disables follow and shows the back-to-bottom button; clicking returns', () => {
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 300, writable: true })
    readerScroll(scroller, 100) // far from bottom
    const backButton = view.getByLabelText('回到底部')
    expect(backButton).toBeTruthy()
    expect(view.container.querySelector('[data-chat-following-tail]')).toBeNull()
    // Streaming growth must NOT drag a scrolled-away reader down.
    act(() => {
      h.setChat({ partial: { turn: 1, step: 1, blocks: [{ kind: 'text', text: 'grow' }] } })
    })
    expect(scroller.scrollTop).toBe(100)
    fireEvent.click(backButton)
    expect(scroller.scrollTop).toBe(700)
    expect(view.container.querySelector('[data-chat-following-tail]')).not.toBeNull()
    // At the bottom again: follow re-arms and the button unmounts.
    expect(view.queryByLabelText('回到底部')).toBeNull()
  })

  it('keeps following when a stream-finalization shrink clamp delivers its scroll', () => {
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    const metrics = installScrollMetrics(scroller, 1_000, 300)
    scroller.scrollTop = 700
    fireEvent.scroll(scroller)

    // Stream finalization shrinks the column: the browser clamps the pinned
    // position onto the new floor and delivers a scroll event. The clamp
    // lands exactly on the ledger's floor min, so it is not reader input.
    metrics.setLayout(800, 700)
    fireEvent.scroll(scroller)
    fireEvent(scroller, new Event('scrollend'))
    expect(scroller.scrollTop).toBe(500)
    expect(view.queryByLabelText('回到底部')).toBeNull()
    expect(h.chatScroll.read()).toBeNull()

    metrics.setHeight(1_200)
    act(() => { h.setSession({ running: true }) })
    expect(scroller.scrollTop).toBe(900)
  })

  it('keeps following when a shrink clamp regrows before scrollend', () => {
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    const metrics = installScrollMetrics(scroller, 1_000, 300)
    scroller.scrollTop = 700
    fireEvent.scroll(scroller)
    fireEvent(scroller, new Event('scrollend'))

    metrics.setLayout(800, 700)
    fireEvent.scroll(scroller)
    metrics.setHeight(962)
    act(() => { h.setSession({ running: true }) })
    fireEvent(scroller, new Event('scrollend'))

    expect(scroller.scrollTop).toBe(662)
    expect(view.queryByLabelText('回到底部')).toBeNull()
    expect(h.chatScroll.read()).toBeNull()
  })

  it('settles pinned deliveries before observer growth without reading row geometry', () => {
    let notify: (() => void) | undefined
    class ResizeObserverStub {
      constructor(callback: ResizeObserverCallback) {
        notify = () => { callback([], this as unknown as ResizeObserver) }
      }

      observe = vi.fn()
      disconnect = vi.fn()
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    const metrics = installScrollMetrics(scroller, 9_931, 300)
    expect(notify).toBeDefined()
    scroller.scrollTop = 9_631
    fireEvent.scroll(scroller)
    fireEvent(scroller, new Event('scrollend'))
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    rect.mockClear()
    try {
      metrics.setLayout(9_918, 9_631)
      fireEvent.scroll(scroller)
      metrics.setHeight(10_013)
      act(() => { notify?.() })
      expect(scroller.scrollTop).toBe(9_713)
      fireEvent.scroll(scroller)
      metrics.setHeight(10_093)
      act(() => { notify?.() })
      expect(scroller.scrollTop).toBe(9_793)
      expect(rect).not.toHaveBeenCalled()
      expect(h.chatScroll.read()).toBeNull()
    } finally {
      rect.mockRestore()
    }
  })

  it('lets small reader movements accumulate past the follow threshold during growth', () => {
    let notify: (() => void) | undefined
    class ResizeObserverStub {
      constructor(callback: ResizeObserverCallback) {
        notify = () => { callback([], this as unknown as ResizeObserver) }
      }

      observe = vi.fn()
      disconnect = vi.fn()
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    const metrics = installScrollMetrics(scroller, 1_000, 300)
    expect(notify).toBeDefined()
    scroller.scrollTop = 700
    fireEvent.scroll(scroller)
    fireEvent(scroller, new Event('scrollend'))
    scroller.scrollTop = 690
    fireEvent.scroll(scroller)
    metrics.setHeight(1_020)
    act(() => { notify?.() })
    expect(scroller.scrollTop).toBe(690)
    scroller.scrollTop = 680
    fireEvent.scroll(scroller)
    fireEvent(scroller, new Event('scrollend'))
    expect(view.getByLabelText('回到底部')).toBeTruthy()
    metrics.setHeight(1_040)
    act(() => { notify?.() })
    expect(scroller.scrollTop).toBe(680)
  })

  it('keeps following when reader input reaches the floor before growth and scrollend', () => {
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    const metrics = installScrollMetrics(scroller, 1_000, 300)
    readerScroll(scroller, 100)
    expect(view.getByLabelText('回到底部')).toBeTruthy()

    scroller.scrollTop = 700
    fireEvent.scroll(scroller)
    metrics.setHeight(1_030)
    act(() => { h.setSession({ running: true }) })
    fireEvent(scroller, new Event('scrollend'))

    expect(scroller.scrollTop).toBe(730)
    expect(view.queryByLabelText('回到底部')).toBeNull()
    expect(h.chatScroll.read()).toBeNull()
  })

  it('follows a new submission immediately while an earlier scroll sample is pending', () => {
    const nodes = [user(1, 'q'), assistant(2, 'a')]
    const h = makeHarness({ nodes })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    const metrics = installScrollMetrics(scroller, 1_000, 300)
    readerScroll(scroller, 700)
    scroller.scrollTop = 650
    fireEvent.scroll(scroller)

    metrics.setHeight(1_135)
    act(() => {
      h.setSession({
        pendingSubmissions: [{
          requestId: 'req-follow' as never, placement: 'transcript',
          time: 5_000, text: 'new prompt', attachments: [],
        }],
      })
    })
    expect(scroller.scrollTop).toBe(835)

    metrics.setHeight(1_200)
    act(() => {
      h.setChat({ nodes: [...nodes, user(3, 'new prompt'), assistant(4, 'reply')] })
      h.setSession({ pendingSubmissions: [], running: true })
    })
    fireEvent(scroller, new Event('scrollend'))
    expect(scroller.scrollTop).toBe(900)
    expect(view.queryByLabelText('回到底部')).toBeNull()
    expect(h.chatScroll.read()).toBeNull()
  })

  it('clears an away sample when a back-to-bottom delivery restores pinned ownership', () => {
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    const metrics = installScrollMetrics(scroller, 1_000, 300)
    scroller.scrollTop = 700
    fireEvent.scroll(scroller)
    scroller.scrollTop = 500
    fireEvent.scroll(scroller)
    fireEvent(scroller, new Event('scrollend'))
    scroller.scrollTop = 400
    fireEvent.scroll(scroller)
    fireEvent.click(view.getByLabelText('回到底部'))
    fireEvent.scroll(scroller)
    metrics.setHeight(1_200)
    act(() => { h.setSession({ running: true }) })
    expect(scroller.scrollTop).toBe(900)
    expect(h.chatScroll.read()).toBeNull()
  })

  it('samples away-reader geometry on the interval or scrollend and cancels it on unmount', () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
      const view = render(<h.ChatView {...h.props} />)
      const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
      installScrollMetrics(scroller, 1_000, 300)
      scroller.scrollTop = 700
      fireEvent.scroll(scroller)
      scroller.scrollTop = 500
      fireEvent.scroll(scroller)
      fireEvent(scroller, new Event('scrollend'))
      expect(view.getByLabelText('回到底部')).toBeTruthy()
      const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      try {
        act(() => { vi.advanceTimersByTime(500) })
        rect.mockClear()
        scroller.scrollTop = 400
        fireEvent.scroll(scroller)
        scroller.scrollTop = 300
        fireEvent.scroll(scroller)
        act(() => { vi.advanceTimersByTime(499) })
        expect(rect).not.toHaveBeenCalled()
        act(() => { vi.advanceTimersByTime(1) })
        expect(rect).toHaveBeenCalled()
        rect.mockClear()
        scroller.scrollTop = 200
        fireEvent.scroll(scroller)
        expect(rect).not.toHaveBeenCalled()
        fireEvent(scroller, new Event('scrollend'))
        expect(rect).toHaveBeenCalled()
        scroller.scrollTop = 100
        fireEvent.scroll(scroller)
        view.unmount()
        rect.mockClear()
        act(() => { vi.advanceTimersByTime(500) })
        expect(rect).not.toHaveBeenCalled()
      } finally {
        rect.mockRestore()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the last delivered top when compositor scrolling precedes scroll delivery', () => {
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    installScrollMetrics(scroller, 1_000, 300)
    scroller.scrollTop = 700
    fireEvent.scroll(scroller)

    // Chromium advances compositor geometry before delivering the event:
    // attribution must compare against the observed-top ledger, never a
    // baseline sampled from already-moved raw geometry.
    scroller.scrollTop = 500
    fireEvent.scroll(scroller)
    fireEvent(scroller, new Event('scrollend'))
    expect(view.getByLabelText('回到底部')).toBeTruthy()
  })

  it('one ResizeObserver owns pinned dynamic-height follow and ignores growth while away', () => {
    let notify: (() => void) | undefined
    const observe = vi.fn<(element: Element) => void>()
    class ResizeObserverStub {
      constructor(callback: ResizeObserverCallback) {
        notify = () => { callback([], this as unknown as ResizeObserver) }
      }

      observe = observe
      disconnect = vi.fn()
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 1_000, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 300, writable: true })
    scroller.scrollTop = 700
    fireEvent.scroll(scroller)
    fireEvent(scroller, new Event('scrollend'))
    Object.defineProperty(scroller, 'scrollHeight', { value: 1_200, writable: true })
    act(() => { notify?.() })
    expect(scroller.scrollTop).toBe(900)
    readerScroll(scroller, 200)
    Object.defineProperty(scroller, 'scrollHeight', { value: 1_400, writable: true })
    act(() => { notify?.() })
    expect(scroller.scrollTop).toBe(200)
    expect(observe.mock.calls.map(([element]) => element)).toEqual([
      view.container.querySelector('[data-chat-flow]'), scroller,
    ])
  })

  it('pinned dynamic-height updates select the latest Turn without reading row geometry', async () => {
    let notify: (() => void) | undefined
    let nextFrame = 0
    const frames = new Map<number, FrameRequestCallback>()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      nextFrame += 1
      frames.set(nextFrame, callback)
      return nextFrame
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
    const RailObserver = ResizeObserver
    class ResizeObserverStub extends RailObserver {
      private readonly onResize: () => void

      constructor(callback: ResizeObserverCallback) {
        super(callback)
        this.onResize = () => { callback([], this) }
      }

      override observe(element: Element): void {
        super.observe(element)
        if (element.closest('nav') === null) notify = this.onResize
      }
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ top: 0, bottom: 40 } as DOMRect)
    const h = makeHarness({
      nodes: [
        userInTurn(1, 'first', 1), assistant(2, 'first answer', 1),
        userInTurn(4, 'second', 2), assistant(5, 'second answer', 2),
      ],
      turnEnds: new Map([[1, 3], [2, 6]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    await view.findByRole('button', { name: '跳转到第 2 轮' })
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    const metrics = installScrollMetrics(scroller, 1_000, 300)
    scroller.scrollTop = 700
    act(() => {
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback(0)
    })
    rect.mockClear()

    metrics.setHeight(1_200)
    act(() => { notify?.() })
    act(() => {
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback(0)
    })

    expect(scroller.scrollTop).toBe(900)
    expect(view.getByRole('button', { name: '跳转到第 2 轮' }).getAttribute('aria-current')).toBe('true')
    expect(rect).not.toHaveBeenCalled()
  })

  it('entering the at-bottom threshold does not snap the remaining scroll distance', () => {
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[data-chat-flow]')!.parentElement as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 300, writable: true })
    // Inside FOLLOW_THRESHOLD (24) but not flush with the floor — the chrome
    // re-render from setAtBottom must not force scrollTop to scrollHeight.
    readerScroll(scroller, 690) // distance-to-bottom = 10
    expect(view.queryByLabelText('回到底部')).toBeNull()
    expect(scroller.scrollTop).toBe(690)
  })

  it('under data-conversation-scroll, bottom-follow targets the host scrollport', () => {
    const host = document.createElement('div')
    host.setAttribute('data-conversation-scroll', '')
    Object.defineProperty(host, 'scrollHeight', { value: 2000, writable: true, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 500, writable: true, configurable: true })
    Object.defineProperty(host, 'scrollTop', { value: 0, writable: true, configurable: true })
    document.body.appendChild(host)
    try {
      const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
      const view = render(<h.ChatView {...h.props} />, { container: host })
      // Open jump uses the host, not the local .scroll node.
      expect(host.scrollTop).toBe(1500)
      readerScroll(host, 100)
      expect(view.getByLabelText('回到底部')).toBeTruthy()
      fireEvent.click(view.getByLabelText('回到底部'))
      expect(host.scrollTop).toBe(1500)
    } finally {
      host.remove()
    }
  })

  it('a remount restores the saved semantic row after width reflow', () => {
    const host = document.createElement('div')
    host.setAttribute('data-conversation-scroll', '')
    Object.defineProperty(host, 'scrollHeight', { value: 2000, writable: true, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 500, writable: true, configurable: true })
    Object.defineProperty(host, 'scrollTop', { value: 0, writable: true, configurable: true })
    document.body.appendChild(host)
    let anchorOffset = 180
    vi.spyOn(host, 'getBoundingClientRect').mockImplementation(
      () => ({ top: 0, bottom: 500 } as DOMRect),
    )
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.chatAnchorKey === 'fixture:user:1') {
        const anchorTop = anchorOffset - host.scrollTop
        return { top: anchorTop, bottom: anchorTop + 40 } as DOMRect
      }
      return { top: 0, bottom: 40 } as DOMRect
    })
    try {
      const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
      // Fresh open (nothing saved): the bottom jump stands.
      const view = render(<h.ChatView {...h.props} />, { container: host })
      expect(host.scrollTop).toBe(1500)
      // Reader scrolls up; the position is recorded continuously.
      readerScroll(host, 100)
      // View-tab switch away and back: the view unmounts, then remounts.
      view.rerender(<div />)
      anchorOffset = 660
      host.scrollTop = 0
      view.rerender(<h.ChatView {...h.props} />)
      expect(host.scrollTop).toBe(580)
      // The restored position is above the floor: follow stays disarmed.
      expect(view.getByLabelText('回到底部')).toBeTruthy()
    } finally {
      rect.mockRestore()
      host.remove()
    }
  })

  it('normalizes a semantic restore clamped to the bottom before an immediate remount', () => {
    const host = document.createElement('div')
    host.setAttribute('data-conversation-scroll', '')
    Object.defineProperty(host, 'scrollHeight', { value: 2_000, writable: true, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 500, writable: true, configurable: true })
    let scrollTop = 0
    Object.defineProperty(host, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = Math.min(value, 1_500) },
    })
    document.body.appendChild(host)
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.chatAnchorKey === 'fixture:user:1') {
        const top = 1_700 - host.scrollTop
        return { top, bottom: top + 40 } as DOMRect
      }
      return { top: 0, bottom: 500 } as DOMRect
    })
    try {
      const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
      h.chatScroll.save({ anchorKey: 'fixture:user:1', anchorTop: 80, scrollTop: 1_400 })
      const view = render(<h.ChatView {...h.props} />, { container: host })
      expect(host.scrollTop).toBe(1_500)
      expect(h.chatScroll.read()).toBeNull()
      view.rerender(<div />)
      host.scrollTop = 0
      view.rerender(<h.ChatView {...h.props} />)
      expect(host.scrollTop).toBe(1_500)
    } finally {
      rect.mockRestore()
      host.remove()
    }
  })

  it('a remount while pinned to the bottom keeps the bottom jump', () => {
    const host = document.createElement('div')
    host.setAttribute('data-conversation-scroll', '')
    Object.defineProperty(host, 'scrollHeight', { value: 2000, writable: true, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 500, writable: true, configurable: true })
    Object.defineProperty(host, 'scrollTop', { value: 0, writable: true, configurable: true })
    document.body.appendChild(host)
    try {
      const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
      const view = render(<h.ChatView {...h.props} />, { container: host })
      // At the bottom: the scroll event records the pinned state (null).
      fireEvent.scroll(host)
      expect(h.chatScroll.read()).toBeNull()
      view.rerender(<div />)
      host.scrollTop = 0
      view.rerender(<h.ChatView {...h.props} />)
      expect(host.scrollTop).toBe(1500)
    } finally {
      host.remove()
    }
  })

  it('paging button loads older and shows its busy label', () => {
    const h = makeHarness({ nodes: [user(5, 'later')] }, { hasMore: true })
    const view = render(<h.ChatView {...h.props} />)
    fireEvent.click(view.getByText('加载更早'))
    expect(h.loadOlder).toHaveBeenCalledTimes(1)
    act(() => { h.setSession({ loadingOlder: true }) })
    expect(view.getByText('加载中…')).toBeTruthy()
  })

  it('shows open error and loading states', () => {
    const h = makeHarness({}, {
      openState: 'error',
      openError: { code: 'gateway/internal', message: 'boom' } as never,
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByText(/历史加载失败：boom/)).toBeTruthy()
    const loading = makeHarness({}, { openState: 'loading' })
    const lv = render(<loading.ChatView {...loading.props} />)
    expect(lv.getByText('载入历史…')).toBeTruthy()
  })

  it('marks the steering row whose data carries a batch start, and no other input', () => {
    const batchStart = (seq: number, text: string) => ({ ...steering(seq, text, 1), batchStart: true as const })
    const h = makeHarness({
      nodes: [
        userInTurn(1, 'question', 1), assistant(2, 'working', 1, 1),
        batchStart(3, 'first direction'),
        steering(4, 'second direction', 1),
        assistant(5, 'answer', 1, 2),
      ],
      turnTimings: new Map([[1, { startTime: 0 }]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    const rows = [...view.container.querySelectorAll('[data-chat-steering-batch="start"]')]
      .map(element => element.closest<HTMLElement>('[data-chat-node-key]')?.dataset.chatNodeKey)
    expect(rows).toEqual(['fixture:steering:3'])
  })
})

const fileDrag = { prepare: vi.fn(async () => ({ start: () => true, release: () => {} })), reportFailure: vi.fn() }

