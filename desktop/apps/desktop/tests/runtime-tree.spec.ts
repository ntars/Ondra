import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DESKTOP_HOST_PACKAGE, DESKTOP_HOST_RUNTIME_FILES } from '../src/core-package-set.ts'
import { DESKTOP_RUNTIME_FILE, readDesktopRuntime, runtimePath, verifyDesktopRuntime, writeDesktopRuntime, writeDesktopRuntimeAsync } from '../src/runtime-tree.ts'
import { runtimeFixture } from './runtime-fixture.ts'

const roots: string[] = []
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'desktop-runtime-'))
  roots.push(root)
  runtimeFixture(join(root, 'ondra'))
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('seals final file bytes identically with concurrent and synchronous inventory', async () => {
  const ondra = join(fixture(), 'ondra')
  const original = readDesktopRuntime(ondra)
  const names = original.sharedPackages.map(entry => entry.name)
  writeFileSync(join(ondra, 'extra.bin'), Buffer.from([0, 1, 255]))
  writeFileSync(join(ondra, 'package.json'), '{"type":"module","private":true}\n')
  const expected = writeDesktopRuntime(ondra, original.release, names)
  const expectedBytes = readFileSync(join(ondra, DESKTOP_RUNTIME_FILE))
  expect(await writeDesktopRuntimeAsync(ondra, original.release, names)).toEqual(expected)
  expect(readFileSync(join(ondra, DESKTOP_RUNTIME_FILE))).toEqual(expectedBytes)
  expect(await verifyDesktopRuntime(ondra, original.release.version)).toEqual(expected)
})

