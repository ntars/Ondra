/**
 * The shipped composition collects nothing: Ondra mounts neither the Desktop
 * OTLP exporter (`desktop-product-telemetry`) nor the client collector
 * (`product-analytics`), so no usage record leaves the machine and no policy
 * watch, shutdown budget, or device-identity call can happen. Pinning the
 * absence is the tripwire — re-adding either row is a privacy decision that
 * must change this file on purpose.
 */
import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@ntars/ondra-app-boot'
import { expect, it } from 'vitest'

it('ships no product-analytics or desktop product-telemetry row', () => {
  const ids = loadOverlayPatches('analytics', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
    .flatMap(patch => patch.insert ?? [])
    .map(row => row.id)
  for (const id of ['desktop-product-telemetry', 'product-analytics']) {
    expect(ids, `${id} must stay absent: Ondra uploads no usage data`).not.toContain(id)
  }
})
