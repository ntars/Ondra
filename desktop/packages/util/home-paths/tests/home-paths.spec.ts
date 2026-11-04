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
  defaultOndraHome,
  ondraCachePath,
  ondraHomeDisplay,
  ondraHomePath,
  expandHomePath,
  resolveAgentsHome,
  resolveOndraHome,
} from '@ntars/ondra-home-paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('ondra path helpers', () => {
  it('owns the default Ondra home directory name', () => {
    expect(ONDRA_HOME_DIR_NAME).toBe('.ondra')
    expect(DEFAULT_ONDRA_HOME_DISPLAY).toBe('~/.ondra')
    expect(defaultOndraHome()).toBe(join(homedir(), '.ondra'))
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

    expect(resolveOndraHome('/tmp/explicit-ondra', { ONDRA_HOME: '~/env-ondra' })).toBe(resolve('/tmp/explicit-ondra'))
    expect(resolveOndraHome(undefined, { ONDRA_HOME: '~/env-ondra' })).toBe(envHome)
    expect(resolveOndraHome(undefined, {})).toBe(defaultOndraHome())
  })

  it('ignores upstream ONDRA_HOME entirely', () => {
    expect(resolveOndraHome(undefined, { ONDRA_HOME: '/tmp/upstream-ondra' })).toBe(defaultOndraHome())
    expect(resolveAgentsHome(undefined, { ONDRA_AGENTS_HOME: '/tmp/upstream-agents' })).toBe(defaultAgentsHome())
  })

  it('treats an empty or whitespace-only ONDRA_HOME as unset', () => {
    expect(resolveOndraHome(undefined, { ONDRA_HOME: '' })).toBe(defaultOndraHome())
    expect(resolveOndraHome(undefined, { ONDRA_HOME: '   ' })).toBe(defaultOndraHome())
  })

  it('joins child segments onto the resolved Ondra home', () => {
    vi.stubEnv('ONDRA_HOME', '~/env-ondra')
    try {
      expect(ondraHomePath()).toBe(join(homedir(), 'env-ondra'))
      expect(ondraHomePath('storages', 'cache')).toBe(join(homedir(), 'env-ondra', 'storages', 'cache'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('labels a resolved home by whether it is the default root', () => {
    expect(ondraHomeDisplay(resolve(defaultOndraHome()))).toBe('~/.ondra')
    expect(ondraHomeDisplay('/some/other/root')).toBe('$ONDRA_HOME')
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
      expect(ondraCachePath()).toBe(join(expectedHome, 'cache'))
      expect(ondraCachePath('models', 'index.json')).toBe(join(expectedHome, 'cache', 'models', 'index.json'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('resolves configured cache homes before the environment', () => {
    vi.stubEnv('ONDRA_HOME', '~/env-ondra')
    try {
      expect(ondraCachePath({ ondraHome: '~/explicit-ondra' })).toBe(join(homedir(), 'explicit-ondra', 'cache'))
      expect(ondraCachePath({ ondraHome: './explicit-ondra' }, 'attachments', 'request-images'))
        .toBe(resolve('./explicit-ondra/cache/attachments/request-images'))
      expect(ondraCachePath({}, 'attachments')).toBe(join(homedir(), 'env-ondra', 'cache', 'attachments'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ondra-watch-path-'))
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
