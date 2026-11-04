/** Browser attachment plugin: composer entries and independently replaceable image galleries. */
import type { Context as ClientContext } from '@ntars/cordis'
import type {} from '@ntars/ondra-client-ui-chat/client'
import type {} from '@ntars/ondra-client-ui-conversation/client'
import type {} from '@ntars/ondra-client-ui-renderer/client'
import type {} from '@ntars/ondra-client-ui-tool/client'
import type {} from '@ntars/ondra-client-ui-trajectory/client'
import type {} from '@ntars/ondra-client-ui-file-drag/client'
import { ComposerAttachments, type ComposerAttachmentsInjected } from './ComposerAttachments.tsx'
import { MessageImages, MessageImagesContent } from './MessageImages.tsx'

/** Slot registry required by the attachment presentation plugin. */
export const inject = ['slots', 'fileDrag']

/**
 * Register composer attachments and the shared gallery with its domain adapters.
 * @param ctx - client plugin context with the Slot registry.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.registerFactory({
    name: 'conversation.images.content', scope: 'root', locale: 'conversation',
    inject: () => ({ fileDrag: ctx.fileDrag.actions }),
  }, MessageImagesContent)
  ctx.slots.inject('conversation.input.attachments', () => ctx.slots.register({
    name: 'conversation.input.attachments',
    inject: (): ComposerAttachmentsInjected => ({ readFileDrag: ctx.fileDrag.read }),
    locale: 'conversation',
  }, ComposerAttachments))
  ctx.slots.inject('conversation.chat.message.images', () => ctx.slots.register({
    name: 'conversation.chat.message.images', priority: 100,
  }, MessageImages))
  ctx.slots.inject('conversation.chat.user.images', () => ctx.slots.register({
    name: 'conversation.chat.user.images', priority: 100,
  }, MessageImages))
  ctx.slots.inject('conversation.trajectory.images', () => ctx.slots.register({
    name: 'conversation.trajectory.images', priority: 100,
  }, MessageImages))
  ctx.slots.inject('tool.call.images', () => ctx.slots.register({
    name: 'tool.call.images', priority: 100,
  }, MessageImages))
}
