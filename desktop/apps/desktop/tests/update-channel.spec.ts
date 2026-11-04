import { expect, it } from 'vitest'
import { desktopUpdateChannel } from '../src/update-channel.ts'

it('reads the installed channel independently from the current version', () => {
  expect(desktopUpdateChannel({ version: '1.0.0', ondraDesktopUpdateChannel: 'nightly' })).toBe('nightly')
  expect(desktopUpdateChannel({ version: '1.0.0', ondraDesktopUpdateChannel: 'latest' })).toBe('latest')
  expect(desktopUpdateChannel({ version: '1.0.0' })).toBe('nightly')
  expect(() => desktopUpdateChannel({ ondraDesktopUpdateChannel: 'beta' })).toThrow(/channel/u)
  expect(() => desktopUpdateChannel(null)).toThrow(/manifest/u)
})
