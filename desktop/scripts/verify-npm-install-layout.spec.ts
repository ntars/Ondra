import { describe, expect, it } from 'vitest'
import type { NpmPackageLock, RegistryIndex } from './benchmark-npm-resolution.ts'
import {
  assertDualOndraInstallLayout,
  assertResolutionWorkBudget,
  buildDualOndraRegistry,
  MAX_RESOLUTION_WORK_UNITS,
} from './verify-npm-install-layout.ts'

function validLayout(): NpmPackageLock {
  return {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { '@ntars/ondra': '0.2.0', 'ondra-previous': 'npm:@ntars/ondra@0.1.0' } },
      'node_modules/@ntars/cordis': { version: '4.0.1' },
      'node_modules/@ntars/ondra': {
        version: '0.2.0',
        dependencies: { '@ntars/ondra-child': '^0.2.0' },
        peerDependencies: { '@ntars/cordis': '^4.0.1' },
      },
      'node_modules/@ntars/ondra-child': {
        version: '0.2.0',
        dependencies: { '@ntars/ondra-leaf': '^0.2.0' },
      },
      'node_modules/@ntars/ondra-leaf': { version: '0.2.0' },
      'node_modules/ondra-previous': {
        name: '@ntars/ondra',
        version: '0.1.0',
        dependencies: { '@ntars/ondra-child': '^0.1.0' },
        peerDependencies: { '@ntars/cordis': '^4.0.1' },
      },
      'node_modules/ondra-previous/node_modules/@ntars/ondra-child': {
        version: '0.1.0',
        dependencies: { '@ntars/ondra-leaf': '^0.1.0' },
      },
      'node_modules/ondra-previous/node_modules/@ntars/ondra-leaf': { version: '0.1.0' },
    },
  }
}

describe('npm install layout verifier', () => {
  it('creates two incompatible versions of every Ondra package', () => {
    const index: RegistryIndex = new Map([
      ['@ntars/ondra', new Map([['0.1.1-rc.2', {
        name: '@ntars/ondra',
        version: '0.1.1-rc.2',
        dependencies: { '@ntars/ondra-child': '^0.1.1-rc.2' },
        peerDependencies: { '@ntars/cordis': '^4.0.1' },
      }]])],
      ['@ntars/ondra-child', new Map([['0.1.1-rc.2', {
        name: '@ntars/ondra-child',
        version: '0.1.1-rc.2',
      }]])],
      ['@ntars/cordis', new Map([['4.0.1', {
        name: '@ntars/cordis',
        version: '4.0.1',
      }]])],
    ])

    const dual = buildDualOndraRegistry(index, '0.1.1-rc.2')

    expect([...dual.get('@ntars/ondra')?.keys() ?? []]).toEqual(['0.1.0', '0.2.0'])
    expect(dual.get('@ntars/ondra')?.get('0.1.0')).toMatchObject({
      version: '0.1.0',
      dependencies: { '@ntars/ondra-child': '^0.1.0' },
      peerDependencies: { '@ntars/cordis': '^4.0.1' },
    })
    expect(dual.get('@ntars/ondra')?.get('0.2.0')).toMatchObject({
      version: '0.2.0',
      dependencies: { '@ntars/ondra-child': '^0.2.0' },
    })
    expect(dual.get('@ntars/cordis')).toBe(index.get('@ntars/cordis'))
  })

  it('accepts isolated Ondra releases with one shared Cordis installation', () => {
    expect(assertDualOndraInstallLayout(validLayout())).toEqual({
      ondraPackagesPerVersion: 3,
      checkedOndraEdges: 4,
    })
  })

  it.each([
    ['react', 'node_modules/react'],
    ['react-dom', 'node_modules/react-dom'],
    ['react', 'node_modules/ondra-previous/node_modules/react'],
    ['react-dom', 'node_modules/ondra-previous/node_modules/react-dom'],
  ])('rejects browser runtime %s installed at %s in the Ondra-only consumer', (name, path) => {
    const layout = validLayout()
    const packages = { ...layout.packages, [path]: { version: '18.3.1' } }
    expect(() => assertDualOndraInstallLayout({ ...layout, packages })).toThrow(
      `${path}: ${name} is a browser build input`,
    )
  })

  it('rejects an internal edge that crosses release versions', () => {
    const layout = validLayout()
    const packages = { ...layout.packages }
    Reflect.deleteProperty(packages, 'node_modules/ondra-previous/node_modules/@ntars/ondra-leaf')

    expect(() => assertDualOndraInstallLayout({ ...layout, packages })).toThrow(
      'node_modules/ondra-previous/node_modules/@ntars/ondra-child: dependencies '
      + '@ntars/ondra-leaf resolves to node_modules/@ntars/ondra-leaf@0.2.0, expected 0.1.0',
    )
  })

  it('rejects a second Cordis installation', () => {
    const layout = validLayout()
    const packages = {
      ...layout.packages,
      'node_modules/ondra-previous/node_modules/@ntars/cordis': { version: '4.0.1' },
    }

    expect(() => assertDualOndraInstallLayout({ ...layout, packages })).toThrow(
      'expected one shared @ntars/cordis',
    )
  })
})

describe('resolution work budget', () => {
  it('accepts the measured dual-release graph', () => {
    expect(assertResolutionWorkBudget({ ondraPackagesPerVersion: 320, checkedOndraEdges: 2836 }))
      .toBe(907_520)
  })

  it('accepts a graph exactly at the budget and rejects one internal edge above it', () => {
    const packages = 320
    const edgesAtBudget = Math.floor(MAX_RESOLUTION_WORK_UNITS / packages)

    expect(packages * edgesAtBudget).toBe(MAX_RESOLUTION_WORK_UNITS)
    expect(assertResolutionWorkBudget({ ondraPackagesPerVersion: packages, checkedOndraEdges: edgesAtBudget }))
      .toBe(MAX_RESOLUTION_WORK_UNITS)
    expect(() => assertResolutionWorkBudget({
      ondraPackagesPerVersion: packages,
      checkedOndraEdges: edgesAtBudget + 1,
    })).toThrow(`= ${String(MAX_RESOLUTION_WORK_UNITS + packages)} unit(s), budget ${String(MAX_RESOLUTION_WORK_UNITS)} unit(s)`)
  })

  it('accepts the headroom and rejects a runaway graph with its own measured counts', () => {
    expect(assertResolutionWorkBudget({ ondraPackagesPerVersion: 350, checkedOndraEdges: 3200 }))
      .toBe(1_120_000)
    expect(() => assertResolutionWorkBudget({ ondraPackagesPerVersion: 400, checkedOndraEdges: 3000 }))
      .toThrow(`400 package(s) per release x 3000 internal edge(s) = 1200000 unit(s), budget ${String(MAX_RESOLUTION_WORK_UNITS)} unit(s)`)
  })
})
