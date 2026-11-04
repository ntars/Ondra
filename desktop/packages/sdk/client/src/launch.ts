/**
 * Resolve the public SDK launch configuration to one ondra subprocess.
 * @module @ntars/ondra-sdk-client/launch
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HarnessClientOptions } from './types.ts'

/** Default bound for a profile to answer the SDK initialize handshake. */
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000

/** Internal generic process launch used by the transport and fake-runtime tests. */
export interface RuntimeProcessOptions {
  command: string
  args: string[]
  cwd?: string
  /** Materialize the complete child environment when the client starts its subprocess. */
  environment: () => NodeJS.ProcessEnv
  description: string
  initializeTimeoutMs: number
  requestTimeoutMs?: number
  shutdownTimeoutMs?: number
  disposeEofGraceMs?: number
  disposeGraceMs?: number
}

/** Node argv plus internal profile patches required by one resolved ondra entry. */
export interface OndraNodeLaunch {
  /** Arguments before the profile selector. */
  nodeArgs: string[]
  /** Internal patches applied below caller-supplied patches. */
  patches: string[]
  /** Environment values required by the resolved entry mode. */
  environment: NodeJS.ProcessEnv
}

interface PackageManifest {
  version?: unknown
  bin?: unknown
}

/** Read a package manifest from one resolved package.json URL. */
function manifest(url: string): PackageManifest {
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as PackageManifest
}

/**
 * Resolve and version-check a ondra executable from package manifests.
 * @param ondraManifestUrl - resolved URL of the ondra package manifest.
 * @param clientManifestUrl - resolved URL of the SDK client manifest.
 * @returns the absolute ondra executable path.
 */
export function resolveOndraBinFromManifests(ondraManifestUrl: string, clientManifestUrl: string): string {
  const ondraManifest = manifest(ondraManifestUrl)
  const clientManifest = manifest(clientManifestUrl)
  if (typeof ondraManifest.version !== 'string' || ondraManifest.version !== clientManifest.version) {
    throw new Error(`ondra SDK client ${String(clientManifest.version)} requires the same ondra version, got ${String(ondraManifest.version)}`)
  }
  const bin = typeof ondraManifest.bin === 'object' && ondraManifest.bin !== null
    ? (ondraManifest.bin as Record<string, unknown>).ondra
    : ondraManifest.bin
  if (typeof bin !== 'string' || bin === '') throw new Error('@ntars/ondra declares no ondra executable')
  return resolve(dirname(fileURLToPath(ondraManifestUrl)), bin)
}

/**
 * Resolve and version-check the built ondra executable installed with this SDK.
 * @returns the absolute built executable path, whether or not it exists in a source checkout.
 */
export function installedOndraBin(): string {
  return resolveOndraBinFromManifests(
    import.meta.resolve('@ntars/ondra/package.json'),
    new URL('../package.json', import.meta.url).href,
  )
}

/**
 * Resolve the Node launch for one same-version ondra package.
 * @param ondraManifestUrl - resolved URL of the ondra package manifest.
 * @param clientManifestUrl - resolved URL of the SDK client manifest.
 * @param sourceLoaderUrl - optional absolute tsx loader URL for deterministic tests.
 * @returns built output, or the source entry plus its compatibility patch and tsx environment.
 */
export function resolveOndraNodeLaunchFromManifests(
  ondraManifestUrl: string,
  clientManifestUrl: string,
  sourceLoaderUrl?: string,
): OndraNodeLaunch {
  const bin = resolveOndraBinFromManifests(ondraManifestUrl, clientManifestUrl)
  if (existsSync(bin)) return { nodeArgs: [bin], patches: [], environment: {} }

  const packageDir = dirname(fileURLToPath(ondraManifestUrl))
  const sourceBin = resolve(packageDir, 'src/bin.ts')
  const sourcePatch = resolve(packageDir, 'src/sdk-source.cordis.patch.yml')
  const sourceTsconfig = resolve(packageDir, 'tsconfig.json')
  if (!existsSync(sourceBin) || !existsSync(sourcePatch) || !existsSync(sourceTsconfig)) {
    throw new Error(
      `@ntars/ondra is missing its built executable ${bin} and complete source launch files ${sourceBin}, ${sourcePatch}, ${sourceTsconfig}`,
    )
  }
  const loader = sourceLoaderUrl ?? import.meta.resolve('tsx/esm')
  return {
    nodeArgs: ['--import', loader, sourceBin],
    patches: [sourcePatch],
    environment: { TSX_TSCONFIG_PATH: sourceTsconfig },
  }
}

/**
 * Resolve the installed ondra package to a built or source Node launch.
 * @returns the launch descriptor for the current checkout or installed package.
 */
function installedOndraNodeLaunch(): OndraNodeLaunch {
  return resolveOndraNodeLaunchFromManifests(
    import.meta.resolve('@ntars/ondra/package.json'),
    new URL('../package.json', import.meta.url).href,
  )
}

/**
 * Resolve caller-relative filesystem inputs and construct canonical ondra argv.
 * @param options - public SDK launch options.
 * @param callerCwd - parent-process directory used for lexical resolution.
 * @returns one generic subprocess spec for the JSON-RPC transport.
 */
export function resolveOndraLaunch(
  options: HarnessClientOptions = {},
  callerCwd: string = process.cwd(),
): RuntimeProcessOptions {
  const profile = options.profile ?? 'sdk'
  const ondraLaunch = options.ondraBin === undefined
    ? installedOndraNodeLaunch()
    : { nodeArgs: [resolve(callerCwd, options.ondraBin)], patches: [], environment: {} }
  const patches = [
    ...ondraLaunch.patches,
    ...(options.patches ?? []).map(path => resolve(callerCwd, path)),
  ]
  const ondraHome = options.ondraHome === undefined ? undefined : resolve(callerCwd, options.ondraHome)
  return {
    command: process.execPath,
    args: [...ondraLaunch.nodeArgs, '--profile', profile, ...patches.flatMap(path => ['--patch', path])],
    ...options.processCwd === undefined ? {} : { cwd: resolve(callerCwd, options.processCwd) },
    environment: () => ({
      ...(options.env ?? process.env),
      ...ondraLaunch.environment,
      ...ondraHome === undefined ? {} : { ONDRA_HOME: ondraHome },
    }),
    description: `ondra profile ${JSON.stringify(profile)}`,
    initializeTimeoutMs: options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
    ...options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs },
    ...options.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: options.shutdownTimeoutMs },
    ...options.disposeEofGraceMs === undefined ? {} : { disposeEofGraceMs: options.disposeEofGraceMs },
    ...options.disposeGraceMs === undefined ? {} : { disposeGraceMs: options.disposeGraceMs },
  }
}
