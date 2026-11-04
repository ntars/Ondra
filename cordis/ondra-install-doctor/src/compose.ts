/**
 * 宿主补丁语义的**移植版**（`parsePatchYaml / applyEntryPatches / composeEntries`
 * 三件套，手册 §8.3-2 与语料·第一编 4.2 逐字要求）。
 *
 * ## 语义真源
 *
 * `desktop/vendor/include/src/index.ts` 的 `applyEntryPatches`（第 57–127 行），
 * 以及 `desktop/packages/boot/app-boot/src/profile.ts` 的 `composeEntries`
 * （第 755–762 行，它只是 `applyEntryPatches([], layers.flat(), warn)` 的一层包装）。
 *
 * ## 移植时被手册摘要**漏掉**的三处细节（一律按源码来）
 *
 * 1. **`name` 校验只发生在「无 insert」的补丁行上。** 源码在循环开头就解构 `name`，
 *    insert 分支里**从头到尾没看它**。手册摘要写「目标不存在 / 不是 group /
 *    `name` 不一致 → 跳过」，读起来像三者都管 insert 行——不是。照摘要实现会让
 *    一条实际能加载的补丁在报告里被判「跳过」。
 * 2. **`insert` 带 id 时，目标 `config` 不是数组就当场改成 `[]` 再 push。**
 *    也就是「group 但 config 不是数组」被**静默修正**，不告警。本包把这件事
 *    作为 `soft` 告警报出来（宿主不报，但用户需要知道原来的 `config` 被丢了）。
 * 3. **被 insert 的行立刻进索引**，所以同一条补丁列表里后面的补丁可以命中它。
 *    漏掉这一步会让「先插入、再配置」这种写法在报告里变成「目标不存在」——
 *    而宿主是能正常处理的。
 *
 * ## 与源码唯一的差别
 *
 * 源码用 `structuredClone`，本移植版用 JSON 往返。原因：本包的 YAML 子集**拒绝**
 * `!!js`，所以补丁里的值一定是 JSON 安全的；JSON 往返还能顺手保证函数 / `undefined`
 * 不会混进来。这一点写进 README「已知限制」。
 *
 * ## 比源码多做的两件事（都不改语义，只加可观测性）
 *
 * - 每条告警带上**层名**（哪个 bundle 的补丁）。
 * - 额外做**入口结构检查**（第七个字段、id 不合规、重复 id、`group:true` 无数组），
 *   这些宿主不会报，但它们是「装了却没反应」的常见原因。
 */

import type {
  EntryRowView,
  EntryTree,
  PatchEntry,
  PatchProblem,
  PatchRow,
  Row,
} from './types.js'
import { ENTRY_FIELDS, NAME_RE, PATCH_ONLY_FIELDS } from './types.js'

/** 一层补丁（带归属）。 */
export interface LayeredPatches {
  readonly layer: string
  readonly rows: readonly PatchRow[]
}

/** 组合结果。 */
export interface ComposeResult {
  readonly roots: readonly PatchEntry[]
  readonly warnings: readonly PatchProblem[]
  /** 每一层各自新增了几条入口（键为层名，重复层名会累加）。 */
  readonly addedByLayer: Readonly<Record<string, number>>
  /** 每个入口 id 是被哪一层插进来的（只记第一次）。 */
  readonly provenance: ReadonlyMap<string, string>
}

/**
 * 深拷贝补丁行（JSON 往返，见文件头末段）。
 * @param rows 行。
 */
function cloneRows(rows: readonly PatchRow[]): PatchRow[] {
  return JSON.parse(JSON.stringify(rows)) as PatchRow[]
}

/** 内部可变行（应用补丁时用的是普通对象）。 */
type MutableRow = Record<string, unknown>

/**
 * 应用一层补丁到入口表（`applyEntryPatches` 的移植）。
 *
 * 输入不被修改：补丁若直接改共享对象，反复应用（配置热重载）就再也回不到原值。
 * @param data 起始入口列表（`composeEntries` 传空数组）。
 * @param rows 这一层的补丁行。
 * @param layer 层名（进告警）。
 * @param sink 告警出口。
 * @param added 这一层真正新增的入口计数（引用传出）。
 * @returns 应用后的入口列表。
 */