it.each(['manifest', 'link'])('leaves the descriptor unchanged when concurrent sealing rejects a %s', async (failure) => {
  const ondra = join(fixture(), 'ondra')
  const original = readDesktopRuntime(ondra)
  const before = readFileSync(join(ondra, DESKTOP_RUNTIME_FILE))
  if (failure === 'manifest') writeFileSync(join(ondra, 'node_modules', DESKTOP_HOST_PACKAGE, 'package.json'), '{}')
  else symlinkSync(join(ondra, 'node_modules'), join(ondra, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(writeDesktopRuntimeAsync(ondra, original.release, original.sharedPackages.map(entry => entry.name))).rejects.toThrow()
  expect(readFileSync(join(ondra, DESKTOP_RUNTIME_FILE))).toEqual(before)
})

it('verifies a runtime after relocation without depending on build paths', async () => {
  const root = fixture()
  const before = await verifyDesktopRuntime(join(root, 'ondra'), '1.0.0')
  cpSync(join(root, 'ondra'), join(root, 'moved'), { recursive: true })
  expect(await verifyDesktopRuntime(join(root, 'moved'), '1.0.0')).toEqual(before)
})
it.each(['changed', 'same-size', 'extra', 'missing'])('checks %s runtime bytes only during build verification', async (operation) => {
  const ondra = join(fixture(), 'ondra')
  const before = readDesktopRuntime(ondra)
  if (operation === 'changed') writeFileSync(join(ondra, 'package.json'), '{}')
  if (operation === 'same-size') writeFileSync(join(ondra, 'package.json'), '{"type":"Module"}\n')
  if (operation === 'extra') writeFileSync(join(ondra, 'extra'), '')
  if (operation === 'missing') rmSync(join(ondra, 'package.json'))
  expect(readDesktopRuntime(ondra)).toEqual(before)
  await expect(verifyDesktopRuntime(ondra, '1.0.0')).rejects.toThrow(/integrity/u)
})
it('rejects filesystem links and incompatible targets', async () => {
  const ondra = join(fixture(), 'ondra')
  await expect(verifyDesktopRuntime(ondra, '1.0.0', { platform: process.platform, arch: 'wrong' })).rejects.toThrow(/incompatible/u)
  symlinkSync(join(ondra, 'node_modules'), join(ondra, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(readDesktopRuntime(ondra).release.version).toBe('1.0.0')
  await expect(verifyDesktopRuntime(ondra, '1.0.0')).rejects.toThrow(/unsupported filesystem/u)
})
it('reads file inventory records unchanged during startup', () => {
  const ondra = join(fixture(), 'ondra')
  const path = join(ondra, DESKTOP_RUNTIME_FILE)
  const descriptor = JSON.parse(readFileSync(path, 'utf8')) as { files: unknown[] }
  descriptor.files.unshift({ path: '../outside', bytes: -1.5, sha256: 'unchecked', executable: 'unchecked' })
  writeFileSync(path, JSON.stringify(descriptor))
  expect(readDesktopRuntime(ondra).files).toEqual(descriptor.files)
})
it.each(['missing', 'directory'])('checks a %s Host entry only during build verification', async (operation) => {
  const ondra = join(fixture(), 'ondra')
  const path = join(ondra, 'node_modules', DESKTOP_HOST_PACKAGE, DESKTOP_HOST_RUNTIME_FILES[0])
  rmSync(path)
  if (operation === 'directory') mkdirSync(path)
  expect(readDesktopRuntime(ondra).release.version).toBe('1.0.0')
  await expect(verifyDesktopRuntime(ondra, '1.0.0')).rejects.toThrow(/integrity/u)
})
it('checks the bundled version only during build verification', async () => {
  const ondra = join(fixture(), 'ondra')
  expect(readDesktopRuntime(ondra).release.version).toBe('1.0.0')
  await expect(verifyDesktopRuntime(ondra, '2.0.0')).rejects.toThrow(/bundled 1\.0\.0 is not the expected 2\.0\.0/u)
})
it.each([
  { schemaVersion: 2 },
  { platform: 'other' },
  { arch: 'other' },
  { release: { schemaVersion: 2 } },
  { release: { hostProtocolVersion: 999 } },
  { release: { nodeVersion: 'invalid' } },
  { release: { pnpmVersion: 'invalid' } },
])('checks release compatibility only during build verification: %j', async (patch) => {
  const ondra = join(fixture(), 'ondra')
  const path = join(ondra, DESKTOP_RUNTIME_FILE)
  const original = readDesktopRuntime(ondra)
  const descriptor = { ...original, ...patch, release: { ...original.release, ...patch.release } }
  writeFileSync(path, JSON.stringify(descriptor))
  expect(readDesktopRuntime(ondra)).toEqual(descriptor)
  await expect(verifyDesktopRuntime(ondra, '1.0.0')).rejects.toThrow(/invalid|incompatible/u)
})
it.each(['missing', 'invalid-json', 'mismatched'])('checks %s shared manifests only during build verification', async (operation) => {
  const ondra = join(fixture(), 'ondra')
  const before = readDesktopRuntime(ondra)
  const path = join(ondra, 'node_modules', DESKTOP_HOST_PACKAGE, 'package.json')
  if (operation === 'missing') rmSync(path)
  else writeFileSync(path, operation === 'invalid-json' ? '{' : '{}')
  expect(readDesktopRuntime(ondra)).toEqual(before)
  await expect(verifyDesktopRuntime(ondra, '1.0.0')).rejects.toThrow()
})
it('rejects a descriptor that maps a shared package outside node_modules', async () => {
  const ondra = join(fixture(), 'ondra')
  const path = join(ondra, DESKTOP_RUNTIME_FILE)
  const descriptor = JSON.parse(readFileSync(path, 'utf8')) as { sharedPackages: { path: string }[] }
  descriptor.sharedPackages[0]!.path = '../outside'
  writeFileSync(path, JSON.stringify(descriptor))
  await expect(verifyDesktopRuntime(ondra, '1.0.0')).rejects.toThrow(/shared package record/u)
})
it('verifies recorded executable permissions only on Unix', async () => {
  const ondra = join(fixture(), 'ondra')
  const path = join(ondra, DESKTOP_RUNTIME_FILE)
  const descriptor = JSON.parse(readFileSync(path, 'utf8')) as { files: { executable: boolean }[] }
  descriptor.files[0]!.executable = !descriptor.files[0]!.executable
  writeFileSync(path, JSON.stringify(descriptor))
  if (process.platform === 'win32') await expect(verifyDesktopRuntime(ondra, '1.0.0')).resolves.toMatchObject(descriptor)
  else await expect(verifyDesktopRuntime(ondra, '1.0.0')).rejects.toThrow(/integrity/u)
})
it.each(['../outside', '/absolute', 'C:/absolute', 'a\\b', 'a//b', './a'])('rejects nonportable path %s', (path) => {
  expect(() => runtimePath('/runtime', path)).toThrow(/invalid relative path/u)
})
