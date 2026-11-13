/**
 * 九步流水线。
 *
 * ## 九步是怎么来的
 *
 * 手册**没有**给出九步的名称与顺序（全文「九步流水线」只出现在 master-plan §5 与台账，
 * 都没展开）。所以这九步是从三条可引用的话反推的，每一步在 `STEP_DECLS[].source` 里
 * 带出处；反推的那一步（`conflict`）明确标「反推」，不假称手册给过。
 *
 * ## 为什么「先验后写」
 *
 * `verify` 必须排在 `install` 之前。反过来的坏形态：先把 256 MB 写进目标目录，
 * 再发现哈希不对——此时目标目录已经脏了，而「回滚」要么删用户原有文件（不可逆），
 * 要么留着坏文件（下次启动炸在更远的地方）。所以**哈希不通过，一个字节都不落盘**。
 *
 * ## 为什么覆盖要单独一步
 *
 * `conflict` 挡的不是「升级」，是「覆盖一个不是我装的东西」。判据用**账本**：
 * 账本里有这条路径 = 是我装的 → 允许覆盖（升级/重装都走这条）；
 * 账本里没有而目标位置有同名文件 = **别人的东西** → 默认拒绝。
 *
 * 少了这一步，第一次在一个已有 `runtime/` 的目录里跑安装器，会把别人的运行时
 * 悄悄换掉，而日志里全是「安装成功」。
 *
 * ## 每一步都不抛
 *
 * 流水线跑在用户点「安装」的那一刻。抛一个错会让进度条卡在某个百分比，
 * 而人看到的是「装到一半没动静了」。所以异常一律折成 `failed` + `findings`。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Config } from './settings.js'
import type {
  BootstrapLedger,
  BootstrapReport,
  ComponentSource,
  ComponentSpec,
  FileSink,
  InstallRun,
  LedgerComponent,
  LogLike,
  ManifestIssue,
  RunVerdict,
  RuntimeProbe,
  StepId,
  StepResult,
  StepStatus,
} from './types.js'
import { emptyLedger, findComponent, upsert } from './ledger.js'
import { hashFile, isSha256Hex } from './hash.js'
import { parseManifest } from './manifest.js'

/** 一条步骤声明。 */
export interface StepDecl {
  readonly id: StepId
  readonly title: string
  readonly source: string
}

/**
 * 九步声明。
 *
 * 顺序有依赖：前一步不过，后一步不跑（`runPipeline` 保证）。
 */
export const STEP_DECLS: readonly StepDecl[] = Object.freeze([
  Object.freeze({
    id: 'preflight' as const,
    title: '环境预检',
    source: '手册 §6.4「一键部署四件套：检查 Node≥20」',
  }),
  Object.freeze({
    id: 'manifest' as const,
    title: '清单解析',
    source: '手册 §4.6「`components` 嵌套」+「每组件独立 sha256」',
  }),
  Object.freeze({
    id: 'source' as const,
    title: '定位组件',
    source: '手册 §4.6「每组件独立 sha256」（没有一份真实文件，哈希无从谈起）',
  }),
  Object.freeze({
    id: 'verify' as const,
    title: '逐组件校验哈希',
    source: '手册 §4.6「每组件独立 sha256」——逐组件，不是整包一个哈希',
  }),
  Object.freeze({
    id: 'reuse' as const,
    title: '复用已装',
    source: '手册 §4.6「记账本」——有账才谈得上「装过了」；幂等属 master-plan §14.4「稳定优先」',
  }),
  Object.freeze({
    id: 'conflict' as const,
    title: '覆盖冲突',
    source: '**反推**（手册无出处）：账本里没有、目标位置有同名文件 = 别人的东西，默认不覆盖',
  }),
  Object.freeze({
    id: 'install' as const,
    title: '落盘',
    source: '手册 §4.6；验收口径见 §6.4「正在准备运行环境 → 安装完成，已就绪」',
  }),
  Object.freeze({
    id: 'ledger' as const,
    title: '记账',
    source: '手册 §4.6「`.ondra-bootstrap.json` 记账」',
  }),
  Object.freeze({
    id: 'self-check' as const,
    title: 'bootstrap-ok 自检',
    source: '手册 §4.6「`bootstrap-ok` 自检」',
  }),
])

