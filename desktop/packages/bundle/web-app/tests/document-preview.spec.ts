/**
 * The shipped Office stack is present but closed: both the converter row and
 * the document-preview tab ship `disabled: true`, so this bundle never loads
 * LibreOffice for a preview and the right Sidebar grows no document tab. The
 * rows stay declared (rather than deleted) so a product decision can re-enable
 * them by flipping one line; this pin is what notices when someone does.
 */
import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@ntars/ondra-app-boot'
import { expect, it } from 'vitest'

it('ships the Office converter and document-preview rows disabled', () => {
  const rows = loadOverlayPatches('web-office-test', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
    .flatMap(patch => patch.insert ?? [])
    .filter(row => row.id === 'office-to-pdf' || row.id === 'ui-sidebar-documentpreview')
  expect(rows.map(row => [row.id, row.name, row.disabled])).toEqual([
    ['office-to-pdf', '@ntars/ondra-office-to-pdf', true],
    ['ui-sidebar-documentpreview', '@ntars/ondra-client-ui-sidebar-documentpreview', true],
  ])
})
