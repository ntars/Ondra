// Message footer chrome: the clock, plus the copy / branch / usage controls.
//
// Only the clock is DRAWN. By instruction a message footer shows the time and
// nothing else — a per-message toolbar competes with the text it sits under, and
// the figures beside it (branch, token spend) belong to a developer reading.
//
// WHY THE CONTROLS ARE STILL BUILT. Deleting the markup would break every caller
// and every test that exercises copy / fork, for a change that is purely about
// what is visible. They stay in the tree behind one attribute on the row —
// `data-footer='time-only'` — and a single CSS rule hides them. Turning them
// back on is then a CSS decision instead of a code transplant, and the clipboard
// and fork behaviour keeps its coverage.

import { useId, type ReactNode } from 'react'
import {
  IconBranchOutlineRegular, IconCheckOutlineRegular, IconCopyOutlineRegular, Tooltip, useClipboardCopy,
} from '@ntars/ondra-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { formatMessageClock } from './message-chrome.ts'
import { useCalendarDay } from './use-calendar-day.ts'
import css from './MessageIconActions.module.css'

export interface MessageIconActionsProps {
  /** Plain text the copy action writes. */
  text: string
  /** Unix epoch ms for the clock label; omitted for transient messages. */
  time?: number | undefined
  /** Clock before icons (user) or after (assistant). */
  clock: 'start' | 'end'
  /** Fork the session at this message; omission hides the branch action. */
  onBranch?: (() => void) | undefined
  /** The message is not a completed transcript tail, so branch stays visible but unavailable. */
  branchUnavailable?: boolean | undefined
  /** Parent layout class composed onto the actions row. */
  className?: string | undefined
  /**
   * Slot-rendered actions owned by independent plugins, placed between the
   * built-in copy and branch controls.
   */
  extraActions?: ReactNode
  /**
   * Icon-row Turn-usage trigger (the TurnUsagePanel pill), seated after the
   * branch control at the end of the icon cluster.
   */
  usageAction?: ReactNode
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps['t']
}

/**
 * Message footer row: the clock drawn, the controls mounted but hidden.
 * @param props - Copy text, event time, clock side, branch callback, className.
 * @returns The footer row element.
 */
export function MessageIconActions({
  text, time, clock, onBranch, branchUnavailable = false, className,
  extraActions, usageAction, t,
}: MessageIconActionsProps) {
  const day = useCalendarDay()
  const reasonId = useId()
  const { copied, onCopy } = useClipboardCopy(text)
  const clockEl = time === undefined ? null : (
    <span className={clock === 'start' ? css.timeStart : css.timeEnd}>
      {formatMessageClock(time, t, day)}
    </span>
  )
  return (
    <div
      className={className === undefined ? css.actions : `${css.actions} ${className}`}
      data-clock={clock}
      data-footer="time-only"
    >
      {clock === 'start' ? clockEl : null}
      <Tooltip label={copied ? t('copied') : t('copy')} side="bottom">
        <button type="button" className={css.action} aria-label={copied ? t('copied') : t('copy')} onClick={onCopy}>
          {copied ? <IconCheckOutlineRegular /> : <IconCopyOutlineRegular />}
        </button>
      </Tooltip>
      {extraActions}
      {onBranch !== undefined && (
        <Tooltip label={branchUnavailable ? t('message.branchUnavailable') : t('message.branch')} side="bottom" openOnClick={branchUnavailable}>
          {/* Native disabled buttons do not deliver the hover/focus events Tooltip needs. */}
          <button
            type="button"
            className={css.action}
            aria-label={t('message.branch')}
            aria-disabled={branchUnavailable || undefined}
            aria-describedby={branchUnavailable ? reasonId : undefined}
            data-unavailable={branchUnavailable || undefined}
            onClick={branchUnavailable ? undefined : onBranch}
          >
            <IconBranchOutlineRegular />
          </button>
        </Tooltip>
      )}
      {onBranch !== undefined && branchUnavailable && (
        <span id={reasonId} className={css.visuallyHidden}>{t('message.branchUnavailable')}</span>
      )}
      {clock === 'end'
        ? <span className={css.endInfo}>{usageAction}{clockEl}</span>
        : usageAction}
    </div>
  )
}
