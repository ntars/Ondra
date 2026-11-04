/**
 * Drop the Chromium locale bundles this product never shows.
 *
 * Electron ships ~220 `.lproj` directories per app — every language Chromium's
 * UI has ever been translated into, at roughly 200 KB each. The product declares
 * eight languages (see `CFBundleLocalizations` in the packaging config), so the
 * other two hundred are bytes no user can ever reach: no UI string, no context
 * menu, no dialog picks them up.
 *
 * Removing them is safe because Chromium falls back to `en` for a locale it has
 * no bundle for, and the retained set covers every locale the product ships.
 */
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Locales kept in the bundle: the eight the product declares, their regional
 * variants that macOS may request, and Chromium's own `en` fallback.
 */
export const RETAINED_LOCALES = Object.freeze([
  'en', 'en_GB', 'de', 'es', 'fr', 'ja', 'pt', 'pt_BR', 'ru', 'zh_CN', 'zh_TW',
])

/**
 * Remove every locale bundle outside the retained set.
 * @param resourcesDirectory - The `Resources` directory holding `*.lproj`.
 * @param retained - Locale names to keep; defaults to {@link RETAINED_LOCALES}.
 * @returns the removed bundle names, for the packaging log.
 */
export function pruneElectronLocales(
  resourcesDirectory, retained = RETAINED_LOCALES,
) {
  const keep = new Set(retained)
  const removed = []
  for (const entry of readdirSync(resourcesDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.lproj')) continue
    const locale = entry.name.slice(0, -'.lproj'.length)
    if (keep.has(locale)) continue
    rmSync(join(resourcesDirectory, entry.name), { recursive: true, force: true })
    removed.push(entry.name)
  }
  return removed
}