/** 流水线依赖。 */
export interface PipelineDeps {
  readonly settings: Config
  readonly dryRun: boolean
  readonly log: LogLike
  readonly now: () => number
  readonly source: ComponentSource | null
  readonly sink: FileSink | null
  readonly runtime: RuntimeProbe | null
  /** 现取账本。 */
  readonly ledger: () => BootstrapLedger | undefined
  /** 存账本（失败只记日志，不抛）。 */
  readonly save: (ledger: BootstrapLedger) => void
  /** 跑一次 `bootstrap-ok`（由 service 给，避免 steps 与 service 互相 import）。 */
  readonly verify: () => Promise<BootstrapReport>
}

/** 跨步骤状态。 */
interface State {
  components: readonly ComponentSpec[]
  digest: string
  /** 组件路径 → 来源绝对路径。 */
  srcPath: Map<string, string>
  /** 组件路径 → 字节数。 */
  sizes: Map<string, number>
  /** 已判定可复用的组件路径。 */
  reused: Set<string>
  /** 待安装的组件。 */
  toInstall: ComponentSpec[]
  /** 本轮真正落盘的路径。 */
  installed: string[]
  /** 失败或被挡的路径。 */
  failed: string[]
}

/** 把异常折成一句文本。 */
function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 造一条结果。 */
function result(
  id: StepId,
  status: StepStatus,
  detail: string,
  findings?: readonly string[],
  hints?: string[],
): StepResult {
  const decl = STEP_DECLS.find(item => item.id === id)
  const merged = [...(findings ?? []), ...(hints ?? [])]
  return Object.freeze({
    id,
    title: decl?.title ?? id,
    status,
    detail,
    findings: Object.freeze(merged),
    source: decl?.source ?? '',
  })
}

/**
 * 目标绝对路径。
 *
 * 只取 `basename(file)`：`file` 里的子目录是**来源侧**的摆放（`vendor/runtime.tgz`），
 * 不是目标侧的。目标侧的层级由 `dest` 决定，两者分开才不会装出一棵多余的 `vendor/`。
 * @param settings 配置。
 * @param comp 组件。
 */
export function destPathOf(settings: Config, comp: ComponentSpec): string {
  return join(settings.destDir, comp.dest ?? '', basename(comp.file))
}