export function applyEntryPatches(
  data: readonly PatchEntry[],
  rows: readonly PatchRow[],
  layer: string,
  sink: (problem: PatchProblem) => void,
  added: { count: number },
  provenance: Map<string, string>,
): PatchEntry[] {
  const list = cloneRows(data as readonly PatchRow[]) as unknown as MutableRow[]
  if (rows.length === 0) return list as unknown as PatchEntry[]

  const index = new Map<string, MutableRow>()
  const indexOf = (entries: readonly MutableRow[]): void => {
    for (const entry of entries) {
      const id = entry['id']
      if (typeof id === 'string' && id !== '') index.set(id, entry)
      if (entry['group'] === true && Array.isArray(entry['config'])) {
        indexOf(entry['config'] as MutableRow[])
      }
    }
  }
  indexOf(list)

  for (let row = 0; row < rows.length; row += 1) {
    const patch = rows[row] as unknown as MutableRow
    const id = patch['id']
    const insert = patch['insert']
    const name = patch['name']

    // 源码是 `if (insert)`：空数组为真，null / undefined / false 为假。
    if (insert !== undefined && insert !== null && insert !== false) {
      if (!Array.isArray(insert)) {
        sink({
          code: 'bad-row',
          row: row + 1,
          layer,
          fatal: true,
          message: '`insert` 不是数组：整条补丁被跳过',
        })
        continue
      }
      const items: MutableRow[] = []
      let bad = false
      for (const item of insert as readonly unknown[]) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
          bad = true
          break
        }
        items.push(JSON.parse(JSON.stringify(item)) as MutableRow)
      }
      if (bad) {
        sink({
          code: 'bad-row',
          row: row + 1,
          layer,
          fatal: true,
          message: '`insert` 里有不是对象的条目：整条补丁被跳过',
        })
        continue
      }

      if (typeof id === 'string' && id !== '') {
        const target = index.get(id)
        if (target === undefined) {
          sink({
            code: 'insert-target-missing',
            id,
            row: row + 1,
            layer,
            fatal: true,
            message: `insert 目标「${id}」不存在：宿主只告警并跳过，这段入口不会挂载`,
          })
          continue
        }
        if (target['group'] !== true) {
          sink({
            code: 'insert-target-not-group',
            id,
            row: row + 1,
            layer,
            fatal: true,
            message: `insert 目标「${id}」不是 group：宿主只告警并跳过`,
          })
          continue
        }
        if (!Array.isArray(target['config'])) {
          // 宿主静默把 config 改成 []。本包报一条 soft：用户该知道原来的值没了。
          sink({
            code: 'group-without-list',
            id,
            row: row + 1,
            layer,
            fatal: false,
            message: `group「${id}」原来的 config 不是数组，宿主会把它改成 [] 再插入（旧值丢失）`,
          })
          target['config'] = []
        }
        ;(target['config'] as MutableRow[]).push(...items)
        added.count += items.length
      } else {
        list.push(...items)
        added.count += items.length
      }
      // 记来源：这条入口是哪一层的补丁插进来的（报告里要能回答「这行谁装的」）。
      for (const item of items) {
        const itemId = item['id']
        if (typeof itemId === 'string' && itemId !== '' && !provenance.has(itemId)) {
          provenance.set(itemId, layer)
        }
      }
      // 立刻进索引：见文件头第 3 条。
      indexOf(items)
      continue
    }

    if (typeof id !== 'string' || id === '') {
      sink({
        code: 'id-required',
        row: row + 1,
        layer,
        fatal: true,
        message: '无 insert 的补丁行必须给 id：宿主只告警并跳过',
      })
      continue
    }

    const target = index.get(id)
    if (target === undefined) {
      sink({
        code: 'target-missing',
        id,
        row: row + 1,
        layer,
        fatal: true,
        message: `补丁目标「${id}」不存在：宿主只告警并跳过`,
      })
      continue
    }

    // name 校验只在无 insert 的分支（见文件头第 1 条）。
    if (typeof name === 'string' && name !== '' && name !== target['name']) {
      sink({
        code: 'name-mismatch',
        id,
        row: row + 1,
        layer,
        fatal: true,
        message: `name 不一致（条目是「${String(target['name'])}」，补丁写「${name}」）：宿主跳过`,
      })
      continue
    }

    for (const [key, value] of Object.entries(patch)) {
      if (key === 'id' || key === 'insert' || key === 'name') continue
      target[key] = value
    }
  }

  return list as unknown as PatchEntry[]
}

