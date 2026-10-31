import { describe, expect, it } from 'vitest'
import {
  DAY_DIRECTORY_PATTERN,
  dayDirectoryName,
  dayScopedDirectory,
  isDayScopedDirectory,
} from '../src/day-directory.ts'

describe('day buckets', () => {
  it('formats a calendar day as YYYY-MM-DD with zero padding', () => {
    expect(dayDirectoryName(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(dayDirectoryName(new Date(2026, 9, 30))).toBe('2026-10-30')
    expect(dayDirectoryName(new Date(2026, 11, 31))).toBe('2026-12-31')
  })

  it('uses the local calendar day rather than UTC', () => {
    // Late-evening local time must not roll over to the next UTC day.
    const late = new Date(2026, 9, 30, 23, 30, 0)
    expect(dayDirectoryName(late)).toBe('2026-10-30')
  })

  it('nests one bucket under the fixed Workspace root', () => {
    expect(dayScopedDirectory('/home/a/.ondra/workspace', new Date(2026, 9, 30)))
      .toMatch(/[/\\]home[/\\]a[/\\]\.ondra[/\\]workspace[/\\]2026-10-30$/u)
  })

  it('recognises a bucket directly under its parent', () => {
    expect(isDayScopedDirectory('/w', '/w/2026-10-30')).toBe(true)
  })

  it('rejects unrelated or deeper directories', () => {
    expect(isDayScopedDirectory('/w', '/w')).toBe(false)
    expect(isDayScopedDirectory('/w', '/w/notes')).toBe(false)
    expect(isDayScopedDirectory('/w', '/w/2026-10-30/nested')).toBe(false)
    expect(isDayScopedDirectory('/w', '/other/2026-10-30')).toBe(false)
    expect(isDayScopedDirectory('/w', undefined)).toBe(false)
  })

  it('keeps the bucket pattern anchored so lookalikes do not pass', () => {
    expect(DAY_DIRECTORY_PATTERN.test('2026-10-30')).toBe(true)
    expect(DAY_DIRECTORY_PATTERN.test('2026-1-30')).toBe(false)
    expect(DAY_DIRECTORY_PATTERN.test('x2026-10-30')).toBe(false)
    expect(DAY_DIRECTORY_PATTERN.test('2026-10-30x')).toBe(false)
  })
})
