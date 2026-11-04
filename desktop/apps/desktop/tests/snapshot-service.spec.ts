import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureSnapshot, clampInterval, deleteSnapshot, isSnapshotDue, listSnapshots, restoreSnapshot, snapshotsRoot,
} from '../src/snapshot-service.ts'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** A throwaway Ondra home with a few Session-ish files. */
function home(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ondra-snapshots-'))
  homes.push(directory)
  mkdirSync(join(directory, 'sessions', '--project--', 'session-one'), { recursive: true })
  writeFileSync(join(directory, 'sessions', '--project--', 'session-one', 'log.jsonl'), 'v1\n')
  writeFileSync(join(directory, 'cordis.yml'), 'a: 1\n')
  // Rebuildable artifacts must never be captured.
  mkdirSync(join(directory, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(directory, 'node_modules', 'x', 'index.js'), 'module\n')
  return directory
}

describe('interval', () => {
  it('clamps to the supported range and survives nonsense', () => {
    expect(clampInterval(1)).toBe(5)
    expect(clampInterval(45)).toBe(45)
    expect(clampInterval(99_999)).toBe(1440)
    expect(clampInterval(Number.NaN)).toBe(30)
  })

  it('is due immediately with no snapshot, then only after one full period', () => {
    const now = 1_700_000_000_000
    expect(isSnapshotDue(undefined, now, 30)).toBe(true)
    expect(isSnapshotDue(now - 29 * 60_000, now, 30)).toBe(false)
    expect(isSnapshotDue(now - 30 * 60_000, now, 30)).toBe(true)
  })
})

describe('capture', () => {
  it('captures the tree but leaves rebuildable artifacts out', async () => {
    const root = home()
    const entry = await captureSnapshot(root, { now: 1_700_000_000_000 })

    expect(entry.files).toBe(2)
    const manifest = JSON.parse(readFileSync(join(entry.directory, 'manifest.json'), 'utf8')) as { skipped: string[] }
    expect(manifest.skipped).toContain('node_modules')
    expect(readFileSync(join(entry.directory, 'cordis.yml'), 'utf8')).toBe('a: 1\n')
    expect(() => readFileSync(join(entry.directory, 'node_modules', 'x', 'index.js'))).toThrow()
  })

  it('adds only the changed bytes on a second pass', async () => {
    const root = home()
    await captureSnapshot(root, { now: 1_700_000_000_000 })
    writeFileSync(join(root, 'cordis.yml'), 'a: 2\n')
    const second = await captureSnapshot(root, { now: 1_700_000_060_000 })

    // The unchanged Session log is linked, so only cordis.yml is new bytes.
    expect(second.addedBytes).toBe('a: 2\n'.length)
    expect(second.files).toBe(2)
  })

  it('orders newest first and honours the retention cap', async () => {
    const root = home()
    await captureSnapshot(root, { now: 1_700_000_000_000, keep: 99 })
    await captureSnapshot(root, { now: 1_700_000_060_000, keep: 2 })
    await captureSnapshot(root, { now: 1_700_000_120_000, keep: 2 })

    const entries = await listSnapshots(root)
    expect(entries).toHaveLength(2)
    expect(entries[0]!.createdAt).toBe(1_700_000_120_000)
  })
})

describe('restore', () => {
  it('rewrites captured files and leaves files created later alone', async () => {
    const root = home()
    const first = await captureSnapshot(root, { now: 1_700_000_000_000 })
    writeFileSync(join(root, 'cordis.yml'), 'a: 2\n')
    writeFileSync(join(root, 'created-later.txt'), 'new\n')

    const written = await restoreSnapshot(root, first.id)
    expect(written).toBe(2)
    expect(readFileSync(join(root, 'cordis.yml'), 'utf8')).toBe('a: 1\n')
    // The restore repairs what it knows about; it never deletes newer work.
    expect(readFileSync(join(root, 'created-later.txt'), 'utf8')).toBe('new\n')
    // Restoring must not write snapshots back over snapshots: the tree is
    // excluded by the same rule the capture uses.
    expect(readFileSync(join(root, 'snapshots', first.id, 'cordis.yml'), 'utf8')).toBe('a: 1\n')
    expect(await listSnapshots(root)).toHaveLength(1)
  })

  it('refuses an unknown snapshot instead of half-restoring', async () => {
    const root = home()
    await expect(restoreSnapshot(root, 'snapshot-nope')).rejects.toThrow(/does not exist/u)
  })
})

describe('delete', () => {
  it('drops one snapshot and reports whether it existed', async () => {
    const root = home()
    const entry = await captureSnapshot(root, { now: 1_700_000_000_000 })
    expect(await deleteSnapshot(root, entry.id)).toBe(true)
    expect(await listSnapshots(root)).toEqual([])
    expect(await deleteSnapshot(root, entry.id)).toBe(false)
  })

  it('ignores a directory without a manifest', async () => {
    const root = home()
    mkdirSync(join(snapshotsRoot(root), 'snapshot-broken'), { recursive: true })
    expect(await listSnapshots(root)).toEqual([])
  })
})