/**
 * 从多层补丁算出「宿主会看到的那份入口树」。
 *
 * 层层相扣：第 N 层看到的是前 N−1 层的结果。这与宿主的
 * `applyEntryPatches([], layers.flat(), warn)` **不完全等价**——
 * 宿主把多层摊平成一张列表一次性应用，本移植版逐层应用。两者在
 * 「后层引用前层插进来的行」时结果相同（因为两边都边插边索引），
 * 差别只在告警里的层名与新增计数。这条差异写在 README「已知限制 2」。
 * @param layers 各层补丁。
 */
export function composeEntries(layers: readonly LayeredPatches[]): ComposeResult {
  const warnings: PatchProblem[] = []
  const addedByLayer: Record<string, number> = {}
  const provenance = new Map<string, string>()
  let entries: PatchEntry[] = []

  for (const layer of layers) {
    const added = { count: 0 }
    entries = applyEntryPatches(
      entries,
      layer.rows,
      layer.layer,
      problem => warnings.push(problem),
      added,
      provenance,
    )
    addedByLayer[layer.layer] = (addedByLayer[layer.layer] ?? 0) + added.count
  }

  return {
    roots: Object.freeze(entries),
    warnings: Object.freeze(warnings),
    addedByLayer: Object.freeze(addedByLayer),
    provenance,
  }
}

/**
 * 遍历入口树，产出扁平视图并做结构检查。
 * @param roots 根入口。
 * @param provenance 来源表（`composeEntries` 产出）；缺它就是 `'unknown'`。
 * @param sink 结构问题的出口。
 */
export function inspectTree(
  roots: readonly PatchEntry[],
  provenance: ReadonlyMap<string, string>,
  sink: (problem: PatchProblem) => void,
): EntryTree {
  const rows: EntryRowView[] = []
  const seen = new Map<string, number>()
  let groups = 0
  let leaves = 0
  let disabled = 0
  let maxDepth = 0

  const walk = (list: readonly Row[], depth: number, path: readonly string[], fallback: string): void => {
    for (const entry of list) {
      const id = typeof entry['id'] === 'string' ? entry['id'] : ''
      const layer = provenance.get(id) ?? fallback
      const name = typeof entry['name'] === 'string' ? entry['name'] : undefined
      const isGroup = entry['group'] === true
      const isDisabled = entry['disabled'] === true
      const myPath = [...path, id === '' ? '(no-id)' : id]

      // 结构检查：宿主管不到的四种「装了却没反应」。
      for (const key of Object.keys(entry)) {
        if (!ENTRY_FIELDS.includes(key) && !PATCH_ONLY_FIELDS.includes(key)) {
          sink({
            code: 'seventh-field',
            id,
            layer,
            fatal: false,
            message: `入口有第七个字段「${key}」（只许 id/name/config/group/disabled/inject）：宿主忽略它`,
          })
        }
      }
      if (id === '') {
        sink({
          code: 'anonymous-row',
          layer,
          fatal: true,
          message: '入口行没有 id：宿主无法命名空间化（工具名、存储目录、日志前缀都靠它）',
        })
      } else if (!NAME_RE.test(id)) {
        sink({
          code: 'bad-id',
          id,
          layer,
          fatal: true,
          message: `入口 id「${id}」不合规（须匹配 ^[a-z][a-z0-9_-]{1,63}$）`,
        })
      } else {
        const times = (seen.get(id) ?? 0) + 1
        seen.set(id, times)
        if (times === 2) {
          sink({
            code: 'duplicate-id',
            id,
            layer,
            fatal: false,
            message: `入口 id「${id}」在树里出现多次：后插入的会盖掉索引，补丁命中哪一个不确定`,
          })
        }
      }
      if (isGroup && !Array.isArray(entry['config'])) {
        sink({
          code: 'group-without-list',
          id,
          layer,
          fatal: false,
          message: `group「${id}」的 config 不是数组：往它里 insert 会先把 config 改成 []`,
        })
      }

      if (isGroup) groups += 1
      else leaves += 1
      if (isDisabled) disabled += 1
      if (depth > maxDepth) maxDepth = depth

      rows.push({
        id: id === '' ? '(no-id)' : id,
        name,
        group: isGroup,
        disabled: isDisabled,
        depth,
        path: Object.freeze(myPath),
        layer,
      })

      if (isGroup && Array.isArray(entry['config'])) {
        walk(entry['config'] as readonly Row[], depth + 1, myPath, layer)
      }
    }
  }

  walk(roots as readonly Row[], 0, [], 'unknown')

  return {
    roots: Object.freeze(roots),
    rows: Object.freeze(rows),
    total: rows.length,
    groups,
    leaves,
    disabled,
    maxDepth,
  }
}
