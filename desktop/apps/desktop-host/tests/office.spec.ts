import * as NativeToolExecutor from '@ntars/ondra-tool-executor-native'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@ntars/cordis'
import Loader from '@ntars/cordis-plugin-loader'
import Include from '@ntars/cordis-plugin-include'
import AgentRegistry from '@ntars/ondra-agent'
import SystemPrompt from '@ntars/ondra-system-prompt'
import SkillRegistry from '@ntars/ondra-skill'
import ToolRuntime from '@ntars/ondra-tools'
import { expect, it, vi } from 'vitest'
import * as desktopOffice from '../src/office.ts'

it('loads Desktop Office CLI paths and removes them on disposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-office-'))
  vi.stubEnv('ONDRA_HOME', root)
  const ctx = new Context()

  try {
    const assets = join(root, 'runtime', 'office-skills')
    await cp(new URL('../../../packages/skill/skill-office/assets/', import.meta.url), assets, { recursive: true })
    const nodeDirectory = join(root, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin')
    await mkdir(nodeDirectory, { recursive: true })
    await cp(process.execPath, join(nodeDirectory, process.platform === 'win32' ? 'node.exe' : 'node'))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    expect('default' in desktopOffice).toBe(false)
    expect(ctx.loader.unwrapExports(desktopOffice)).toBe(desktopOffice)
    const modules = new Map<string, unknown>([
      ['agents', AgentRegistry], ['systemPrompt', SystemPrompt], ['tools', ToolRuntime], ['toolExecutor', NativeToolExecutor],
      ['skills', SkillRegistry], ['office', desktopOffice],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected plugin ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    const config = join(root, 'cordis.yml')
    await writeFile(config, [
      '- name: agents', '- name: systemPrompt', '- name: tools', '- name: skills', '- name: office',
      '  config:', `    source: ${JSON.stringify(join(root, 'runtime', 'primary-runtime'))}`,
      `    root: ${JSON.stringify(join(root, 'installed'))}`,
      `    runtimeDir: ${JSON.stringify(join(root, 'ondra'))}`, '',
    ].join('\n'))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['office', 'office-docx', 'office-export-pdf', 'office-pptx', 'office-recalculate', 'office-render', 'office-xlsx'])
    expect((await ctx.skills.get('office-pptx'))?.resourceBase).toEqual({ kind: 'directory', path: join(assets, 'office-pptx').split(sep).join('/') })
    expect((await ctx.skills.get('office-pptx'))?.content).toContain('office-render')
    expect((await ctx.skills.get('office-pptx'))?.content).not.toContain(nodeDirectory)
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['load_workspace_dependencies'])
    const entry = [...ctx.loader.entries()].find(entry => entry.options.name === 'office')
    expect(entry).toBeDefined()
    await entry?.fiber?.dispose()
    expect(await ctx.skills.list()).toEqual([])
    expect(ctx.tools.schemas()).toEqual([])
  } finally {
    try { await ctx.fiber.dispose() }
    finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  }
})
