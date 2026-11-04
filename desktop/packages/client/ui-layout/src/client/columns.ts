/**
 * Fixed three-column geometry.
 *
 * Ondra locks the frame to a quarter split: the frame width is cut into four
 * equal parts, the left column takes one, the centre two and the right column
 * one. The split never changes — the side columns are neither resizable nor
 * collapsible — so this module is the single place the proportions live.
 */

/** Resolved widths for one frame. */
export interface Columns { sidebar: number; center: number; rightbar: number }

/** Left column share of the frame width (1 of 4). */
export const SIDEBAR_RATIO = 0.25
/** Right column share of the frame width (1 of 4). */
export const RIGHTBAR_RATIO = 0.25

/**
 * Solve the three column widths for one viewport frame.
 * @param viewport - available frame width in px.
 * @returns the tracks: 1/4, 2/4, 1/4. Rounding lands on the side tracks and
 *   the centre absorbs the remainder, so the three always add up exactly.
 */
export function computeColumns(viewport: number): Columns {
  const sidebar = Math.round(viewport * SIDEBAR_RATIO)
  const rightbar = Math.round(viewport * RIGHTBAR_RATIO)
  return { sidebar, center: Math.max(0, viewport - sidebar - rightbar), rightbar }
}
