import { Fragment, memo, useMemo } from 'react'
import { fileMediaUrl } from '@ntars/ondra-util-workspace-path'
import type { PropsRenderSlots } from '@ntars/ondra-client-ui-slots'
import type { ReactNode } from 'react'
import { JsonBlock, MarkdownText } from '@ntars/ondra-client-ui-primitives'
import type { MarkdownFileMentions, MarkdownPathImages } from '@ntars/ondra-client-ui-primitives'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../contract/slots.ts'
import type { AssistantBlock } from '../contract/snapshot.ts'
import { markdownLabels } from '../markdown-labels.ts'
import css from './AssistantMarkdown.module.css'

/**
 * Standalone fallback for image destinations (query/fragment suffixes are ignored).
 * Chat fileImages resolves decoded file references against cwd; pathImages also
 * serves this component outside that provider and accepts legacy image URL suffixes.
 * Resolve an authored absolute image path against the document's file API.
 * @param base - canonical `document.baseURI` at render time.
 * @param value - authored Markdown destination; URL escapes are decoded once.
 * @returns an absolute Web or Desktop file-API URL, or undefined for unsupported
 * protocols and non-local paths.
 */
export function localPathMediaUrl(base: string, value: string): string | undefined {
  let path: string
  try { path = decodeURIComponent(value.split(/[?#]/u)[0] ?? '') }
  catch { return undefined } // Malformed URL escapes cannot identify a file.
  return fileMediaUrl(base, path)
}

export interface AssistantMarkdownProps extends
  Pick<PropsRenderSlots<'conversation.chat.reasoning.body' | 'conversation.chat.message.images'>, 'renderSlot'>,
  Pick<ChatNodeOwnerProps, 'loadImage'> {
  /** Render only the requested business portion, preserving original block indexes. */
  groupPart?: string | undefined
  blocks: readonly AssistantBlock[]
  streaming: boolean
  /** Only finalized durable Assistant messages supply selection sources. */
  textInteractionSource?: boolean
  /** Frozen partial of an aborted turn: rendered with a stopped marker. */
  interrupted?: boolean | undefined
  /** Resolved prose file mentions for this Assistant's closing turn. */
  mentions?: MarkdownFileMentions | undefined
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps['t']
}

/**
 * Render one Assistant message's visible blocks: prose, images, and the
 * unknown-block fallback. Reasoning and tool-call blocks are machine work —
 * the run log renders them, the conversation does not — so they are skipped
 * whole rather than folded behind a disclosure.
 */
export const AssistantMarkdown = memo(function AssistantMarkdown({
  blocks, streaming, textInteractionSource = false, interrupted, loadImage, groupPart, mentions, renderSlot, t,
}: AssistantMarkdownProps) {
  // Stable per locale revision (t identity changes on switch): a fresh object
  // per render would rebuild MarkdownText's component table every chunk.
  const labels = useMemo(() => markdownLabels(t), [t])
  // MarkdownText memoizes its vocabulary; keep its identity stable across renders.
  const pathImages = useMemo<MarkdownPathImages>(() => {
    return { resolve: value => localPathMediaUrl(document.baseURI, value) }
  }, [])
  // Tool-call heads go to the run log and reasoning blocks never reach the
  // conversation, so a node made only of them would paint an empty root — skip
  // the shell unless something visible remains.
  const hasVisible = streaming
    || interrupted === true
    || blocks.some(block => block.kind !== 'tool-call' && block.kind !== 'reasoning')
  if (!hasVisible) return null
  const rendered: ReactNode[] = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block === undefined) continue
    if (groupPart === 'reasoning' && block.kind !== 'reasoning') continue
    if (groupPart === 'response' && block.kind === 'reasoning') continue
    switch (block.kind) {
      case 'text':
        rendered.push(
          <MarkdownText
            key={i}
            text={block.text}
            streaming={streaming}
            labels={labels}
            fileMentions={mentions}
            pathImages={pathImages}
            textInteractionSource={textInteractionSource}
          />,
        )
        break
      // Machine work: the run log reads it, the conversation leaves it out.
      case 'reasoning':
      case 'tool-call':
        break
      case 'image': {
        // Consecutive image blocks share one gallery so several images tile
        // into rows instead of each opening a one-image group of its own.
        // Keyed by the group's FIRST block index: a streaming append that
        // extends the group then only grows `images` instead of remounting
        // the gallery under a shifted key.
        const start = i
        const group = [block]
        while (i + 1 < blocks.length) {
          const next = blocks[i + 1]
          if (next === undefined || next.kind !== 'image') break
          group.push(next)
          i += 1
        }
        rendered.push(
          <Fragment key={start}>
            {renderSlot('conversation.chat.message.images', {
              images: group.map(({ attachment }) => ({ attachment })), loadImage, align: 'start',
            })}
          </Fragment>,
        )
        break
      }
      default:
        rendered.push(
          <JsonBlock
            key={i}
            label={t('message.unknownBlock')}
            payload={block.block}
            truncatedLabel={total => t('json.truncated', { total })}
          />,
        )
    }
  }
  return (
    <div className={css.root} data-streaming={streaming || undefined}>
      <div className={css.body}>
        {rendered}
        {interrupted && (groupPart === undefined || groupPart === 'response'
          || !blocks.some(block => block.kind !== 'reasoning' && block.kind !== 'tool-call'))
          && <span className={css.stopped}>{t('message.stopped')}</span>}
      </div>
    </div>
  )
})
