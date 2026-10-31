/**
 * Per-day conversation folders under one fixed Workspace root.
 *
 * Ondra installs with a single, non-selectable Workspace. Without a bucket the
 * directory would accumulate every file every conversation ever produced, so a
 * new conversation opens in the folder for the calendar day it started. The
 * folder is derived from the Workspace root and today's local date only, so two
 * launches on the same day resolve the same directory and a launch on a new day
 * starts a new bucket without any user action.
 */

import { basename, dirname, join } from 'node:path'

/** Exact spelling of a day bucket: `YYYY-MM-DD`. */
export const DAY_DIRECTORY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Format one calendar day as a bucket name.
 * @param date - the local instant whose calendar day is used; defaults to now.
 * @returns the `YYYY-MM-DD` bucket name.
 */
export function dayDirectoryName(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Resolve the bucket a conversation started under `root` today belongs to.
 * @param root - the Workspace root the conversation is opened in.
 * @param date - the local instant naming the bucket; defaults to now.
 * @returns the absolute day bucket path.
 */
export function dayScopedDirectory(root: string, date: Date = new Date()): string {
  return join(root, dayDirectoryName(date))
}

/**
 * Whether `child` is a day bucket directly under `parent`.
 *
 * A blank Session that was minted yesterday carries yesterday's bucket in its
 * header. Reusing it today must keep that recorded directory rather than fail
 * as a working-directory conflict, so callers compare through this predicate
 * instead of string equality.
 * @param parent - the Workspace root the caller asked for.
 * @param child - the directory recorded by an existing Session, if any.
 * @returns true when `child` is one day bucket inside `parent`.
 */
export function isDayScopedDirectory(parent: string, child: string | undefined): boolean {
  if (child === undefined) return false
  return dirname(child) === parent && DAY_DIRECTORY_PATTERN.test(basename(child))
}
