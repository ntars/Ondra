/**
 * The desktop pet's glyph: morphicons' `cat`, the mark of the companion herself.
 *
 * Inline for the same reason as the status pulse — the product catalog has no
 * pet glyph and widening it for one card would touch the shared artwork table.
 * The geometry is copied verbatim from
 * `morphicons/morphicons-icons/lucide/outline/cat.svg` (Lucide, ISC);
 * only the stroke is retuned, because this tile renders the glyph at 30px on a
 * 24-unit box: the source's 2 units would read as 2.5px, so 1.8 lands on the
 * 2.25px the handbook's 16→2 contract implies at this size.
 */
import type { IconProps } from '@ntars/ondra-client-ui-primitives'

/**
 * Draw the pet mark.
 * @param props - rendered height and an optional class from the caller.
 * @returns the inline svg.
 */
export function PetGlyph({ size = 26, className }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" strokeWidth={1.8}
      stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden="true">
      <path d="M12 5c.67 0 1.35.09 2 .26c1.78-2 5.03-2.84 6.42-2.26c1.4.58-.42 7-.42 7c.57 1.07 1 2.24 1 3.44C21 17.9 16.97 21 12 21s-9-3-9-7.56c0-1.25.5-2.4 1-3.44c0 0-1.89-6.42-.5-7s4.72.23 6.5 2.23A9 9 0 0 1 12 5m-4 9v.5m8-.5v.5" />
      <path d="M11.25 16.25h1.5L12 17z" />
    </svg>
  )
}
