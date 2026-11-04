#!/usr/bin/env node

import { Context } from '@ntars/cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@ntars/cordis-plugin-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@ntars/cordis-plugin-include',
  config: {
    path: './cordis.yml',
  },
})
