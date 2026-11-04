/** Release family discovery, publish order, tag naming, and the bump judgements. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { officialClientBuildEnvironment, writeClientBuildRecord } from '../client-build-environment.ts'
import { ON_DEMAND_BUNDLES } from '../../packages/util/official-bundles/src/bundles.ts'
import { releaseFamily, type ReleaseMember } from './families.ts'
import { compareVersions, nextVendorVersion, planShared, reachesPayload } from './bump.ts'

/**
 * A release member standing in for a manifest on disk.
 * @param directory - repository-relative package directory.
 * @param name - package name.
 * @param manifest - manifest fields the subject reads.
 * @returns The member.
 */
function member(directory: string, name: string, manifest: Record<string, unknown> = {}): ReleaseMember {
  return { directory, name, version: '0.0.1', manifest }
}

const roots: string[] = []

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function buildFixture(environment: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ondra-release-build-'))
  roots.push(root)
  write(join(root, 'package.json'), `${JSON.stringify({ version: environment.ONDRA_CLIENT_VERSION ?? '0.0.1' })}\n`)
  write(join(root, 'apps/web/dist/index.html'), '<main></main>')
  write(join(root, 'packages/client/example/lib/client.js'), 'module.exports = {}\n')
  writeClientBuildRecord(root, environment)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('release families', () => {
  it('publishes all current experimental packages', () => {
    const members = releaseFamily('ondra').members(resolve(import.meta.dirname, '../..'))

    expect(members
      .filter(member => member.directory.startsWith('packages/experimental/'))
      .map(member => member.name)).toEqual([
      '@ntars/ondra-action-cards',
      '@ntars/ondra-experimental-agent-team-profile',
      '@ntars/ondra-experimental-agent-team',
      '@ntars/ondra-experimental-api-speech-to-text',
      '@ntars/ondra-experimental-auto-review',
      '@ntars/ondra-experimental-badge-skill-bundle',
      '@ntars/ondra-experimental-browser-use-chrome-devtools-mcp',
      '@ntars/ondra-experimental-browser-use-playwright-mcp',
      '@ntars/ondra-experimental-browser-use-runtime',
      '@ntars/ondra-experimental-browser-use-stagehand-native',
      '@ntars/ondra-experimental-claude-code-mods',
      '@ntars/ondra-client-ui-action-cards',
      '@ntars/ondra-experimental-client-ui-agent-team',
      '@ntars/ondra-experimental-client-ui-claude-code-mods',
      '@ntars/ondra-experimental-client-ui-cot-translation',
      '@ntars/ondra-client-ui-creation-recommendations',
      '@ntars/ondra-experimental-client-ui-forge',
      '@ntars/ondra-client-ui-plugin-recommendations',
      '@ntars/ondra-experimental-client-ui-stats',
      '@ntars/ondra-experimental-client-ui-voice-input',
      '@ntars/ondra-experimental-computer-use-cua-driver-mcp',
      '@ntars/ondra-experimental-computer-use-cua-driver-native',
      '@ntars/ondra-experimental-cot-translation-bundle',
      '@ntars/ondra-creation-recommendations',
      '@ntars/ondra-cua-bundle',
      '@ntars/ondra-experimental-cua-macos',
      '@ntars/ondra-cua',
      '@ntars/ondra-experimental-forge-bundle',
      '@ntars/ondra-experimental-forge-github',
      '@ntars/ondra-experimental-forge-session',
      '@ntars/ondra-experimental-forge',
      '@ntars/ondra-hook-protocol',
      '@ntars/ondra-hooks-claude-code',
      '@ntars/ondra-hooks-codex',
      '@ntars/ondra-experimental-inspector-profile',
      '@ntars/ondra-experimental-inspector',
      '@ntars/ondra-experimental-liveshare-protocol',
      '@ntars/ondra-experimental-liveshare',
      '@ntars/ondra-personalized-recommendations',
      '@ntars/ondra-experimental-plugin-market-bundle',
      '@ntars/ondra-plugin-recommendations',
      '@ntars/ondra-experimental-ptc-runtime-python',
      '@ntars/ondra-experimental-ralph-bundle',
      '@ntars/ondra-experimental-session-inspector',
      '@ntars/ondra-experimental-session-search',
      '@ntars/ondra-session-title-all-prompts-llm',
      '@ntars/ondra-experimental-session-titles-bundle',
      '@ntars/ondra-skill-badge',
      '@ntars/ondra-experimental-speech-to-text-sensevoice',
      '@ntars/ondra-experimental-speech-to-text',
      '@ntars/ondra-experimental-subagent-oar',
      '@ntars/ondra-experimental-terminal-bundle',
      '@ntars/ondra-experimental-tool-agent-team',
      '@ntars/ondra-tool-ralph',
      '@ntars/ondra-tool-session-query',
      '@ntars/ondra-experimental-tool-subagent-oar',
      '@ntars/ondra-tool-terminal',
      '@ntars/ondra-experimental-tool-worktree',
      '@ntars/ondra-experimental-translator',
      '@ntars/ondra-experimental-voice-input-bundle',
      '@ntars/ondra-webhook-github',
      '@ntars/ondra-webhook',
      '@ntars/ondra-experimental-webworker-packer',
      '@ntars/ondra-experimental-webworker-runtime',
      '@ntars/ondra-experimental-worktree',
    ])
  })

  it('excludes private applications from the publish set', () => {
    const root = mkdtempSync(join(tmpdir(), 'ondra-release-private-'))
    roots.push(root)
    write(join(root, 'apps/public/package.json'), '{"name":"@ntars/ondra-public","version":"0.0.1"}\n')
    write(join(root, 'apps/private/package.json'), '{"name":"@ntars/ondra-private","version":"0.0.1","private":true}\n')

    expect(releaseFamily('ondra').members(root).map(entry => entry.name)).toEqual(['@ntars/ondra-public'])
  })

  it('publishes unlisted experimental packages while retaining private exclusions', () => {
    const root = mkdtempSync(join(tmpdir(), 'ondra-release-experimental-'))
    roots.push(root)
    write(join(root, 'packages/experimental/prototype/package.json'), JSON.stringify({
      name: '@ntars/ondra-experimental-prototype',
      version: '0.0.1',
      publishConfig: { access: 'public' },
    }))
    write(join(root, 'packages/experimental/inspector/package.json'), JSON.stringify({
      name: '@ntars/ondra-experimental-inspector',
      version: '0.0.1',
      private: true,
    }))

    expect(releaseFamily('ondra').members(root).map(entry => entry.name)).toEqual([
      '@ntars/ondra-experimental-prototype',
    ])
  })

  it('bumps private ondra workspaces without adding release tags', () => {
    const root = mkdtempSync(join(tmpdir(), 'ondra-release-version-'))
    roots.push(root)
    write(join(root, 'package.json'), '{"version":"0.0.1"}\n')
    write(join(root, 'apps/desktop/package.json'), '{"version":"0.0.1","private":true}\n')
    write(join(root, 'packages/experimental/prototype/package.json'), '{"version":"0.0.1","private":true}\n')
    write(join(root, 'packages/core/unselected/package.json'), '{"version":"0.0.1"}\n')

    const ondra = releaseFamily('ondra')
    const published = member('packages/core/published', '@ntars/ondra-published')
    const { planned } = planShared(ondra, root, [published], '0.0.2')

    expect(planned.map(entry => ({ path: entry.manifestPath, tag: entry.tag }))).toEqual([
      { path: 'package.json', tag: undefined },
      { path: 'packages/core/published/package.json', tag: 'ondra-v0.0.2' },
      { path: 'apps/desktop/package.json', tag: undefined },
      { path: 'packages/experimental/prototype/package.json', tag: undefined },
    ])
  })

  it.each(['0.0.2-alpha.1', '0.0.2-canary.1', '0.0.2-rc.1'])(
    'accepts the explicit ondra prerelease version %s',
    (version) => {
      const root = mkdtempSync(join(tmpdir(), 'ondra-release-prerelease-'))
      roots.push(root)
      write(join(root, 'package.json'), '{"version":"0.0.1"}\n')

      const ondra = releaseFamily('ondra')
      const published = member('packages/core/published', '@ntars/ondra-published')
      const plan = planShared(ondra, root, [published], version)

      expect(plan.version).toBe(version)
      expect(plan.planned[1]?.tag).toBe(`ondra-v${version}`)
    },
  )

  it('names one tag for the whole ondra family and one per vendored package', () => {
    const ondra = releaseFamily('ondra')
    const vendor = releaseFamily('vendor')
    const cli = member('apps/cli', '@ntars/ondra')
    const cordis = { ...member('vendor/cordis', '@ntars/cordis'), version: '4.0.1' }

    expect(ondra.tagFor(cli)).toBe('ondra-v0.0.1')
    expect(vendor.tagFor(cordis)).toBe('vendor-cordis-v4.0.1')
    // The prefix is constructed, not recovered from a tag: a version with a
    // hyphen would defeat any suffix-stripping.
    expect(vendor.tagPrefixFor({ ...cordis, version: '4.0.0-rc.7' })).toBe('vendor-cordis-v')
    expect(vendor.tagFor({ ...cordis, version: '4.0.0-rc.7' })).toBe('vendor-cordis-v4.0.0-rc.7')
  })

  it('assigns alpha and canary dist-tags only to ondra releases', () => {
    const ondra = releaseFamily('ondra')
    const vendor = releaseFamily('vendor')

    expect(ondra.distTagForVersion('0.0.2-alpha.1')).toBe('alpha')
    expect(ondra.distTagForVersion('0.0.2-canary.1')).toBe('canary')
    expect(ondra.distTagForVersion('0.0.2-rc.1')).toBe('next')
    expect(ondra.distTagForVersion('0.0.2')).toBeUndefined()
    expect(vendor.distTagForVersion('4.0.1-alpha.1')).toBe('next')
    expect(vendor.distTagForVersion('4.0.1-canary.1')).toBe('next')
  })

  it('rejects a family whose members disagree on the shared version', () => {
    const ondra = releaseFamily('ondra')
    const members = [member('apps/cli', '@ntars/ondra'), { ...member('apps/web', '@ntars/ondra-web-frontend'), version: '0.0.2' }]

    expect(() => { ondra.verifyVersions(members) }).toThrow(/must share one version/)
    expect(() => { ondra.verifyVersions([members[0]!]) }).not.toThrow()
  })

  it('accepts independent vendored versions and rejects an unpublishable one', () => {
    const vendor = releaseFamily('vendor')
    const members = [
      { ...member('vendor/cordis', '@ntars/cordis'), version: '4.0.1' },
      { ...member('vendor/cosmokit', '@ntars/cosmokit'), version: '1.8.2' },
    ]

    expect(() => { vendor.verifyVersions(members) }).not.toThrow()
    expect(() => { vendor.verifyVersions([{ ...members[0]!, version: 'latest' }]) }).toThrow(/unpublishable version/)
  })

  it('requires a current official client build only for ondra artifacts', () => {
    const ondra = releaseFamily('ondra')
    const vendor = releaseFamily('vendor')
    const officialEnvironment = officialClientBuildEnvironment(resolve(import.meta.dirname, '../..'))
    vi.stubEnv('ONDRA_CLIENT_COMMIT_HASH', officialEnvironment.ONDRA_CLIENT_COMMIT_HASH)
    const official = buildFixture(officialEnvironment)
    const defaultBuild = buildFixture({})
    const missing = join(defaultBuild, 'missing')
    write(join(missing, 'package.json'), `${JSON.stringify({ version: officialEnvironment.ONDRA_CLIENT_VERSION })}\n`)

    expect(() => { ondra.verifyBuildArtifacts(official) }).not.toThrow()
    expect(() => { ondra.verifyBuildArtifacts(defaultBuild) }).toThrow(/ONDRA_CLIENT_TITLE/)
    expect(() => { ondra.verifyBuildArtifacts(missing) }).toThrow(/record.*missing/)
    expect(() => { vendor.verifyBuildArtifacts(missing) }).not.toThrow()

    write(join(official, 'packages/client/example/lib/client.js'), 'module.exports = { changed: true }\n')
    expect(() => { ondra.verifyBuildArtifacts(official) }).toThrow(/artifacts differ/)
  })

  it('publishes a dependency before its consumer, and orders ties by name', () => {
    const ondra = releaseFamily('ondra')
    const members = [
      member('packages/a/consumer', '@ntars/ondra-consumer', { dependencies: { '@ntars/ondra-library': 'workspace:^' } }),
      member('packages/a/library', '@ntars/ondra-library'),
      member('packages/a/zebra', '@ntars/ondra-zebra'),
    ]

    expect(ondra.publishOrder(members).order.map(entry => entry.name)).toEqual([
      '@ntars/ondra-library',
      '@ntars/ondra-consumer',
      '@ntars/ondra-zebra',
    ])
  })

  it('publishes on-demand catalog members before ondra without adding installed dependencies', () => {
    const ondra = member('apps/cli', '@ntars/ondra')
    const providers = ON_DEMAND_BUNDLES.map(name => member(`packages/subagent/${name}`, name))
    const plan = releaseFamily('ondra').publishOrder([ondra, ...providers])
    expect(plan.order.map(entry => entry.name)).toEqual([...ON_DEMAND_BUNDLES, ondra.name])
    expect(ondra.manifest).toEqual({})
    expect(plan.droppedPeerEdges).toEqual([])
  })

  it('rejects an advertised provider missing from the public release family', () => {
    expect(() => releaseFamily('ondra').publishOrder([member('apps/cli', '@ntars/ondra')]))
      .toThrow('Official catalog prerequisite')
  })

  it('keeps catalog prerequisites ahead of a ondra peer declaration', () => {
    const ondra = member('apps/cli', '@ntars/ondra')
    const providers = ON_DEMAND_BUNDLES.map(name => member(`packages/subagent/${name}`, name, {
      peerDependencies: { '@ntars/ondra': 'workspace:*' },
    }))
    const plan = releaseFamily('ondra').publishOrder([ondra, ...providers])
    expect(plan.order.map(entry => entry.name)).toEqual([...ON_DEMAND_BUNDLES, ondra.name])
    expect(plan.droppedPeerEdges).toEqual(ON_DEMAND_BUNDLES.map(name => ({ consumer: name, peer: ondra.name })))
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'])(
    'requires exact packed Ondra %s while preserving external ranges', (section) => {
      const pkg = member('packages/example/provider', '@ntars/ondra-provider')
      const family = releaseFamily('ondra')
      const manifest = { name: pkg.name, version: pkg.version, [section]: { '@ntars/ondra-tools': pkg.version, external: '^4.0.0' } }
      expect(() => { family.validatePackedManifest(pkg, manifest) }).not.toThrow()
      for (const range of ['workspace:*', '^0.0.1', '~0.0.1', '0.0.2', '*']) {
        expect(() => { family.validatePackedManifest(pkg, { ...manifest, [section]: { '@ntars/ondra-tools': range } }) })
          .toThrow(`packed ${section}.@ntars/ondra-tools must equal`)
      }
    },
  )

  it('checks packed identities and preserves independent vendor versions', () => {
    const pkg = member('vendor/example', '@ntars/example')
    const family = releaseFamily('vendor')
    expect(() => { family.validatePackedManifest(pkg, { name: pkg.name, version: pkg.version, dependencies: { '@ntars/ondra-tools': '^4.0.0' } }) })
      .not.toThrow()
    expect(() => { family.validatePackedManifest(pkg, { name: '@ntars/other', version: pkg.version }) }).toThrow('packed identity')
    expect(() => { family.validatePackedManifest(pkg, { name: pkg.name, version: '0.0.2' }) }).toThrow('packed identity')
  })

  it('reports a runtime dependency cycle instead of emitting an arbitrary order', () => {
    const ondra = releaseFamily('ondra')
    const members = [
      member('packages/a/left', '@ntars/ondra-left', { dependencies: { '@ntars/ondra-right': 'workspace:^' } }),
      member('packages/a/right', '@ntars/ondra-right', { dependencies: { '@ntars/ondra-left': 'workspace:^' } }),
    ]

    expect(() => { ondra.publishOrder(members) }).toThrow(/dependency cycle/)
  })

  it('publishes a peer before its consumer', () => {
    const ondra = releaseFamily('ondra')
    const members = [
      member('packages/a/consumer', '@ntars/ondra-consumer', { peerDependencies: { '@ntars/ondra-zebra': 'workspace:^' } }),
      member('packages/a/zebra', '@ntars/ondra-zebra'),
    ]

    // Name order alone would place the consumer first; the peer edge moves it.
    expect(ondra.publishOrder(members).order.map(entry => entry.name)).toEqual([
      '@ntars/ondra-zebra',
      '@ntars/ondra-consumer',
    ])
  })

  it('orders around a peer cycle rather than refusing to publish, and reports the edge it dropped', () => {
    const ondra = releaseFamily('ondra')
    const members = [
      member('packages/a/left', '@ntars/ondra-left', { peerDependencies: { '@ntars/ondra-right': 'workspace:^' } }),
      member('packages/a/right', '@ntars/ondra-right', { peerDependencies: { '@ntars/ondra-left': 'workspace:^' } }),
    ]

    // Sibling packages declare each other as peers, and npm treats an unmet peer
    // as a warning, so this pair has to publish rather than fail the release.
    const plan = ondra.publishOrder(members)
    expect(plan.order.map(entry => entry.name)).toEqual([
      '@ntars/ondra-right',
      '@ntars/ondra-left',
    ])
    // One of the two edges has to give, and which one it is belongs in the log.
    expect(plan.droppedPeerEdges).toEqual([
      { consumer: '@ntars/ondra-right', peer: '@ntars/ondra-left' },
    ])
  })

  it('honours an install edge even when a peer cycle surrounds it', () => {
    const ondra = releaseFamily('ondra')
    const members = [
      member('packages/a/base', '@ntars/ondra-base', { peerDependencies: { '@ntars/ondra-consumer': 'workspace:^' } }),
      member('packages/a/consumer', '@ntars/ondra-consumer', {
        dependencies: { '@ntars/ondra-base': 'workspace:^' },
        peerDependencies: { '@ntars/ondra-base': 'workspace:^' },
      }),
    ]

    // The install edge is absolute: base publishes first, and the peer edge that
    // would reverse it is the one dropped.
    const plan = ondra.publishOrder(members)
    expect(plan.order.map(entry => entry.name)).toEqual([
      '@ntars/ondra-base',
      '@ntars/ondra-consumer',
    ])
    expect(plan.droppedPeerEdges).toEqual([
      { consumer: '@ntars/ondra-base', peer: '@ntars/ondra-consumer' },
    ])
  })

  it('refuses an order that would publish a consumer before a dependency it installs', () => {
    const ondra = releaseFamily('ondra')
    const members = [
      member('packages/a/alpha', '@ntars/ondra-alpha', { peerDependencies: { '@ntars/ondra-bravo': 'workspace:^' } }),
      member('packages/a/bravo', '@ntars/ondra-bravo', { peerDependencies: { '@ntars/ondra-charlie': 'workspace:^' } }),
      member('packages/a/charlie', '@ntars/ondra-charlie', { dependencies: { '@ntars/ondra-alpha': 'workspace:^' } }),
    ]

    // A cycle of two peer edges closed by one install edge: dropping a peer edge
    // would order this, and the traversal drops the install edge instead. That
    // order would publish charlie before the alpha it installs, so it is refused
    // here rather than published.
    expect(() => { ondra.publishOrder(members) }).toThrow(/no publish order honours @ntars\/ondra-charlie -> @ntars\/ondra-alpha/)
  })

  it('ignores devDependencies when ordering', () => {
    const ondra = releaseFamily('ondra')
    const members = [
      member('packages/a/alpha', '@ntars/ondra-alpha', { devDependencies: { '@ntars/ondra-zebra': 'workspace:^' } }),
      member('packages/a/zebra', '@ntars/ondra-zebra'),
    ]

    // A dev dependency is absent from the published package, so it must not move
    // the consumer behind it.
    expect(ondra.publishOrder(members).order.map(entry => entry.name)).toEqual([
      '@ntars/ondra-alpha',
      '@ntars/ondra-zebra',
    ])
  })

  it('applies the harness payload policy to ondra and keeps upstream payloads for vendored packages', () => {
    const ondra = releaseFamily('ondra')
    const vendor = releaseFamily('vendor')
    const harness = member('packages/a/library', '@ntars/ondra-library')
    const vendored = member('vendor/cordis', '@ntars/cordis')

    expect(() => { ondra.validatePayload(harness, ['package/lib/index.js', 'package/src/index.ts']) })
      .toThrow(/publishes source file/)
    expect(() => { vendor.validatePayload(vendored, ['package/lib/index.js', 'package/src/index.ts']) }).not.toThrow()
    expect(() => { vendor.validatePayload(vendored, []) }).toThrow(/empty tarball/)
  })

  it('drives the installed entry only for the family that publishes one', () => {
    expect(releaseFamily('ondra').installedEntry).toEqual({ packageName: '@ntars/ondra', binPath: 'lib/bin.js' })
    expect(releaseFamily('vendor').installedEntry).toBeUndefined()
  })

  it('rejects an unknown family identifier', () => {
    expect(() => { releaseFamily('native') }).toThrow(/unknown release family/)
  })
})

describe('vendored version baseline', () => {
  it('drops an upstream prerelease segment and increments the patch', () => {
    expect(nextVendorVersion('4.0.0-rc.7', undefined)).toBe('4.0.1')
    expect(nextVendorVersion('1.0.0-rc.5', undefined)).toBe('1.0.1')
    expect(nextVendorVersion('1.8.1', undefined)).toBe('1.8.2')
  })

  it('increments from the last published version when a re-sync restored a lower one', () => {
    // Upstream moved rc.7 -> rc.8 after this repository published 4.0.1;
    // incrementing the manifest alone would name 4.0.1 a second time.
    expect(nextVendorVersion('4.0.0-rc.8', '4.0.1')).toBe('4.0.2')
    expect(nextVendorVersion('4.1.0', '4.0.1')).toBe('4.1.1')
  })

  it('appends a rehearsal prerelease without consuming its release numbers', () => {
    // A rehearsal burns 4.0.1-rc.1 and leaves 4.0.1 free, so the stable release
    // that follows takes those same numbers instead of skipping to 4.0.2.
    expect(nextVendorVersion('4.0.0-rc.7', undefined, 'rc.1')).toBe('4.0.1-rc.1')
    expect(nextVendorVersion('4.0.0-rc.7', '4.0.1-rc.1', 'rc.2')).toBe('4.0.1-rc.2')
    expect(nextVendorVersion('4.0.0-rc.7', '4.0.1-rc.1')).toBe('4.0.1')
    expect(nextVendorVersion('4.0.0-rc.7', '4.0.1')).toBe('4.0.2')
  })
})

describe('version precedence', () => {
  it('orders alpha, canary, and release-candidate versions by semver precedence', () => {
    expect(compareVersions('4.0.1-alpha.1', '4.0.1-canary.1')).toBeLessThan(0)
    expect(compareVersions('4.0.1-canary.1', '4.0.1-rc.1')).toBeLessThan(0)
    expect(compareVersions('4.0.1-rc.1', '4.0.1')).toBeLessThan(0)
  })

  it('ranks a release above the prerelease it follows', () => {
    // git --sort=v:refname disagrees, placing 4.0.1-rc.1 above 4.0.1, which is
    // why the newest published version is chosen here rather than by git.
    expect(compareVersions('4.0.1', '4.0.1-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('4.0.1-rc.1', '4.0.1')).toBeLessThan(0)
  })

  it('compares numeric prerelease fields numerically', () => {
    expect(compareVersions('4.0.1-rc.10', '4.0.1-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('4.0.1-rc.2', '4.0.1-rc.10')).toBeLessThan(0)
  })

  it('ranks a numeric field below an alphanumeric one, and a shorter list below a longer', () => {
    expect(compareVersions('4.0.1-1', '4.0.1-alpha')).toBeLessThan(0)
    expect(compareVersions('4.0.1-rc', '4.0.1-rc.1')).toBeLessThan(0)
    expect(compareVersions('4.0.2', '4.0.1')).toBeGreaterThan(0)
    expect(compareVersions('4.0.1-rc.1', '4.0.1-rc.1')).toBe(0)
  })
})

describe('payload change judgement', () => {
  const sourceShipping = member('vendor/cosmokit', '@ntars/cosmokit', {
    files: ['lib/index.js', 'lib/types/**/*.d.ts', 'src'],
  })
  const buildOutputOnly = member('vendor/cordis', '@ntars/cordis', {
    files: ['lib/index.js', 'lib/types/**/*.d.ts', 'bin.js'],
  })

  it('counts the manifest and the files npm always publishes', () => {
    expect(reachesPayload(sourceShipping, 'vendor/cosmokit/package.json')).toBe(true)
    expect(reachesPayload(sourceShipping, 'vendor/cosmokit/README.md')).toBe(true)
    expect(reachesPayload(sourceShipping, 'vendor/cosmokit/src/index.ts')).toBe(true)
  })

  it('counts build inputs for a package whose payload is build output', () => {
    // cordis publishes lib/ only, and lib/ is not tracked: without this, a real
    // source change reads as "nothing changed" and the next publish fails on a
    // version whose bytes moved.
    expect(reachesPayload(buildOutputOnly, 'vendor/cordis/src/context.ts')).toBe(true)
    expect(reachesPayload(buildOutputOnly, 'vendor/cordis/tsconfig.json')).toBe(true)
  })

  it('ignores paths no tarball carries', () => {
    expect(reachesPayload(sourceShipping, 'vendor/cosmokit/tests/unit.spec.ts')).toBe(false)
    expect(reachesPayload(sourceShipping, 'vendor/cosmokit/CHANGELOG.md')).toBe(false)
    // The README pattern is deliberately loose: over-reporting a change costs one
    // unnecessary patch bump, while under-reporting fails the next publish on a
    // version whose bytes moved.
    expect(reachesPayload(sourceShipping, 'vendor/cosmokit/README.i18n.yaml')).toBe(true)
    expect(reachesPayload(member('packages/a/library', '@ntars/ondra-library', { files: ['lib/index.js'] }),
      'packages/a/library/tests/library.spec.ts')).toBe(false)
  })
})
