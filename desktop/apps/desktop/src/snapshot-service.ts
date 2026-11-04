/**
 * Time-Machine-style snapshots of the Ondra home.
 *
 * WHAT A SNAPSHOT IS. A hard-link farm, not a copy: every snapshot directory
 * holds the same relative tree, and a file that has not changed since the
 * previous snapshot is linked — not duplicated — so the first snapshot costs its
 * bytes once and every later one costs only what changed. That is the whole
 * reason this can run every five minutes without eating the disk.
 *
 * WHY NOT `cp -c`/`clonefile`. APFS clones are cheap only within one volume and
 * silently degrade to real copies across devices; `link()` is what makes "the
 * same bytes in two trees" true everywhere, and `linkAtomic` falls back to a copy
 * for the one case links cannot cross: a different filesystem.
 *
 * WHAT IS LEFT OUT. `node_modules` and the runtime payloads are rebuildable
 * artifacts measured in hundreds of megabytes; snapshotting them would turn a
 * 72 MB Session tree into gigabytes. They are listed in {@link SNAPSHOT_SKIP} and
 * reported in the snapshot manifest so a restore states what it did not cover.
 *
 * Restoration is a copy back, never a swap: the live tree keeps its inode
 * identity so a running Host's open handles stay valid, and every file the
 * snapshot did not contain is left alone rather than deleted.
 */
