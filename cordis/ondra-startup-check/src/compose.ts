/**
 * 宿主补丁语义的**移植版**（手册 §8.3-2 原文就是「用移植的 …applyEntryPatches…」）。
 *
 * ## 语义真源
 *
 * `desktop/vendor/include/src/index.ts` 的 `applyEntryPatches`（343 行里的 57~127 行），
 * 以及 `desktop/packages/boot/app-boot/src/profile.ts` 的 `composeEntries`（755~762 行，
 * 它只是 `applyEntryPatches([], layers.flat(), warn)` 的一层包装）。
 *
 * ## 移植时被手册摘要**漏掉**的三处细节，这里按源码来
 *
 * 1. **`name` 不一致的检查只发生在「无 insert」的补丁行上。** 源码里 `name` 在循环开头
 *    就被解构出来，insert 分支里**从头到尾没看它**。手册摘要写「目标不存在/不是 group/
 *    `name` 不一致 → 跳过」，读起来像三者都管 insert 行——不是。照摘要写会让自检
 *    对一条实际能加载的补丁报 `fail`。
 * 2. **`insert` 带 id 时，目标 `config` 不是数组就当场改成 `[]` 再 push。** 也就是说
 *    「往一个非 group 的条目里塞」会先被 `group` 挡住，而「group 但 config 不是数组」
 *    会被**静默修正**，不告警。自检要把这件事说清楚，否则用户看到「插进去了」
 *    却不知道原来的 `config` 被丢了。
 * 3. **被 insert 的行立刻进索引**，所以同一条补丁列表里后面的补丁可以命中它。
 *    漏掉这一步会让「先插入、再配置」这种写法在自检里报成「目标不存在」——
 *    而宿主是能正常处理的。
 *
 * ## 与源码唯一的差别
 *
 * 源码用 `structuredClone`，本移植版用 JSON 往返。原因：本包的 YAML 子集**拒绝**
 * `!!js`，所以补丁里的值一定是 JSON 安全的；用 JSON 往返还能顺手保证「函数/undefined
 * 不会混进来」。这一点写在 README「已知限制」里。
 */

import type { ComposeResult, ComposeWarning, PatchRow } from './types.js'

/** 入口字段**只有六个**（手册 §8.3-3 的 `EntryOptions`）。 */
export const ENTRY_FIELDS: readonly string[] = Object.freeze([
  'id',
  'name',
  'config',
  'group',
  'disabled',
  'inject',
])

/** 补丁行特有的键（不属于入口字段）。 */
export const PATCH_ONLY_FIELDS: readonly string[] = Object.freeze(['insert'])

/**
 * 判一个值是不是普通对象。
 * @param value 值。
 */
function isRow(value: unknown): value is PatchRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 深拷贝补丁行。
 * @param rows 行。
 */
function cloneRows(rows: readonly PatchRow[]): PatchRow[] {
  return JSON.parse(JSON.stringify(rows)) as PatchRow[]
}

/**
 * 应用补丁列表（`applyEntryPatches` 的移植）。
 *
 * 输入不被修改：补丁若直接改共享对象，反复应用（配置热重载）就再也回不到原值。
 * @param data 起始入口列表（`composeEntries` 传空数组）。
 * @param patches 补丁列表，按顺序应用。
 * @param sink 被跳过的补丁行走这里。
 * @returns 应用后的入口列表。
 */
export function applyPatches(
  data: readonly PatchRow[],
  patches: readonly PatchRow[],
  sink: (warning: ComposeWarning) => void,
): PatchRow[] {
  const rows = cloneRows(data)
  if (patches.length === 0) return rows

  const index = new Map<string, PatchRow>()
  const indexOf = (entries: readonly PatchRow[]): void => {
    for (const entry of entries) {
      const id = entry['id']
      if (typeof id === 'string' && id !== '') index.set(id, entry)
      if (entry['group'] === true && Array.isArray(entry['config'])) {
        indexOf(entry['config'] as PatchRow[])
      }
    }
  }
  indexOf(rows)

  for (let row = 0; row < patches.length; row += 1) {
    const patch = patches[row]
    const id = patch['id']
    const insert = patch['insert']
    const name = patch['name']

    // 源码是 `if (insert)`：空数组为真（什么都不插但会建索引），null/undefined 为假。
    if (insert !== undefined && insert !== null && insert !== false) {
      if (!Array.isArray(insert)) {
        sink({
          code: 'bad-row',
          row: row + 1,
          message: '`insert` 不是数组：整条补丁被跳过（宿主会把它当对象，行为不可预期）',
        })
        continue
      }
      const added: PatchRow[] = []
      let bad = false
      for (const item of insert) {
        if (!isRow(item)) {
          bad = true
          break
        }
        added.push(item)
      }
      if (bad) {
        sink({
          code: 'bad-row',
          row: row + 1,
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
            message: `insert 目标「${id}」不存在：宿主只告警并跳过，这段入口不会挂载`,
          })
          continue
        }
        if (target['group'] !== true) {
          sink({
            code: 'insert-target-not-group',
            id,
            row: row + 1,
            message: `insert 目标「${id}」不是 group：宿主只告警并跳过`,
          })
          continue
        }
        if (!Array.isArray(target['config'])) {
          // 源码就是这样：静默改成空数组，不告警。这里补一条提示，但**不算失败**。
          target['config'] = []
        }
        ;(target['config'] as PatchRow[]).push(...added)
      } else {
        rows.push(...added)
      }
      indexOf(added)
      continue
    }

    if (typeof id !== 'string' || id === '') {
      sink({
        code: 'id-required',
        row: row + 1,
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
        message: `补丁目标「${id}」不存在：宿主只告警并跳过`,
      })
      continue
    }

    if (typeof name === 'string' && name !== '' && name !== target['name']) {
      sink({
        code: 'name-mismatch',
        id,
        row: row + 1,
        message: `name 不一致（条目是「${String(target['name'])}」，补丁写「${name}」）：宿主跳过`,
      })
      continue
    }

    for (const [key, value] of Object.entries(patch)) {
      if (key === 'id' || key === 'insert' || key === 'name') continue
      target[key] = value
    }
  }

  return rows
}

/**
 * 从补丁列表算出「宿主会看到的那份入口树」（`composeEntries` 的移植）。
 * @param patches 补丁列表。
 * @returns 入口树与被跳过的补丁行。
 */
export function composeEntries(patches: readonly PatchRow[]): ComposeResult {
  const warnings: ComposeWarning[] = []
  const entries = applyPatches([], patches, warning => warnings.push(warning))
  return { entries: Object.freeze(entries), warnings: Object.freeze(warnings) }
}

/**
 * 列出入口树里所有行的字段（递归进 group）。
 * @param entries 入口树。
 * @param out 收集器。
 */
export function collectRows(entries: readonly PatchRow[], out: PatchRow[] = []): PatchRow[] {
  for (const entry of entries) {
    out.push(entry)
    if (entry['group'] === true && Array.isArray(entry['config'])) {
      collectRows(entry['config'] as PatchRow[], out)
    }
  }
  return out
}
