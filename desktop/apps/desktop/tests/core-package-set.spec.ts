import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DESKTOP_PACKAGES_DIR,
  DESKTOP_PACKAGE_SET_FILE,
  desktopCorePackageOverrides,
  desktopOndraPackageSpec,
  parseDesktopCorePackageSet,
  verifyDesktopCoreLockfile,
  verifyDesktopCorePackageSet,
  type DesktopCorePackageRecord,
} from '../src/core-package-set.ts'

const roots: string[] = []

function record(name: string, file: string, body: Buffer, version = '1.2.3'): DesktopCorePackageRecord {
  return {
    name,
    version,
    file,
    bytes: body.byteLength,
    integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`,
  }
}

function packageSetProject(): {
  root: string
  ondra: DesktopCorePackageRecord
  base: DesktopCorePackageRecord
  host: DesktopCorePackageRecord
} {
  const root = mkdtempSync(join(tmpdir(), 'ondra-desktop-package-set-'))
  roots.push(root)
  const packageDir = join(root, DESKTOP_PACKAGES_DIR)
  mkdirSync(packageDir)
  const ondraBody = Buffer.from('ondra')
  const baseBody = Buffer.from('base')
  const hostBody = Buffer.from('host')
  const ondra = record('@ntars/ondra', 'ondra.tgz', ondraBody)
  const base = record('@ntars/ondra-base', 'ondra-base.tgz', baseBody)
  const host = record('@ntars/ondra-desktop-host', 'ondra-desktop-host.tgz', hostBody)
  writeFileSync(join(packageDir, ondra.file), ondraBody)
  writeFileSync(join(packageDir, base.file), baseBody)
  writeFileSync(join(packageDir, host.file), hostBody)
  writeFileSync(join(root, DESKTOP_PACKAGE_SET_FILE), `${JSON.stringify({
    schemaVersion: 1,
    packages: [ondra, base, host],
  })}\n`)
  return { root, ondra, base, host }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop core package set', () => {
  it('pins the direct ondra dependency and every internal package to local tarballs', () => {
    const { root } = packageSetProject()
    const packageSet = verifyDesktopCorePackageSet(root, '1.2.3')
    expect(desktopOndraPackageSpec(packageSet)).toBe('file:./desktop-packages/ondra.tgz')
    expect(desktopCorePackageOverrides(packageSet)).toEqual({
      '@ntars/ondra': 'file:./desktop-packages/ondra.tgz',
      '@ntars/ondra-base': 'file:./desktop-packages/ondra-base.tgz',
      '@ntars/ondra-desktop-host': 'file:./desktop-packages/ondra-desktop-host.tgz',
    })
  })

  it('rejects version drift, descriptor disorder, corruption, and extra files', () => {
    const { root, ondra, base, host } = packageSetProject()
    expect(() => verifyDesktopCorePackageSet(root, '2.0.0')).toThrow(/does not match Desktop/u)
    expect(() => parseDesktopCorePackageSet({
      schemaVersion: 1,
      packages: [ondra, base, { ...host, version: '2.0.0' }],
    }, '1.2.3')).toThrow(/ondra-desktop-host@2\.0\.0 does not match Desktop 1\.2\.3/u)
    expect(() => parseDesktopCorePackageSet({ schemaVersion: 1, packages: [base, ondra, host] }))
      .toThrow(/sorted by name/u)
    writeFileSync(join(root, DESKTOP_PACKAGES_DIR, ondra.file), 'changed')
    expect(() => verifyDesktopCorePackageSet(root, '1.2.3')).toThrow(/integrity check failed/u)
    writeFileSync(join(root, DESKTOP_PACKAGES_DIR, 'extra.tgz'), '')
    expect(() => verifyDesktopCorePackageSet(root, '1.2.3')).toThrow(/does not match its descriptor/u)
  })

  it('rejects registry resolutions for names supplied by the local package set', () => {
    const ondra = record('@ntars/ondra', 'ondra.tgz', Buffer.from('ondra'))
    const host = record('@ntars/ondra-desktop-host', 'host.tgz', Buffer.from('host'))
    const packageSet = parseDesktopCorePackageSet({ schemaVersion: 1, packages: [ondra, host] })
    expect(() => {
      verifyDesktopCoreLockfile(
        "packages:\n  '@ntars/ondra@file:desktop-packages/ondra.tgz':\n    resolution: {}\n",
        packageSet,
      )
    }).not.toThrow()
    expect(() => {
      verifyDesktopCoreLockfile(
        "packages:\n  '@ntars/ondra@1.2.3':\n    resolution: {integrity: sha512-registry}\n",
        packageSet,
      )
    }).toThrow(/outside the local package set/u)
  })
})
