import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENTS_HOME_DIR_NAME,
  DEFAULT_AGENTS_HOME_DISPLAY,
  DEFAULT_ONDRA_HOME_DISPLAY,
  ONDRA_HOME_DIR_NAME,
  agentsHomeDisplay,
  canonicalizeWatchPath,
  defaultAgentsHome,
  defaultDshHome,
  dshCachePath,
  dshHomeDisplay,
  dshHomePath,
  expandHomePath,
  resolveAgentsHome,
  resolveDshHome,
} from '@deepseek-ai/dsh-home-paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('ondra path helpers', () => {
  it('owns the default Ondra home directory name', () => {
    expect(ONDRA_HOME_DIR_NAME).toBe('.ondra')
    expect(DEFAULT_ONDRA_HOME_DISPLAY).toBe('~/.ondra')
    expect(defaultDshHome()).toBe(join(homedir(), '.ondra'))
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.ondra')).toBe(join(homedir(), '.ondra'))
    expect(expandHomePath('~\\.ondra')).toBe(join(homedir(), '.ondra'))
    expect(expandHomePath('/tmp/.ondra')).toBe('/tmp/.ondra')
    expect(expandHomePath('~other/.ondra')).toBe('~other/.ondra')
  })

  it('resolves explicit path before ONDRA_HOME and the default', () => {
    const envHome = join(homedir(), 'env-ondra')

    expect(resolveDshHome('/tmp/explicit-ondra', { ONDRA_HOME: '~/env-ondra' })).toBe(resolve('/tmp/explicit-ondra'))
    expect(resolveDshHome(undefined, { ONDRA_HOME: '~/env-ondra' })).toBe(envHome)
    expect(resolveDshHome(undefined, {})).toBe(defaultDshHome())
  })

  it('ignores upstream DSH_HOME entirely', () => {
    expect(resolveDshHome(undefined, { DSH_HOME: '/tmp/upstream-dsh' })).toBe(defaultDshHome())
    expect(resolveAgentsHome(undefined, { DSH_AGENTS_HOME: '/tmp/upstream-agents' })).toBe(defaultAgentsHome())
  })

  it('treats an empty or whitespace-only ONDRA_HOME as unset', () => {
    expect(resolveDshHome(undefined, { ONDRA_HOME: '' })).toBe(defaultDshHome())
    expect(resolveDshHome(undefined, { ONDRA_HOME: '   ' })).toBe(defaultDshHome())
  })

  it('joins child segments onto the resolved Ondra home', () => {
    vi.stubEnv('ONDRA_HOME', '~/env-ondra')
    try {
      expect(dshHomePath()).toBe(join(homedir(), 'env-ondra'))
      expect(dshHomePath('storages', 'cache')).toBe(join(homedir(), 'env-ondra', 'storages', 'cache'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('labels a resolved home by whether it is the default root', () => {
    expect(dshHomeDisplay(resolve(defaultDshHome()))).toBe('~/.ondra')
    expect(dshHomeDisplay('/some/other/root')).toBe('$ONDRA_HOME')
  })

  it('nests the agents home inside the Ondra home so it is never the shared tree', () => {
    expect(AGENTS_HOME_DIR_NAME).toBe('agents')
    expect(DEFAULT_AGENTS_HOME_DISPLAY).toBe('~/.ondra/agents')
    expect(defaultAgentsHome()).toBe(join(homedir(), '.ondra', 'agents'))
    expect(defaultAgentsHome()).not.toBe(join(homedir(), '.agents'))
  })

  it('resolves an explicit agents home before ONDRA_AGENTS_HOME and the default', () => {
    const envHome = join(homedir(), 'env-agents')

    expect(resolveAgentsHome('/tmp/explicit-agents', { ONDRA_AGENTS_HOME: '~/env-agents' })).toBe(resolve('/tmp/explicit-agents'))
    expect(resolveAgentsHome(undefined, { ONDRA_AGENTS_HOME: '~/env-agents' })).toBe(envHome)
    expect(resolveAgentsHome(undefined, {})).toBe(defaultAgentsHome())
  })

  it('treats an empty or whitespace-only ONDRA_AGENTS_HOME as unset', () => {
    expect(resolveAgentsHome(undefined, { ONDRA_AGENTS_HOME: '' })).toBe(defaultAgentsHome())
    expect(resolveAgentsHome(undefined, { ONDRA_AGENTS_HOME: '   ' })).toBe(defaultAgentsHome())
  })

  it('labels a resolved agents home by whether it is the default root', () => {
    expect(agentsHomeDisplay(resolve(defaultAgentsHome()))).toBe('~/.ondra/agents')
    expect(agentsHomeDisplay('/some/other/root')).toBe('$ONDRA_AGENTS_HOME')
  })

  it.each([
    [undefined, join(homedir(), '.ondra')],
    ['', join(homedir(), '.ondra')],
    ['   ', join(homedir(), '.ondra')],
    ['~/env-ondra', join(homedir(), 'env-ondra')],
    ['./relative-ondra', resolve('./relative-ondra')],
  ] as const)('resolves cache paths with ONDRA_HOME=%j', (home, expectedHome) => {
    vi.stubEnv('ONDRA_HOME', home)
    try {
      expect(dshCachePath()).toBe(join(expectedHome, 'cache'))
      expect(dshCachePath('models', 'index.json')).toBe(join(expectedHome, 'cache', 'models', 'index.json'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('resolves configured cache homes before the environment', () => {
    vi.stubEnv('ONDRA_HOME', '~/env-ondra')
    try {
      expect(dshCachePath({ dshHome: '~/explicit-ondra' })).toBe(join(homedir(), 'explicit-ondra', 'cache'))
      expect(dshCachePath({ dshHome: './explicit-ondra' }, 'attachments', 'request-images'))
        .toBe(resolve('./explicit-ondra/cache/attachments/request-images'))
      expect(dshCachePath({}, 'attachments')).toBe(join(homedir(), 'env-ondra', 'cache', 'attachments'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-watch-path-'))
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    try {
      await mkdir(target)
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(canonicalizeWatchPath(alias)).resolves.toBe(await realpath(target))
      await expect(canonicalizeWatchPath(join(alias, 'later', 'config.yml'))).resolves.toBe(
        join(await realpath(target), 'later', 'config.yml'),
      )
      const file = join(root, 'file')
      await writeFile(file, 'not a directory')
      await expect(canonicalizeWatchPath(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
