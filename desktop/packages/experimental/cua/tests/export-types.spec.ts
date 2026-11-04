/** CUA's public types distinguish object consumers from its generated permission transport. */
import { expect, expectTypeOf, it } from 'vitest'
import { Context } from '@ntars/cordis'
import * as Cua from '../src/index.ts'
import type { CuaApi } from '@ntars/ondra-cua/api'
import type { CuaApplicationState } from '@ntars/ondra-cua/types'
// @ts-expect-error Permission payloads are not part of the platform-provider root entry.
import type { CuaSystemPermissionState as RemovedRoot } from '@ntars/ondra-cua'
// @ts-expect-error The object API does not expose permission-page state.
import type { CuaSystemPermissionState as RemovedApi } from '@ntars/ondra-cua/api'
// @ts-expect-error Object interfaces use /api; /types is the generated Remote type entry.
import type { CuaApi as RemovedTypes } from '@ntars/ondra-cua/types'
// @ts-expect-error The nested grant structure is internal, not an independently exported type.
import type { CuaApplicationGrant as RemovedGrant } from '@ntars/ondra-cua/types'

it('keeps application operations and the necessary Remote payload types available', () => {
  expectTypeOf<CuaApi>().toHaveProperty('getApp')
  expectTypeOf<CuaApplicationState>().toHaveProperty('allowedApps')
  expectTypeOf<[RemovedRoot, RemovedApi, RemovedTypes, RemovedGrant]>().toBeArray()
})

it('mounts the Host marker without installing native or browser services', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Cua)
    expect(ctx.get('cuaAccess')).toBeUndefined()
    expect(ctx.get('computerUse')).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
})
