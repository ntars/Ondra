// @vitest-environment jsdom
/** A page whose Peer may not list plugin bundles still boots, and the shipped client contributes no menu row. */
import { expect } from 'vitest'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'

const withoutPluginManager = createClientTest({ roster: webApp }, { access: action => action !== 'pluginManager/listBundles' })

withoutPluginManager('boots the shipped Web client without the Plugins page navigation', async ({ start }) => {
  const c = await start()
  expect(c.ctx.get('pluginNavigation')).toBeUndefined()
  // This product ships the row package disabled, so the shipped client
  // registers no More-menu namespace at all and the key falls through
  // unchanged. menu.client.spec.tsx still covers the rows as a package.
  expect(c.ctx.get('locale')!.bind('entryCustomization')('create')).toBe('create')
  // This file's only case carries the one-time cost of importing the whole
  // shipped composition, so its budget is that setup cost.
}, 180_000)