/** 路径存在且是目录？ */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** 字节数；取不到返回 `null`。 */
function sizeOf(path: string): number | null {
  try {
    const info = statSync(path)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

/** 问题列表 → 人话（最多 12 条，其余折成一句）。 */
function issuesToFindings(issues: readonly ManifestIssue[]): readonly string[] {
  const shown = issues.slice(0, 12).map(item => `${item.path === '' ? '根' : item.path}：${item.message}`)
  if (issues.length > shown.length) shown.push(`另有 ${String(issues.length - shown.length)} 条同类问题`)
  return shown
}

/** 记一条账。 */
function record(deps: PipelineDeps, entry: LedgerComponent): void {
  const current = deps.ledger() ?? emptyLedger()
  deps.save(upsert(current, entry))
}

/**
 * 跑一轮。
 * @param deps 依赖。
 */
export async function runPipeline(deps: PipelineDeps): Promise<InstallRun> {
  const startedAt = deps.now()
  const state: State = {
    components: Object.freeze([]),
    digest: '',
    srcPath: new Map<string, string>(),
    sizes: new Map<string, number>(),
    reused: new Set<string>(),
    toInstall: [],
    installed: [],
    failed: [],
  }

  const steps: StepResult[] = []
  let halted: StepId | undefined

  for (const decl of STEP_DECLS) {
    if (halted !== undefined) {
      steps.push(
        result(decl.id, 'skipped', `前一步没通过（${halted}），本步不跑`, [], [
          '先把上一步报的问题处理掉，再重跑',
        ]),
      )
      continue
    }
    let one: StepResult
    try {
      one = await runStep(decl.id, deps, state)
    } catch (error) {
      // 任何一步自己崩掉都不该把流水线撕成两半。
      const path = state.components.length > 0 ? '（已解析的组件）' : '（清单）'
      one = result(decl.id, 'failed', `这一步自己出错了：${textOf(error)}`, [path])
    }
    steps.push(one)
    // 失败与阻塞是故障信号，不受 `verbose` 约束；只有「成功做完一步」属于过程噪声。
    if (one.status === 'failed' || one.status === 'blocked' || deps.settings.verbose) {
      deps.log.info('[%s] %s → %s：%s', decl.id, one.title, one.status, one.detail)
    }
    if (one.status === 'failed' || one.status === 'blocked') halted = decl.id
  }

  const anyBlocked = steps.some(item => item.status === 'blocked')
  const anyFailed = steps.some(item => item.status === 'failed')
  const verdict: RunVerdict = anyBlocked ? 'blocked' : anyFailed ? 'failed' : 'ok'

  return Object.freeze({
    dryRun: deps.dryRun,
    startedAt,
    finishedAt: deps.now(),
    steps: Object.freeze(steps),
    verdict,
    installed: Object.freeze([...state.installed]),
    reused: Object.freeze([...state.reused]),
    failed: Object.freeze([...state.failed]),
  })
}

/**
 * 跑一步。
 * @param id 步骤 id。
 * @param deps 依赖。
 * @param state 跨步骤状态。
 */
async function runStep(id: StepId, deps: PipelineDeps, state: State): Promise<StepResult> {
  switch (id) {
    case 'preflight':
      return stepPreflight(deps)
    case 'manifest':
      return stepManifest(deps, state)
    case 'source':
      return stepSource(deps, state)
    case 'verify':
      return stepVerify(state)
    case 'reuse':
      return stepReuse(deps, state)
    case 'conflict':
      return stepConflict(deps, state)
    case 'install':
      return stepInstall(deps, state)
    case 'ledger':
      return stepLedger(deps, state)
    case 'self-check':
      return stepSelfCheck(deps, state)
    default:
      return result(id, 'unsupported', '这一步本版没有实现')
  }
}

/** 1. 环境预检。 */
function stepPreflight(deps: PipelineDeps): StepResult {
  const version = deps.runtime?.nodeVersion() ?? process.versions.node
  const majorText = version.split('.')[0] ?? ''
  const major = Number.parseInt(majorText, 10)
  if (!Number.isFinite(major)) {
    return result('preflight', 'blocked', `读不出 Node 主版本（读到 "${version}"）`, [], [
      '检查 `process.versions.node` 是否被宿主改写',
    ])
  }
  if (major < 20) {
    return result('preflight', 'failed', `Node ${version} 太旧（需要 ≥20）`, [], [
      '升级 Node 到 20 或更高；旧版本没有本包依赖的 API',
    ])
  }
  const settings = deps.settings
  if (settings.destDir !== '' && existsSync(settings.destDir) && !isDirectory(settings.destDir)) {
    // 目标路径存在但不是目录：装不进去，早停比复制到一半再说清楚。
    return result('preflight', 'failed', `目标路径不是目录：${settings.destDir}`, [], [
      '把 `destDir` 改成一个目录；安装器不会删掉那个同名文件',
    ])
  }
  if (settings.destDir !== '' && !existsSync(settings.destDir)) {
    // 目标目录不存在是正常的（第一次装），安装时创建。
    deps.log.info('目标目录还不存在，安装时创建：%s', settings.destDir)
  }
  return result('preflight', 'ok', `Node ${version}（需 ≥20）${deps.dryRun ? '，演练模式' : ''}`)
}

/** 2. 清单解析。 */
function stepManifest(deps: PipelineDeps, state: State): StepResult {
  const file = deps.settings.manifestPath
  if (file === '') {
    return result('manifest', 'blocked', '没配 `manifestPath`', [], [
      '把 `manifestPath` 指到安装包里的清单文件（绝对路径）',
    ])
  }

  let text: string
  try {
    text = readTextFile(file)
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code === 'ENOENT') {
      return result('manifest', 'blocked', `清单文件不存在：${file}`, [], ['确认安装包完整，或改 `manifestPath`'])
    }
    return result('manifest', 'failed', `清单读不出来：${textOf(error)}`)
  }

  const parsed = parseManifest(text, { maxComponents: deps.settings.maxComponents })
  if (!parsed.ok) {
    return result('manifest', 'failed', `清单有 ${String(parsed.issues.length)} 处问题，一步都不跑`, issuesToFindings(parsed.issues))
  }

  state.components = parsed.components
  state.digest = parsed.digest
  const bytes = parsed.components.length
  return result(
    'manifest',
    'ok',
    `${String(bytes)} 个组件，清单摘要 ${parsed.digest.slice(0, 12)}…`,
  )
}

/** 3. 定位组件。 */
function stepSource(deps: PipelineDeps, state: State): StepResult {
  if (deps.source === null) {
    return result('source', 'blocked', '没接来源端口', [], ['确认 O-079 的本地读端口建起来了'])
  }
  if (deps.settings.sourceDir === '') {
    return result('source', 'blocked', '没配 `sourceDir`', [], ['把 `sourceDir` 指到安装包解压出来的目录'])
  }

  const missing: string[] = []
  const tooBig: string[] = []
  const optionalSkipped: string[] = []
  let total = 0

  for (const comp of state.components) {
    const abs = deps.source.locate(comp.file)
    if (abs === null) {
      if (comp.optional) optionalSkipped.push(comp.path)
      else missing.push(`${comp.path} → 缺 ${comp.file}`)
      continue
    }
    const size = sizeOf(abs)
    if (size === null) {
      missing.push(`${comp.path} → ${comp.file} 不是普通文件`)
      continue
    }
    if (size > deps.settings.maxComponentBytes) {
      tooBig.push(
        `${comp.path} → ${String(size)} 字节，超过上限 ${String(deps.settings.maxComponentBytes)}`,
      )
      continue
    }
    state.srcPath.set(comp.path, abs)
    state.sizes.set(comp.path, size)
    total += size
  }

  const findings = [...missing, ...tooBig]
  const optionalNote = optionalSkipped.length > 0 ? `；可选缺 ${String(optionalSkipped.length)} 个` : ''
  if (findings.length > 0) {
    state.failed.push(...missing.map(item => item.split(' → ')[0] ?? item))
    return result(
      'source',
      'failed',
      `有 ${String(findings.length)} 个组件取不到`,
      findings,
      ['缺的文件属安装包不完整，不该跳过继续装'],
    )
  }
  return result(
    'source',
    'ok',
    `${String(state.srcPath.size)} 个组件就位（共 ${(total / 1024 / 1024).toFixed(1)} MB）${optionalNote}`,
  )
}

/** 4. 逐组件校验哈希。 */
async function stepVerify(state: State): Promise<StepResult> {
  const mismatched: string[] = []
  const unreadable: string[] = []
  let bytes = 0

  for (const comp of state.components) {
    const abs = state.srcPath.get(comp.path)
    if (abs === undefined) continue // 可选组件缺失，已在 source 步记过
    if (!isSha256Hex(comp.sha256)) {
      mismatched.push(`${comp.path} → 声明的哈希格式不对`)
      continue
    }
    let actual: string
    try {
      actual = await hashFile(abs)
    } catch (error) {
      unreadable.push(`${comp.path} → ${textOf(error)}`)
      continue
    }
    if (actual !== comp.sha256) {
      // 列全，不遇错即停：一次修完比分八次跑快。
      mismatched.push(`${comp.path} → 声明 ${comp.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`)
      continue
    }
    bytes += state.sizes.get(comp.path) ?? 0
  }

  if (mismatched.length > 0 || unreadable.length > 0) {
    state.failed.push(...mismatched.map(item => item.split(' → ')[0] ?? item))
    return result(
      'verify',
      'failed',
      `${String(mismatched.length + unreadable.length)} 个组件哈希对不上，**一个字节都没落盘**`,
      [...mismatched, ...unreadable],
      ['不要「先装上再说」：哈希不对说明来源被改过或安装包损坏'],
    )
  }
  return result(
    'verify',
    'ok',
    `${String(state.srcPath.size)} 个组件哈希全部一致（共 ${(bytes / 1024 / 1024).toFixed(1)} MB）`,
  )
}

/** 5. 复用已装。 */
async function stepReuse(deps: PipelineDeps, state: State): Promise<StepResult> {
  const ledger = deps.ledger()
  const sink = deps.sink
  let reused = 0

  for (const comp of state.components) {
    if (!state.srcPath.has(comp.path)) continue
    if (sink === null) {
      state.toInstall.push(comp)
      continue
    }
    const dest = destPathOf(deps.settings, comp)
    const entry = findComponent(ledger, comp.path)
    if (entry === undefined || entry.status !== 'installed' || entry.sha256 !== comp.sha256) {
      state.toInstall.push(comp)
      continue
    }
    if (!sink.exists(dest)) {
      state.toInstall.push(comp)
      continue
    }
    let actual: string
    try {
      actual = await hashFile(dest)
    } catch {
      state.toInstall.push(comp)
      continue
    }
    if (actual === comp.sha256) {
      state.reused.add(comp.path)
      reused += 1
    } else {
      // 账上说装了、文件却不是那个——按「要重装」处理，不静默信任账本。
      deps.log.warn('账本与文件不一致，将重装：%s', comp.path)
      state.toInstall.push(comp)
    }
  }

  return result(
    'reuse',
    'ok',
    `复用 ${String(reused)} 个，待装 ${String(state.toInstall.length)} 个`,
  )
}

/** 6. 覆盖冲突。 */
function stepConflict(deps: PipelineDeps, state: State): StepResult {
  const sink = deps.sink
  if (sink === null) {
    return result('conflict', 'blocked', '没接写端口，判不了目标位置')
  }

  const ledger = deps.ledger()
  const clashes: string[] = []
  for (const comp of state.toInstall) {
    const dest = destPathOf(deps.settings, comp)
    if (!sink.exists(dest)) continue
    // 账本里有这条路径 = 是我之前装的 → 允许覆盖（升级或重装）。
    if (findComponent(ledger, comp.path) !== undefined) continue
    if (deps.settings.allowOverwrite) continue
    clashes.push(`${comp.path} → ${dest} 已有文件，且账本里没有它`)
  }

  if (clashes.length > 0) {
    state.failed.push(...clashes.map(item => item.split(' → ')[0] ?? item))
    return result(
      'conflict',
      'failed',
      `${String(clashes.length)} 个目标位置已有「不是我装的」文件`,
      clashes,
      ['确认这些文件可以覆盖后再打开 `allowOverwrite`；默认拒绝是为了不删掉找不回来的东西'],
    )
  }
  return result('conflict', 'ok', `${String(state.toInstall.length)} 个待装位置没有冲突`)
}

/** 7. 落盘。 */
async function stepInstall(deps: PipelineDeps, state: State): Promise<StepResult> {
  if (deps.dryRun) {
    const total = state.toInstall.reduce((sum, comp) => sum + (state.sizes.get(comp.path) ?? 0), 0)
    return result(
      'install',
      'skipped',
      `演练：将写 ${String(state.toInstall.length)} 个文件到 ${deps.settings.destDir}（共 ${(total / 1024 / 1024).toFixed(1)} MB）`,
      [],
      ['关掉 `dryRun` 才会真落盘'],
    )
  }

  const sink = deps.sink
  if (sink === null) return result('install', 'blocked', '没接写端口')

  const failures: string[] = []
  let done = 0

  for (const comp of state.toInstall) {
    if (comp.kind === 'archive') {
      // 本版不引解压依赖（禁装依赖），所以如实报「不支持」，不假装解开。
      failures.push(`${comp.path} → 归档件本版不支持解压`)
      state.failed.push(comp.path)
      record(deps, {
        path: comp.path,
        ...(comp.version === undefined ? {} : { version: comp.version }),
        sha256: comp.sha256,
        file: comp.file,
        status: 'failed',
        at: deps.now(),
        error: '本版不支持解压归档件',
      })
      continue
    }

    const abs = state.srcPath.get(comp.path)
    if (abs === undefined) {
      failures.push(`${comp.path} → 来源丢了`)
      state.failed.push(comp.path)
      continue
    }

    const dest = destPathOf(deps.settings, comp)
    // 先记 `pending`：进程若在复制中途被杀，下次看到的是「装到一半」，而不是「没装过」。
    record(deps, {
      path: comp.path,
      ...(comp.version === undefined ? {} : { version: comp.version }),
      sha256: comp.sha256,
      file: comp.file,
      status: 'pending',
      at: deps.now(),
    })

    let temp: string | undefined
    try {
      sink.ensureDir(dirname(dest))
      temp = sink.writeTemp(dest, abs, comp.exec)
      if (deps.settings.verifyAfterCopy) {
        const copied = await hashFile(temp)
        if (copied !== comp.sha256) {
          // 不在里层删：`catch` 统一删临时文件，两处各删一次会让「删失败」的日志出现两遍。
          throw new Error('落盘后哈希不一致（磁盘写坏了，或复制被截断）')
        }
      }
      sink.commit(temp, dest)
      const bytes = state.sizes.get(comp.path) ?? 0
      record(deps, {
        path: comp.path,
        ...(comp.version === undefined ? {} : { version: comp.version }),
        sha256: comp.sha256,
        file: comp.file,
        status: 'installed',
        at: deps.now(),
        bytes,
      })
      state.installed.push(comp.path)
      done += 1
    } catch (error) {
      if (temp !== undefined) {
        try {
          sink.remove(temp)
        } catch {
          // 临时文件删不掉不影响正确性。
        }
      }
      failures.push(`${comp.path} → ${textOf(error)}`)
      state.failed.push(comp.path)
      record(deps, {
        path: comp.path,
        ...(comp.version === undefined ? {} : { version: comp.version }),
        sha256: comp.sha256,
        file: comp.file,
        status: 'failed',
        at: deps.now(),
        error: textOf(error),
      })
    }
  }

  if (failures.length > 0) {
    return result('install', 'failed', `装了 ${String(done)} 个，失败 ${String(failures.length)} 个`, failures, [
      '已装成功的文件保留不动：本包**不自动回滚**，回滚属 O-009 快照还原',
    ])
  }
  return result('install', 'ok', `${String(done)} 个组件已落盘到 ${deps.settings.destDir}`)
}

/** 8. 记账。 */
function stepLedger(deps: PipelineDeps, state: State): StepResult {
  if (deps.dryRun) {
    return result('ledger', 'skipped', '演练：不写账本（写了就等于宣布装过）', [], [
      '关掉 `dryRun` 才会真记账',
    ])
  }
  if (state.failed.length > 0) {
    return result(
      'ledger',
      'failed',
      `有 ${String(state.failed.length)} 个组件没装成，**不写 \`bootstrapAt\`**——写下去等于宣布装完了`,
      state.failed.slice(0, 12),
    )
  }

  const current = deps.ledger() ?? emptyLedger()
  const next = Object.freeze({
    ...current,
    manifestSha256: state.digest,
    bootstrapAt: deps.now(),
    components: current.components,
  })
  deps.save(next)

  const total = next.components.length
  return result(
    'ledger',
    'ok',
    `账本已写：${String(total)} 条（复用 ${String(state.reused.size)}，新装 ${String(state.installed.length)}），摘要 ${state.digest.slice(0, 12)}…`,
  )
}

/** 9. `bootstrap-ok` 自检。 */
async function stepSelfCheck(deps: PipelineDeps, state: State): Promise<StepResult> {
  if (deps.dryRun) {
    return result('self-check', 'skipped', '演练：没写盘也没记账，`bootstrap-ok` 无从验起')
  }
  let report: BootstrapReport
  try {
    report = await deps.verify()
  } catch (error) {
    return result('self-check', 'unsupported', `自检自己出错了：${textOf(error)}`)
  }

  const bad = report.checks.filter(item => item.verdict === 'fail')
  const unable = report.checks.filter(item => item.verdict === 'unverifiable')

  if (report.bootstrapOk === true) {
    return result('self-check', 'ok', `bootstrap-ok 全过（${String(report.checks.length)} 项）`)
  }
  if (report.bootstrapOk === false) {
    return result(
      'self-check',
      'failed',
      `bootstrap-ok 不过：${String(bad.length)} 项失败`,
      bad.map(item => `${item.title}：${item.detail}`),
      bad.map(item => item.hint).filter((hint): hint is string => hint !== undefined),
    )
  }
  return result(
    'self-check',
    'unsupported',
    `bootstrap-ok 判不了（${String(unable.length)} 项缺前提；本轮新装 ${String(state.installed.length)}、复用 ${String(state.reused.size)}）`,
    unable.map(item => `${item.title}：${item.detail}`),
    ['缺的是清单或账本这类前提，补齐后重跑 `verify()`'],
  )
}

/** 读一个文本文件（清单）。异常交给调用方折成步骤结论。 */
function readTextFile(path: string): string {
  return readFileSync(path, 'utf8')
}
