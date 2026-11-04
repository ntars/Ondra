/**
 * slug 分配：把一条记忆映射成一个**稳定、短、可读**的索引入口名。
 *
 * 为什么不是序号、也不是 slug 用正文摘要：
 *
 * 1. **序号会漂**。删掉第 3 条，第 4 条就变成第 3 条，整块索引的所有 slug 全变，
 *    而 slug 是索引块的内容——一次删除等于整块前缀作废（§8.5 的代价）。
 * 2. **摘要会变**。`revise()` 之后摘要重写，slug 跟着变，等于同一条记忆换了入口，
 *    旧入口在模型那里还留着印象，却指向不存在的行。
 * 3. 记忆 id 由 O-010 生成后**永不变**，所以从 id 派生的 slug 也永不变。
 *
 * 形如 `fod-a1b2`：三字母类别码 + 短横 + id 里前 4 位。4 位 hex 有 65536 种，
 * 500 条时碰撞概率约 1.9%——所以这里**必须**处理碰撞，扩位到 6/8/12，最后才加序号。
 */

import { CATEGORY_CODES, CATEGORY_FALLBACK_CODE } from './types.js'
import { fnv1a } from './text.js'

/** slug 里 id 部分的候选长度（依次尝试）。 */
const SLICE_STEPS: readonly number[] = Object.freeze([4, 6, 8, 12])

/**
 * 取 id 里的可用字符段。
 *
 * O-010 的 id 是 `m-<12 位 hex>`，剥掉 `m-` 就是 hex；调用方也可能传自定义 id
 * （`user-birthday` 这种），那就用 `fnv1a` 兜一层，保证「随便什么 id 都有稳定短码」。
 * @param id 记忆 id。
 */
function stemOf(id: string): string {
  const stripped = id.replace(/^[a-z]+-/u, '').replace(/[^a-z0-9]/gu, '')
  if (stripped.length >= 4) return stripped
  return fnv1a(id)
}

/**
 * 生成 slug。
 *
 * **不修改 `taken`**：登记由调用方做，这样同一个 `taken` 可以给多轮构建复用，
 * 也就不会出现「同一个 id 两次构建拿到两个 slug」。
 * @param id 记忆 id。
 * @param category 11 类寿命类别。
 * @param taken 已被占用的 slug 集合。
 */
export function slugFor(id: string, category: string, taken: ReadonlySet<string>): string {
  const code = CATEGORY_CODES[category] ?? CATEGORY_FALLBACK_CODE
  const stem = stemOf(id)
  for (const step of SLICE_STEPS) {
    const candidate = `${code}-${stem.slice(0, step)}`
    if (!taken.has(candidate)) return candidate
  }
  // 极端情况（同一个 id 前 12 位全撞，说明 id 本身重复）才走到这里。
  const base = `${code}-${stem.slice(0, 12)}`
  let suffix = 1
  while (taken.has(`${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}

/**
 * 批量分配 slug（按输入顺序），返回 id → slug 的映射。
 *
 * 单独开一个函数是为了让「分配顺序」显式可读：先到先得，且**调用方要按稳定顺序传**，
 * 否则同一批记忆在两台机器上会得到不同 slug。稳定顺序 = `createdAt` 升序 + id 字典序。
 * @param records 记录（`id` 与 `category`）。
 */
export function assignSlugs(records: readonly { readonly id: string; readonly category: string }[]): ReadonlyMap<string, string> {
  const taken = new Set<string>()
  const out = new Map<string, string>()
  for (const record of records) {
    // 同一个 id 只会出现一次（`listFacts` 不会返回重复行），但防御性跳过，
    // 免得一个畸形输入把后面所有 slug 顶偏。
    if (out.has(record.id)) continue
    const slug = slugFor(record.id, record.category, taken)
    taken.add(slug)
    out.set(record.id, slug)
  }
  return out
}
