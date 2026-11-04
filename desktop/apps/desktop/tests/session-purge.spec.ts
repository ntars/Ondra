import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { purgeSessionDirectories } from '../src/session-purge.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ondra-session-purge-'))
  roots.push(directory)
  return directory
}

/** One stored Session directory under a project directory. */
function session(sessionsRoot: string, project: string, id: string): string {
  const directory = join(sessionsRoot, project, `session-${id}`)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'header.json'), '{}')
  return directory
}

describe('purgeSessionDirectories', () => {
  it('removes only the named Session directories and leaves the project intact', async () => {
    const sessionsRoot = root()
    session(sessionsRoot, '--project-a--', 'one')
    session(sessionsRoot, '--project-a--', 'two')
    session(sessionsRoot, '--project-b--', 'one')

    expect(await purgeSessionDirectories(sessionsRoot, ['one'], { mode: 'delete' })).toEqual({ trashed: 0, removed: 2 })
    // The sibling under the same project survives — this is the whole risk of
    // a recursive delete, so it gets its own assertion.
    expect(() => session(sessionsRoot, '--project-a--', 'two')).not.toThrow()
    expect(await purgeSessionDirectories(sessionsRoot, ['two'], { mode: 'delete' })).toEqual({ trashed: 0, removed: 1 })
  })

  it('ignores ids that are not the shape the Host mints', async () => {
    const sessionsRoot = root()
    session(sessionsRoot, '--project--', 'real')
    const outside = join(sessionsRoot, '..', 'outside')
    mkdirSync(outside, { recursive: true })
    roots.push(outside)

    // A traversal attempt and a wildcard-ish id are both refused before any
    // path is built, so nothing outside the storage root can be reached.
    expect(await purgeSessionDirectories(sessionsRoot, ['../outside', '..', '*', ''], { mode: 'delete' })).toEqual({ trashed: 0, removed: 0 })
    expect(() => writeFileSync(join(outside, 'probe'), 'x')).not.toThrow()
  })

  it('treats a missing directory and an absent root as already deleted', async () => {
    expect(await purgeSessionDirectories(root(), ['unknown'], { mode: 'delete' })).toEqual({ trashed: 0, removed: 0 })
    expect(await purgeSessionDirectories(join(root(), 'never-created'), ['unknown'], { mode: 'delete' })).toEqual({ trashed: 0, removed: 0 })
  })

  it('counts each Session once even when the list repeats it', async () => {
    const sessionsRoot = root()
    session(sessionsRoot, '--project--', 'one')
    expect(await purgeSessionDirectories(sessionsRoot, ['one', 'one', 'one'], { mode: 'delete' })).toEqual({ trashed: 0, removed: 1 })
  })
})

describe('trash first', () => {
  it('reports what it trashed rather than removing, on a platform with a trash', async () => {
    const sessionsRoot = root()
    session(sessionsRoot, '--project--', 'one')
    // `darwin` in a unit test has no Finder to answer, so the trash move fails
    // and the bytes are removed — the point of the assertion is that the call
    // asks for a trash move first and reports which path it took.
    const outcome = await purgeSessionDirectories(sessionsRoot, ['one'], { mode: 'trash', platform: 'linux' })
    expect(outcome).toEqual({ trashed: 0, removed: 1 })
  })
})
