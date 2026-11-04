/** Desktop-only omissions from already installed production npm packages. */

/**
 * Identify build, diagnostic and other-platform files omitted from the immutable Desktop runtime.
 * Unrecognized assets and target runtime binaries are retained. Paths name the copied
 * node_modules tree, including nested package containers.
 * @param path - Path relative to the production node_modules directory.
 * @param target - Platform and architecture of the Electron Node runtime.
 * @param officeEngine - Engine selected from the installed kit manifest.
 * @returns Omission reason, or undefined when the entry must be copied.
 */
export function desktopRuntimeFileExclusion(
  path: string, target: { platform: NodeJS.Platform; arch: string }, officeEngine: string,
): string | undefined {
  const parts = path.split(/[\\/]/u)
  if (parts.some(part => ['.bin', '.pnpm', '.modules.yaml', '.pnpm-workspace-state-v1.json'].includes(part))) {
    return 'package-manager metadata'
  }
  const file = parts.at(-1)!
  if (/\.(?:[cm]?[jt]s|css)\.map$/u.test(file)) return 'source map'
  if (/\.d\.[cm]?ts$/u.test(file)) return 'TypeScript declaration'
  if (/\.tsbuildinfo$/u.test(file)) return 'TypeScript build cache'
  // TypeScript source inside a published package is input to a build that has
  // already happened: every entry point resolves through `lib/` (the packages
  // declare `main: lib/index.js` and `exports[.].default`), so nothing imports
  // these files at runtime. They used to ride along — 43 MB of them — while
  // the `.d.ts` declarations they belong to were already excluded above.
  if (/\.ts$/u.test(file) && parts.includes('src')) return 'TypeScript source'
  // Package documentation: README/CHANGELOG/HISTORY and the rest travel with a
  // published package and nobody opens them from the app — 10 MB of prose across
  // the dependency tree. Licences and notices stay: they are an obligation, not
  // documentation.
  if (/\.(?:md|markdown)$/iu.test(file) && !/^(?:licen[cs]e|notice|copying)/iu.test(file)) {
    return 'package documentation'
  }
  // Test trees are development input too — but only their CODE. A package may
  // ship a `test/` directory holding data a runtime path reads (domino ships
  // fixtures there), so the exclusion is narrowed to the source-ish
  // extensions a test suite is written in rather than the whole directory.
  if (parts.slice(0, -1).some(part => part === 'test' || part === 'tests' || part === '__tests__')
    && /\.(?:[cm]?[jt]sx?)$/u.test(file)) {
    return 'test sources'
  }
  const packageParts = parts.slice(parts.lastIndexOf('node_modules') + 1)
  const nameParts = packageParts[0]?.startsWith('@') ? 2 : 1
  const name = packageParts.slice(0, nameParts).join('/')
  const entry = packageParts.slice(nameParts).join('/')
  if (name.startsWith('@deepseek-ai/libreoffice-kit-')) {
    if (name !== `@deepseek-ai/libreoffice-kit-${officeEngine}`) return 'LibreOffice other platform'
  }
  if (name === 'fs-ext' && /^build\/(?:Release|Debug)\/(?:obj(?:\/|$)|fs_ext\.(?:exp|lib|pdb|iobj|ipdb)$)/u.test(entry)) {
    return 'fs-ext compiler output'
  }
  if (name === 'fs-ext' && /^build\/(?:binding\.sln|config\.gypi|fs_ext\.vcxproj(?:\.filters)?)$/u.test(entry)) {
    return 'fs-ext build configuration'
  }
  if (name === '@mixmark-io/domino' && (entry === 'test' || entry.startsWith('test/'))) return 'Domino test fixtures'
  if (name === '@mixmark-io/domino' && (entry === '.yarn' || entry.startsWith('.yarn/'))) return 'Domino development tooling'
  if (name === 'node-pty' && target.platform !== 'win32' && /^third_party\/conpty(?:\/|$)/u.test(entry)) {
    return 'node-pty Windows ConPTY sources'
  }
  if (name === 'node-pty' && entry.startsWith('prebuilds/')) {
    const platform = packageParts[nameParts + 1]
    if (platform !== undefined && platform !== `${target.platform}-${target.arch}`) return 'node-pty other platform'
    if (file.endsWith('.pdb')) return 'node-pty debug symbols'
  }
  if (name === '@koromix/koffi-win32-x64' && entry === 'win32_x64/koffi.lib') return 'Koffi import library'
  return undefined
}
