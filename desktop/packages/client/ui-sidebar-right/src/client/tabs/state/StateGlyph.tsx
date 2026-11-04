/**
 * The status page's glyph: morphicons' `activity` trace.
 *
 * It is inline rather than an `IconXxx` component because the product set's
 * catalog is fixed at 97 glyphs and has no pulse line; adding one there would
 * mean editing the shared artwork table for a single chip. The path is copied
 * verbatim from `morphicons/morphicons-icons/lucide/outline/activity.svg`
 * (Lucide, ISC) with the stroke retuned to the 16px box the chip renders at:
 * the source draws 2 units on a 24-unit box, and 24→16 scaling makes that 1.33px,
 * so 1.6 units lands on the 1px the other 13px chip glyphs use.
 */
import type { IconProps } from '@ntars/ondra-client-ui-primitives'

/**
 * Draw the pulse glyph.
 * @param props - rendered height and an optional class from the caller.
 * @returns the inline svg.
 */
export function StateGlyph({ size = 14, className }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" strokeWidth={1.6}
      stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden="true">
      <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
    </svg>
  )
}