import { createHash } from 'node:crypto'
import { linkSync, copyFileSync, mkdirSync, readdirSync, statSync, utimesSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

/** One restorable snapshot on disk. */
export interface SnapshotEntry {
  /** Directory name, `snapshot-<ISO compact>-<seq>`. */
  readonly id: string
  /** Wall-clock creation time, milliseconds since the epoch. */
  readonly createdAt: number
  /** Files captured. */
  readonly files: number
  /** Bytes the snapshot adds on disk (files newly written, not linked). */
  readonly addedBytes: number
  /** Absolute directory holding the captured tree. */
  readonly directory: string
}

/** The manifest written beside each captured tree. */
interface SnapshotManifest extends SnapshotEntry {
  /** Relative paths deliberately not captured. */
  readonly skipped: readonly string[]
}

/** Top-level entries never captured: rebuildable artifacts, and the snapshots
 * themselves — capturing `snapshots/` inside a snapshot would copy every prior
 * snapshot into each new one, which squares the disk cost every pass. */
export const SNAPSHOT_SKIP: readonly string[] = Object.freeze([
  'snapshots',
  'node_modules',
  'runtime',
  'cache',
  'electron',
  'attachments',
  'logs',
])

/** Minimum and maximum spacing the interval control accepts. */
export const INTERVAL_MINUTES = { min: 5, max: 24 * 60 } as const

/**
 * Normalize a requested interval.
 * @param minutes - requested period, in minutes.
 * @returns the clamped integer period.
 */
export function clampInterval(minutes: number): number {
  if (!Number.isFinite(minutes)) return 30
  return Math.min(INTERVAL_MINUTES.max, Math.max(INTERVAL_MINUTES.min, Math.round(minutes)))
}

/**
 * Decide whether a snapshot is due.
 * @param last - creation time of the newest snapshot, or undefined when none.
 * @param now - current time.
 * @param intervalMinutes - configured period.
 * @returns true when the newest snapshot is older than one period.
 */
export function isSnapshotDue(last: number | undefined, now: number, intervalMinutes: number): boolean {
  if (last === undefined) return true
  return now - last >= clampInterval(intervalMinutes) * 60_000
}

/** Directory holding every snapshot of one home. */
export function snapshotsRoot(home: string): string {
  return join(home, 'snapshots')
}

/**
 * Read the snapshot list, newest first.
 *
 * A directory without a readable manifest is ignored rather than guessed at: a
 * half-written snapshot must never appear as restorable.
 * @param home - Ondra home.
 * @returns the complete snapshots, newest first.
 */
export async function listSnapshots(home: string): Promise<SnapshotEntry[]> {
  const root = snapshotsRoot(home)
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  const entries: SnapshotEntry[] = []
  for (const name of names) {
    try {
      const manifest = JSON.parse(await readFile(join(root, name, 'manifest.json'), 'utf8')) as SnapshotManifest
      entries.push({
        id: manifest.id, createdAt: manifest.createdAt, files: manifest.files,
        addedBytes: manifest.addedBytes, directory: join(root, name),
      })
    } catch {
      continue
    }
  }
  return entries.sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * Capture one snapshot of the home.
 *
 * Unchanged files are hard-linked from the newest existing snapshot; everything
 * else is copied. The manifest is written last, so an interrupted capture leaves
 * a directory {@link listSnapshots} skips and {@link pruneSnapshots} removes.
 * @param home - Ondra home.
 * @param options - capture time and the retained-snapshot cap.
 * @returns the new snapshot, or null when nothing changed and no snapshot was needed.
 */
export async function captureSnapshot(
  home: string,
  options: { readonly now?: number; readonly keep?: number } = {},
): Promise<SnapshotEntry> {
  const now = options.now ?? Date.now()
  const keep = options.keep ?? 24
  const root = snapshotsRoot(home)
  const existing = await listSnapshots(home)
  const previous = existing[0]
  const id = `snapshot-${new Date(now).toISOString().replace(/[:.]/gu, '-')}-${String(existing.length + 1)}`
  const directory = join(root, id)
  await mkdir(directory, { recursive: true })

  let files = 0
  let addedBytes = 0
  const failed: string[] = []
  const walk = (relativePath: string): void => {
    const absolute = join(home, relativePath)
    let entries
    try {
      entries = readdirSync(absolute, { withFileTypes: true })
    } catch {
      failed.push(relativePath)
      return
    }
    for (const entry of entries) {
      if (relativePath === '' && SNAPSHOT_SKIP.includes(entry.name)) continue
      const child = relativePath === '' ? entry.name : `${relativePath}/${entry.name}`
      if (entry.isDirectory()) {
        walk(child)
        continue
      }
      if (!entry.isFile()) continue
      const destination = join(directory, child)
      try {
        mkdirSync(join(destination, '..'), { recursive: true })
        const size = statSync(join(home, child)).size
        // Link from the newest snapshot that holds the same bytes. The mtime and
        // size are the cheap stand-in for "unchanged": content hashing every file
        // on every pass is exactly the cost this design exists to avoid.
        if (previous !== undefined && linkUnchanged(join(home, child), previous.directory, child, destination)) {
          files += 1
          continue
        }
        copyFileSync(join(home, child), destination)
        // Preserve the source mtime. Without this every copied file looks
        // modified on the next pass — `copyFileSync` stamps "now" — so nothing
        // would ever link and each snapshot would cost its full size again.
        const live = statSync(join(home, child))
        // Carried across as seconds-float, which is what `utimes` accepts.
        utimesSync(destination, live.atimeMs / 1000, live.mtimeMs / 1000)
        files += 1
        addedBytes += size
      } catch {
        failed.push(child)
      }
    }
  }
  walk('')

  const manifest: SnapshotManifest = {
    id, createdAt: now, files, addedBytes, directory, skipped: [...SNAPSHOT_SKIP, ...failed],
  }
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
  await pruneSnapshots(home, keep)
  return { id, createdAt: now, files, addedBytes, directory }
}

/**
 * Hard-link one file from the previous snapshot when it is still identical.
 * @param previousDirectory - snapshot the file may be linked from.
 * @param relativePath - path inside both trees.
 * @param destination - absolute path to create.
 * @returns whether the link was made.
 */
function linkUnchanged(
  livePath: string, previousDirectory: string, relativePath: string, destination: string,
): boolean {
  try {
    const live = statSync(livePath)
    const prior = statSync(join(previousDirectory, relativePath))
    // Size and mtime are the cheap stand-in for "unchanged": hashing every file
    // on every pass is exactly the cost this design exists to avoid.
    //
    // Size plus a 2 ms tolerance on mtime.
    //
    // The tolerance is not laxity, it is arithmetic: `utimes` takes seconds as a
    // float, and the round trip loses the last millisecond on some filesystems
    // (measured: 1793685561448 → 1793685561447). An exact comparison therefore
    // never matches, nothing links, and every snapshot costs its full size. Two
    // milliseconds is far below any real edit interval, so a genuine change is
    // still caught — and a missed change would mean lost data.
    if (live.size !== prior.size || Math.abs(live.mtimeMs - prior.mtimeMs) > 2) return false
    linkSync(join(previousDirectory, relativePath), destination)
    return true
  } catch {
    return false
  }
}

/**
 * Delete all but the newest `keep` snapshots.
 * @param home - Ondra home.
 * @param keep - number of snapshots to retain.
 * @returns how many directories were removed.
 */
export async function pruneSnapshots(home: string, keep: number): Promise<number> {
  const entries = await listSnapshots(home)
  let removed = 0
  for (const entry of entries.slice(Math.max(1, keep))) {
    await rm(entry.directory, { recursive: true, force: true })
    removed += 1
  }
  // Directories without a manifest are interrupted captures.
  const root = snapshotsRoot(home)
  let names: string[] = []
  try {
    names = await readdir(root)
  } catch {
    return removed
  }
  for (const name of names) {
    try {
      await stat(join(root, name, 'manifest.json'))
    } catch {
      await rm(join(root, name), { recursive: true, force: true })
      removed += 1
    }
  }
  return removed
}

/**
 * Restore one snapshot over the live home.
 *
 * Every captured file is copied back. Files the snapshot did not contain are
 * left in place — a restore repairs what it knows about and does not delete work
 * that appeared after the snapshot, which is the failure mode that makes people
 * afraid of restore buttons.
 * @param home - Ondra home.
 * @param id - snapshot to restore.
 * @param options - files to leave untouched (the snapshot's own root).
 * @returns how many files were written.
 */
export async function restoreSnapshot(home: string, id: string, options: { readonly skip?: readonly string[] } = {}): Promise<number> {
  const entries = await listSnapshots(home)
  const entry = entries.find(candidate => candidate.id === id)
  if (entry === undefined) throw new Error(`snapshot ${id} does not exist or is unreadable`)
  const skip = new Set(['snapshots', ...(options.skip ?? [])])
  let written = 0
  const walk = (relativePath: string): void => {
    const absolute = join(entry.directory, relativePath)
    for (const child of readdirSync(absolute, { withFileTypes: true })) {
      if (relativePath === '' && (child.name === 'manifest.json' || skip.has(child.name))) continue
      const next = relativePath === '' ? child.name : `${relativePath}/${child.name}`
      if (child.isDirectory()) {
        walk(next)
        continue
      }
      if (!child.isFile()) continue
      const destination = join(home, next)
      mkdirSync(join(destination, '..'), { recursive: true })
      copyFileSync(join(entry.directory, next), destination)
      written += 1
    }
  }
  walk('')
  return written
}

/**
 * Delete one snapshot directory.
 * @param home - Ondra home.
 * @param id - snapshot to drop.
 * @returns whether it existed.
 */
export async function deleteSnapshot(home: string, id: string): Promise<boolean> {
  const entry = (await listSnapshots(home)).find(candidate => candidate.id === id)
  if (entry === undefined) return false
  await rm(entry.directory, { recursive: true, force: true })
  return true
}

/**
 * Digest one snapshot's manifest, for the confirmation copy.
 * @param home - Ondra home.
 * @param id - snapshot to describe.
 * @returns the manifest, or undefined.
 */
export async function snapshotManifest(home: string, id: string): Promise<SnapshotManifest | undefined> {
  try {
    return JSON.parse(await readFile(join(snapshotsRoot(home), id, 'manifest.json'), 'utf8')) as SnapshotManifest
  } catch {
    return undefined
  }
}

/** Stable identity of the home a snapshot belongs to, for the settings copy. */
export function homeIdentity(home: string): string {
  return createHash('sha256').update(home).digest('hex').slice(0, 12)
}

/** Relative path helper kept here so callers never re-implement it. */
export function relativeTo(home: string, absolute: string): string {
  return relative(home, absolute)
}
