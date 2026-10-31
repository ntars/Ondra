import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultWorkspaceDirectory, validateDocumentsDirectory } from '../src/default-directory.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('fixed Workspace root', () => {
  it('always resolves inside the Ondra data root', async () => {
    const { resolveDshHome } = await import('@deepseek-ai/dsh-home-paths')
    await expect(defaultWorkspaceDirectory(undefined, new AbortController().signal, {}))
      .resolves.toBe(`${resolveDshHome()}/workspace`)
  })

  it('pins the root to the supplied home instead of the environment', async () => {
    vi.stubEnv('ONDRA_HOME', '/env/ondra')
    await expect(defaultWorkspaceDirectory(undefined, new AbortController().signal, { platform: 'linux', home: '/home/a' }))
      .resolves.toBe('/home/a/.ondra/workspace')
  })

  it('follows ONDRA_HOME when no home is pinned', async () => {
    vi.stubEnv('ONDRA_HOME', '/custom/ondra')
    await expect(defaultWorkspaceDirectory(undefined, new AbortController().signal, {}))
      .resolves.toBe('/custom/ondra/workspace')
  })

  it('ignores the upstream DSH_HOME so the two products never share a tree', async () => {
    vi.stubEnv('DSH_HOME', '/upstream/dsh')
    vi.stubEnv('ONDRA_HOME', '')
    const { defaultDshHome } = await import('@deepseek-ai/dsh-home-paths')
    await expect(defaultWorkspaceDirectory(undefined, new AbortController().signal, { platform: 'linux' }))
      .resolves.toBe(`${defaultDshHome()}/workspace`)
  })

  it('ignores the deprecated Documents argument and never shells out', async () => {
    const run = vi.fn(async () => ({ stdout: '', stderr: '' }))
    await expect(defaultWorkspaceDirectory('/documents', new AbortController().signal, { platform: 'linux', home: '/home/a', run }))
      .resolves.toBe('/home/a/.ondra/workspace')
    expect(run).not.toHaveBeenCalled()
  })

  it('propagates cancellation', async () => {
    await expect(defaultWorkspaceDirectory(undefined, AbortSignal.abort(), { platform: 'linux' })).rejects.toThrow()
  })
})

describe('validateDocumentsDirectory', () => {
  it.each(['relative', 'C:relative', '\\rooted'])('rejects a Windows path without a fully qualified root: %s', (path) => {
    expect(() => validateDocumentsDirectory(path, 'win32')).toThrow('fully qualified')
  })

  it('accepts redirected UNC Documents directories', () => {
    expect(validateDocumentsDirectory('\\\\server\\share\\Documents', 'win32')).toBe('\\\\server\\share\\Documents')
    expect(() => validateDocumentsDirectory('relative', 'linux')).toThrow('fully qualified')
  })
})
