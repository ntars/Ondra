/**
 * The identity, timestamp, link, mutation, and durability-sink guarantees
 * MemoryVfs owes its consumers, asserted directly rather than through the
 * `node:fs` bridge.
 *
 * `ondra-fs-local` builds a version token from `dev:ino:size:mtimeNs:ctimeNs` and
 * refuses a write whose token moved since it read. Two properties carry that:
 * `ino` identifies the entry at a path, and `mtimeMs` moves on every write. The
 * timestamp cases freeze the clock, because these writes are in memory and two
 * revisions routinely land in the same millisecond — a real-clock test passes
 * whether or not the strict increment exists.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import type { VfsBigIntStats, VfsMutation, VfsMutationSink, VfsStats } from '../../src/storage/types.ts'

const identity = (vfs: MemoryVfs, path: string): bigint =>
  (vfs.statSync(path, { bigint: true }) as VfsBigIntStats).ino

const linkCount = (vfs: MemoryVfs, path: string): bigint =>
  (vfs.statSync(path, { bigint: true }) as VfsBigIntStats).nlink

const modified = (vfs: MemoryVfs, path: string): number => (vfs.statSync(path) as VfsStats).mtimeMs

afterEach(() => { vi.restoreAllMocks() })

describe('entry identity', () => {
  it('distinguishes paths and holds each identity across repeated stats', () => {
    const vfs = new MemoryVfs()
    vfs.seed('.ondra/one.txt', 'one')
    vfs.seed('.ondra/two.txt', 'two')
    const first = identity(vfs, '.ondra/one.txt')
    expect(identity(vfs, '.ondra/two.txt')).not.toBe(first)
    expect(identity(vfs, '.ondra/one.txt')).toBe(first)
  })

  it('forgets the identities under a directory removed as a subtree', () => {
    const vfs = new MemoryVfs()
    vfs.seed('.ondra/skills/git/SKILL.md', '# git\n')
    const before = identity(vfs, '.ondra/skills/git/SKILL.md')
    vfs.rmSync('.ondra/skills', { recursive: true })
    vfs.seed('.ondra/skills/git/SKILL.md', '# git rebuilt\n')
    expect(identity(vfs, '.ondra/skills/git/SKILL.md')).not.toBe(before)
  })

  it('moves the source identity when a file replaces another path', () => {
    const vfs = new MemoryVfs()
    vfs.seed('.ondra/from.txt', 'moved')
    vfs.seed('.ondra/to.txt', 'replaced')
    const [source, destination] = [identity(vfs, '.ondra/from.txt'), identity(vfs, '.ondra/to.txt')]
    vfs.renameSync('.ondra/from.txt', '.ondra/to.txt')
    const renamed = identity(vfs, '.ondra/to.txt')
    expect(vfs.readFileSync('.ondra/to.txt', 'utf8')).toBe('moved')
    expect([renamed === source, renamed === destination]).toEqual([true, false])
  })
})

describe('modification time', () => {
  it('hydrates explicit metadata without confusing timestamps with permission bits', () => {
    const vfs = new MemoryVfs()
    vfs.seed('.ondra/restored', 'value', { mode: 0o600, mtimeMs: 1_600_000_000_000 })
    vfs.seedDirectory('.ondra/restored-directory', { mode: 0o700, mtimeMs: 1_600_000_000_001 })
    const stats = vfs.statSync('.ondra/restored') as VfsStats
    const directory = vfs.statSync('.ondra/restored-directory') as VfsStats
    expect([stats.mode & 0o777, stats.mtimeMs]).toEqual([0o600, 1_600_000_000_000])
    expect([directory.mode & 0o777, directory.mtimeMs]).toEqual([0o700, 1_600_000_000_001])
  })

  it('advances on every write even while the clock stands still', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const vfs = new MemoryVfs()
    vfs.seed('.ondra/log.jsonl', 'first\n')
    const seeded = modified(vfs, '.ondra/log.jsonl')
    vfs.writeFileSync('.ondra/log.jsonl', 'second\n')
    const written = modified(vfs, '.ondra/log.jsonl')
    vfs.appendFileSync('.ondra/log.jsonl', 'third\n')
    const appended = modified(vfs, '.ondra/log.jsonl')
    vfs.truncateSync('.ondra/log.jsonl', 6)
    const truncated = modified(vfs, '.ondra/log.jsonl')
    expect([written > seeded, appended > written, truncated > appended]).toEqual([true, true, true])
    // One millisecond per revision: the increment is the minimum that separates
    // two tokens, not a coarser bump that would skew a real timestamp.
    expect(truncated - seeded).toBe(3)
  })

  it('takes the clock once the clock has passed the entry', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const vfs = new MemoryVfs()
    vfs.seed('.ondra/log.jsonl', 'first\n')
    clock.mockReturnValue(1_700_000_005_000)
    vfs.writeFileSync('.ondra/log.jsonl', 'second\n')
    expect(modified(vfs, '.ondra/log.jsonl')).toBe(1_700_000_005_000)
  })

  it('extends truncation with zero bytes', async () => {
    const vfs = new MemoryVfs()
    vfs.seed('.ondra/file', new Uint8Array([1, 2]))
    vfs.truncateSync('.ondra/file', 5)
    expect([...vfs.readFileSync('.ondra/file') as Uint8Array]).toEqual([1, 2, 0, 0, 0])
    const handle = vfs.open('.ondra/file', 'r+')
    await handle.truncate(7)
    expect([...vfs.readFileSync('.ondra/file') as Uint8Array]).toEqual([1, 2, 0, 0, 0, 0, 0])
  })

  it('advances a directory only when its immediate entry set changes', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const vfs = new MemoryVfs()
    vfs.seedDirectory('.ondra/workspace')
    const empty = modified(vfs, '.ondra/workspace')
    vfs.writeFileSync('.ondra/workspace/file.txt', 'one')
    const created = modified(vfs, '.ondra/workspace')
    vfs.writeFileSync('.ondra/workspace/file.txt', 'two')
    const rewritten = modified(vfs, '.ondra/workspace')
    vfs.rmSync('.ondra/workspace/file.txt')
    const removed = modified(vfs, '.ondra/workspace')
    expect([created > empty, rewritten === created, removed > rewritten]).toEqual([true, true, true])
  })
})

describe('mutation publication', () => {
  it('publishes only committed runtime changes and keeps image seeding silent', () => {
    const vfs = new MemoryVfs()
    const mutations: VfsMutation[] = []
    vfs.subscribe((mutation) => { mutations.push(mutation) })
    vfs.seed('.ondra/seeded.txt', 'seeded')
    expect(mutations).toEqual([])
    vfs.writeFileSync('.ondra/seeded.txt', 'changed')
    vfs.mkdirSync('.ondra/created')
    vfs.chmodSync('.ondra/created', 0o700)
    vfs.renameSync('.ondra/seeded.txt', '.ondra/renamed.txt')
    vfs.rmSync('.ondra/created', { recursive: true })
    expect(mutations.map(mutation => ({
      kind: mutation.kind,
      path: mutation.path,
      ...mutation.kind === 'write' ? { entryChanged: mutation.entryChanged } : {},
      ...mutation.kind === 'chmod' ? { mode: mutation.mode } : {},
    }))).toEqual([
      { kind: 'write', path: '.ondra/seeded.txt', entryChanged: false },
      { kind: 'mkdir', path: '.ondra/created' },
      { kind: 'chmod', path: '.ondra/created', mode: 0o700 },
      { kind: 'remove', path: '.ondra/seeded.txt' },
      { kind: 'write', path: '.ondra/renamed.txt', entryChanged: true },
      { kind: 'remove', path: '.ondra/created' },
    ])
    const renamed = mutations[4]
    expect(renamed?.kind === 'write' && new TextDecoder().decode(renamed.bytes)).toBe('changed')
    expect(() => { vfs.writeFileSync('/missing/file', 'no') }).toThrow(/ENOENT/)
    expect(mutations).toHaveLength(6)
  })

  it('contains a faulty observer and lets disposal stop later notifications', () => {
    const vfs = new MemoryVfs()
    vfs.seedDirectory('/ondra')
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = vfs.subscribe(() => { throw new Error('observer failed') })
    const seen: string[] = []
    const second = vfs.subscribe((mutation) => { seen.push(mutation.path) })
    vfs.writeFileSync('.ondra/one', '1')
    first()
    second()
    vfs.writeFileSync('.ondra/two', '2')
    expect(seen).toEqual(['.ondra/one'])
    expect(reported).toHaveBeenCalledOnce()
  })

  it('feeds the same complete mutations to a durable sink and live subscribers', async () => {
    const recorded: VfsMutation[] = []
    let flushes = 0
    const sink: VfsMutationSink = {
      record: (mutation) => { recorded.push(mutation) },
      flush: async () => { flushes += 1 },
    }
    const vfs = new MemoryVfs({ sink })
    vfs.seedDirectory('/ondra')
    const observed: VfsMutation[] = []
    vfs.subscribe((mutation) => { observed.push(mutation) })
    vfs.writeFileSync('.ondra/log', 'a')
    vfs.appendFileSync('.ondra/log', 'bc')
    await vfs.flush()
    expect(observed).toEqual(recorded)
    expect(observed[0]).toBe(recorded[0])
    expect(recorded[0]).toMatchObject({ kind: 'write', path: '.ondra/log', mode: 0o644, entryChanged: true })
    expect(recorded[1]).toMatchObject({ kind: 'write', path: '.ondra/log', mode: 0o644, entryChanged: false, appendedFrom: 1 })
    expect(recorded[1]?.kind === 'write' && new TextDecoder().decode(recorded[1].bytes)).toBe('abc')
    expect(flushes).toBe(1)
  })

  it('publishes descriptor writes at the file identity current path', () => {
    const mutations: VfsMutation[] = []
    const vfs = new MemoryVfs()
    vfs.seed('.ondra/source', 'old')
    const descriptor = vfs.openFileSync('.ondra/source', 'r+')
    vfs.subscribe((mutation) => { mutations.push(mutation) })
    vfs.renameSync('.ondra/source', '.ondra/destination')
    mutations.length = 0
    descriptor.write(0, new TextEncoder().encode('new'))
    expect(mutations.map(mutation => mutation.path)).toEqual(['.ondra/destination'])
    expect(vfs.readFileSync('.ondra/destination', 'utf8')).toBe('new')
    vfs.unlinkSync('.ondra/destination')
    mutations.length = 0
    descriptor.write(0, new TextEncoder().encode('detached'))
    expect(mutations).toEqual([])
    expect(new TextDecoder().decode(descriptor.read(0, descriptor.stat().size))).toBe('detached')
  })

  it('reports the path identity through a BigInt file handle stat', async () => {
    const vfs = new MemoryVfs()
    vfs.seed('.ondra/session.lock', '')
    const handle = vfs.open('.ondra/session.lock', 'w')
    const held = await handle.stat({ bigint: true }) as VfsBigIntStats
    const current = vfs.statSync('.ondra/session.lock', { bigint: true }) as VfsBigIntStats

    expect([held.dev, held.ino]).toEqual([current.dev, current.ino])
    await handle.chmod(0o600)
    expect((vfs.statSync('.ondra/session.lock') as VfsStats).mode & 0o777).toBe(0o600)
    await handle.close()
  })

  it('decomposes a directory rename into replayable destination state', () => {
    const recorded: VfsMutation[] = []
    const vfs = new MemoryVfs({
      sink: { record: (mutation) => { recorded.push(mutation) }, flush: () => Promise.resolve() },
    })
    vfs.seedDirectory('.ondra/staging/nested', { mode: 0o700 })
    vfs.seed('.ondra/staging/nested/file', 'value', { mode: 0o600 })
    vfs.renameSync('.ondra/staging', '.ondra/published')

    expect(recorded.map(mutation => [mutation.kind, mutation.path])).toEqual([
      ['remove', '.ondra/staging'],
      ['mkdir', '.ondra/published'],
      ['mkdir', '.ondra/published/nested'],
      ['write', '.ondra/published/nested/file'],
    ])
    expect(recorded[3]).toMatchObject({ kind: 'write', mode: 0o600, entryChanged: true })
    expect(recorded[3]?.kind === 'write' && new TextDecoder().decode(recorded[3].bytes)).toBe('value')
  })
})

describe('directory rename', () => {
  it('rejects file, non-empty directory, and missing-parent destinations before mutation', () => {
    const vfs = new MemoryVfs()
    vfs.seed('.ondra/source/nested/file', 'source')
    vfs.seed('.ondra/file', 'destination')
    vfs.seed('.ondra/non-empty/child', 'destination')
    const mutations: VfsMutation[] = []
    vfs.subscribe((mutation) => { mutations.push(mutation) })

    expect(() => { vfs.renameSync('.ondra/source', '.ondra/file') })
      .toThrow(expect.objectContaining({ code: 'ENOTDIR' }))
    expect(() => { vfs.renameSync('.ondra/source', '.ondra/non-empty') })
      .toThrow(expect.objectContaining({ code: 'ENOTEMPTY' }))
    expect(() => { vfs.renameSync('.ondra/source', '/missing/destination') })
      .toThrow(expect.objectContaining({ code: 'ENOENT' }))

    expect(vfs.readFileSync('.ondra/source/nested/file', 'utf8')).toBe('source')
    expect(vfs.readFileSync('.ondra/file', 'utf8')).toBe('destination')
    expect(vfs.readFileSync('.ondra/non-empty/child', 'utf8')).toBe('destination')
    expect(mutations).toEqual([])
  })

  it('replaces an empty directory with the source subtree', () => {
    const vfs = new MemoryVfs()
    vfs.seedDirectory('.ondra/source/nested', { mode: 0o700 })
    vfs.seed('.ondra/source/nested/file', 'source')
    vfs.seedDirectory('.ondra/destination', { mode: 0o711 })

    vfs.renameSync('.ondra/source', '.ondra/destination')

    expect(vfs.existsSync('.ondra/source')).toBe(false)
    expect(vfs.readFileSync('.ondra/destination/nested/file', 'utf8')).toBe('source')
    expect((vfs.statSync('.ondra/destination') as VfsStats).mode & 0o777).toBe(0o755)
    expect((vfs.statSync('.ondra/destination/nested') as VfsStats).mode & 0o777).toBe(0o700)
  })
})

describe('hard links', () => {
  it('shares identity, bytes, and mode until one name is removed', () => {
    const vfs = new MemoryVfs()
    vfs.seed('.ondra/session.jsonl', 'committed\n')
    vfs.linkSync('.ondra/session.jsonl', '.ondra/session-latest.jsonl')
    vfs.linkSync('.ondra/session-latest.jsonl', '.ondra/session-archive.jsonl')
    expect(identity(vfs, '.ondra/session-latest.jsonl')).toBe(identity(vfs, '.ondra/session.jsonl'))
    expect(linkCount(vfs, '.ondra/session.jsonl')).toBe(3n)
    expect(vfs.readFileSync('.ondra/session-latest.jsonl', 'utf8')).toBe('committed\n')
    const changedPaths: string[] = []
    vfs.subscribe((mutation) => { changedPaths.push(mutation.path) })
    vfs.appendFileSync('.ondra/session.jsonl', 'appended\n')
    expect(changedPaths).toEqual([
      '.ondra/session.jsonl',
      '.ondra/session-latest.jsonl',
      '.ondra/session-archive.jsonl',
    ])
    expect(vfs.readFileSync('.ondra/session.jsonl', 'utf8')).toBe('committed\nappended\n')
    expect(vfs.readFileSync('.ondra/session-latest.jsonl', 'utf8')).toBe('committed\nappended\n')
    vfs.chmodSync('.ondra/session-latest.jsonl', 0o600)
    expect((vfs.statSync('.ondra/session.jsonl') as VfsStats).mode & 0o777).toBe(0o600)
    vfs.unlinkSync('.ondra/session-latest.jsonl')
    expect(linkCount(vfs, '.ondra/session.jsonl')).toBe(2n)
    vfs.unlinkSync('.ondra/session-archive.jsonl')
    expect(linkCount(vfs, '.ondra/session.jsonl')).toBe(1n)
    expect(vfs.readFileSync('.ondra/session.jsonl', 'utf8')).toBe('committed\nappended\n')
  })

  it('treats rename between names of the same node as a no-op', () => {
    const vfs = new MemoryVfs()
    vfs.seed('.ondra/source', 'value')
    vfs.linkSync('.ondra/source', '.ondra/alias')
    const mutations: VfsMutation[] = []
    vfs.subscribe((mutation) => { mutations.push(mutation) })

    vfs.renameSync('.ondra/source', '.ondra/alias')

    expect(vfs.readFileSync('.ondra/source', 'utf8')).toBe('value')
    expect(vfs.readFileSync('.ondra/alias', 'utf8')).toBe('value')
    expect(linkCount(vfs, '.ondra/source')).toBe(2n)
    expect(mutations).toEqual([])
  })

  it('retargets linked names through file replacement and directory moves', () => {
    const vfs = new MemoryVfs()
    vfs.seed('.ondra/replacement', 'replacement')
    vfs.seed('.ondra/target', 'old')
    vfs.linkSync('.ondra/target', '.ondra/target-alias')
    const replaced = vfs.openFileSync('.ondra/target', 'r+')
    vfs.renameSync('.ondra/replacement', '.ondra/target')
    const mutations: VfsMutation[] = []
    vfs.subscribe((mutation) => { mutations.push(mutation) })

    replaced.write(0, new TextEncoder().encode('changed'))
    expect(mutations.map(mutation => mutation.path)).toEqual(['.ondra/target-alias'])
    expect(vfs.readFileSync('.ondra/target', 'utf8')).toBe('replacement')
    expect(vfs.readFileSync('.ondra/target-alias', 'utf8')).toBe('changed')
    expect(linkCount(vfs, '.ondra/target-alias')).toBe(1n)

    vfs.seed('.ondra/tree/file', 'tree')
    vfs.linkSync('.ondra/tree/file', '.ondra/outside')
    const moved = vfs.openFileSync('.ondra/tree/file', 'r+')
    vfs.renameSync('.ondra/tree', '.ondra/moved')
    mutations.length = 0
    moved.write(0, new TextEncoder().encode('moved'))
    expect(mutations.map(mutation => mutation.path)).toEqual(['.ondra/outside', '.ondra/moved/file'])
    expect(linkCount(vfs, '.ondra/moved/file')).toBe(2n)

    vfs.rmSync('.ondra/moved', { recursive: true })
    mutations.length = 0
    moved.write(0, new TextEncoder().encode('kept!'))
    expect(mutations.map(mutation => mutation.path)).toEqual(['.ondra/outside'])
    expect(vfs.readFileSync('.ondra/outside', 'utf8')).toBe('kept!')
    expect(linkCount(vfs, '.ondra/outside')).toBe(1n)
  })

  it('rejects renaming a file over an existing directory', () => {
    const vfs = new MemoryVfs()
    vfs.seed('.ondra/file', 'value')
    vfs.seedDirectory('.ondra/directory')
    expect(() => { vfs.renameSync('.ondra/file', '.ondra/directory') }).toThrow(expect.objectContaining({ code: 'EISDIR' }))
    expect(vfs.readFileSync('.ondra/file', 'utf8')).toBe('value')
    expect(vfs.statSync('.ondra/directory').isDirectory()).toBe(true)
  })
})
