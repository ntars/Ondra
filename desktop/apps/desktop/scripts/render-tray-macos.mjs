/**
 * Render the macOS menu-bar icon from `resources/tray-macos.svg`.
 *
 * The menu bar shows a template image: macOS paints the icon's alpha channel in
 * the bar's own foreground colour, so the vector is drawn black-on-transparent
 * and the PNGs only carry coverage. Two bitmaps are committed — 18 px for a 1x
 * bar and 36 px for 2x — because Electron resolves the `@2x` sibling of the
 * path it was given and neither should be a downscale of the other.
 *
 * Run `node scripts/render-tray-macos.mjs` in `apps/desktop` after changing the
 * vector source; the outputs are committed, so a build never needs this step.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/** Output edge lengths: 18 pt on a 1x bar, 36 px on a 2x bar. */
export const TRAY_MACOS_SIZES = [
  { file: '../resources/tray-macos.png', edge: 18 },
  { file: '../resources/tray-macos@2x.png', edge: 36 },
]

const source = fileURLToPath(new URL('../resources/tray-macos.svg', import.meta.url))
const svg = await readFile(source)

for (const { file, edge } of TRAY_MACOS_SIZES) {
  const png = await sharp(svg, { density: 72 * (edge / 18) })
    .resize(edge, edge, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer()
  await writeFile(fileURLToPath(new URL(file, import.meta.url)), png)
  console.log(`tray-macos: wrote ${file} at ${edge}x${edge}`)
}
