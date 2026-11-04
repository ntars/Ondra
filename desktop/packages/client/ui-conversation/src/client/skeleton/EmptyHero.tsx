// The composer remains in ConversationRoot so switching out of the blank-draft
// phase does not remount its textarea.

import type { ReactNode } from 'react'
import { OndraLogo } from '@ntars/ondra-client-ui-primitives'
import { workspaceTitleOf } from '@ntars/ondra-util-workspace-path'
import type { ConversationContentProps } from '../contract/slots.ts'
import css from './HeroShell.module.css'

/** The owner's locale seat type, passed to hero chrome as a plain prop. */
type HeroTranslate = ConversationContentProps['t']

/**
 * Basename label for the workspace (the shared derivation); separator-only
 * paths echo the raw cwd. The hero no longer prints it — the folder chip is
 * gone — but the Conversation body still needs the name to decide whether a
 * blank session has a reachable workspace at all.
 * @param cwd - workspace directory path (non-empty).
 * @returns the folder name.
 */
export function workspaceLabel(cwd: string): string {
  const base = workspaceTitleOf(cwd)
  return base !== '' ? base : cwd
}

/** Hero chrome props. The workspace row rides the InputBar accessory hole, not here. */
export interface HeroShellProps {
  /** The owner's locale seat, passed down as a plain prop. */
  t: HeroTranslate
  /** Authorized renderer for the hero brand-mark slot. */
  renderSlot: ConversationContentProps['renderSlot']
  /** Overlay content after the stack (modals). */
  children?: ReactNode
}


/**
 * Render the hero chrome (headline only; no composer, no workspace row).
 *
 * The mark and the product name form the column's title page: they sit at the
 * TOP of the view, and the composer below owns the floor — the space between is
 * deliberately empty (见 HeroShell.module.css). The element order is unchanged;
 * only where the slack goes.
 * @param props - see {@link HeroShellProps}.
 * @returns the hero headline element tree.
 */
export function HeroShell({ t, renderSlot, children }: HeroShellProps) {
  return (
    <div className={css.root} data-hero-shell="">
      <div className={css.stack}>
        <div className={css.headline}>
          <span className={css.fishHitbox}>
            {/* The mark is 空谷's own drawing, not the platform's fish. The fish
                was a borrowed placeholder; a companion product signs its first
                screen with its own studio mark, and the studio's mark already
                carries the whale silhouette the fish was standing in for. The
                product name beside it names the application rather than
                describing a phase of work. */}
            {renderSlot('conversation.hero.brand.mark', { size: 30, className: css.fish }, {
              fallback: <OndraLogo size={30} />,
            })}
          </span>
          <span className={css.titleGroup}>
            {/* Own element: keeps the headline text addressable apart from the mark. */}
            <span>{t('hero.headline')}</span>
          </span>
        </div>
      </div>
      {children}
    </div>
  )
}
