/**
 * 插件配置段的**自动发现**与用户层读写。
 *
 * ## 为什么扫描而不是维护清单
 *
 * 设计文档 §6.6 的验收是「新增一个插件，界面代码的改动量必须是零」。
 * 若宿主里写一张 122 行的段清单，那么每加一个插件就要改宿主，
 * 界面也就跟着不同步——那正是 §6.6 点名的反例。
 *
 * 所以这里只做一件事：**遍历 `plugins/` 下每个包的 `lib/settings.js`，
 * 把它导出的 `CONFIG_SECTION` 读出来**。字段的种类、范围、默认值、说明
 * 全部来自插件自己声明的 `FIELD_SPECS`，宿主不复制、不改写、不补默认值。
 *
 * 实测（本仓 137 个包）：122 个导出 `CONFIG_SECTION`、1 个只有 `FIELD_SPECS`、
 * 合计 1168 个字段、零个 import 失败。这三个数与设计文档 §5.13 的口径一致，
 * 说明扫描这条路走的就是文档假设的那条。
 *
 * ## 为什么读 `lib/` 而不是 `src/`
 *
 * `lib/` 是构建产物，纯 JS、无 TS 语法、无类型导入，`import()` 一定能跑。
 * 读 `src/` 需要带 TS 运行时，那会给宿主引入一个只为读配置存在的依赖。
 *
 * ## 字段形状的两种拼写
 *
 * 插件侧 `FieldSpecLike` 用 `options` 表示枚举候选，而 O-005 的
 * `FieldSpec` 用 `values`。两者是同一件事的两种拼写，这里**同时接受**
 * 并统一输出成 `values`。不统一的话，界面会在枚举字段上渲染出一个空的分段控件
 * ——那种"控件在但不显示选项"的缺陷极难从代码上看出来。
 */

import { readdir, readFile, rename, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 一种字段的取值种类。与插件侧 `FieldSpecLike.kind` 同集合。 */
export type FieldKind = 'string' | 'number' | 'boolean' | 'enum' | 'json'

/**
 * 归一化后的一个字段。
 *
 * 刻意保留 `pattern`：`string` 字段里 35 个带正则（如 `HH:MM`），
 * 界面要靠它做实时校验。丢掉它就只能"输入什么存什么"，
 * 而配置里存进 `25:70` 之后插件行为会变得不可解释。
 */
export interface SettingsField {
  key: string
  kind: FieldKind
  default?: unknown
  min?: number
  max?: number
  values?: string[]
  pattern?: string
  doc?: string
  advancedOnly: boolean
  secret: boolean
}

/** 归一化后的一个配置段。 */
export interface SettingsSection {
  /** 段键（kebab）。写进配置文件的就是它。 */
  id: string
  /** 中文段名。 */
  title: string
  /** 插件目录名。用户报问题时说的是它，界面上必须能对上。 */
  dir: string
  /** 声明方（插件名或服务键）。 */
  owner: string
  /** 是否已装载。false 时界面必须灰显并注明「插件已停用」（§6.7）。 */
  active: boolean
  /** 是否有 `CONFIG_SECTION`。false 即 §5.13 的「无段字段」。 */
  registered: boolean
  fields: SettingsField[]
}

/** 一次扫描的结果。 */
export interface SettingsSnapshot {
  sections: SettingsSection[]
  /** 用户层：段键 → 字段键 → 值。只含用户真正改过的键。 */
  user: Record<string, Record<string, unknown>>
  /** 统计，供界面显示与自检。 */
  totals: { sections: number; fields: number; unregistered: number }
}

/** 用户层文件形状。 */
interface UserLayerFile {
  user: Record<string, Record<string, unknown>>
}

/** 判断一个值是不是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把插件导出的字段声明收窄成 {@link SettingsField}。
 *
 * 缺 `kind` 的字段直接丢弃而不是猜一个：猜错的表现是"这个字段渲染成错误控件"，
 * 而丢弃的表现是"这个字段不出现"，后者用户能立刻发现并报给我们。
 */
function normalizeField(key: string, raw: unknown): SettingsField | undefined {
  if (!isRecord(raw)) return undefined
  const kind = raw['kind']
  if (kind !== 'string' && kind !== 'number' && kind !== 'boolean' && kind !== 'enum' && kind !== 'json') {
    return undefined
  }

  // 枚举候选有两种拼写：插件侧 `options`、O-005 侧 `values`。见文件头。
  const candidates = Array.isArray(raw['values'])
    ? raw['values']
    : Array.isArray(raw['options'])
      ? raw['options']
      : undefined

  const field: SettingsField = {
    key,
    kind,
    advancedOnly: raw['advancedOnly'] === true,
    secret: raw['secret'] === true,
  }
  if ('default' in raw) field.default = raw['default']
  if (typeof raw['min'] === 'number') field.min = raw['min']
  if (typeof raw['max'] === 'number') field.max = raw['max']
  if (typeof raw['pattern'] === 'string') field.pattern = raw['pattern']
  if (typeof raw['doc'] === 'string') field.doc = raw['doc']
  if (candidates !== undefined) {
    field.values = candidates.filter((item): item is string => typeof item === 'string')
  }
  return field
}

/**
 * 从段声明里取字段表。
 *
 * 无段插件（只导出 `FIELD_SPECS`）的字段键是 camelCase，而配置文件里写的
 * 是 kebab。这两种键的对应关系**只有插件自己的 `KEY_PAIRS` 知道**，
 * 不是简单的大小写转换（`bm25K1` → `bm25-k1` 若做字符串替换会对，
 * 但 `autoSeed` → `auto-seed` 全靠表）。
 *
 * 因此这里读 `SECTION_KEYS`（插件由 `KEY_PAIRS` 反向生成的 kebab → camel 表），
 * 把 camel 键映回 kebab。拿不到表时退回字段原名，并在界面上如实显示原名——
 * 宁可让人看到 `autoSeed`，也不要显示一个写不到配置文件里的假键。
 */
function collectFields(module: Record<string, unknown>): { fields: SettingsField[]; title: string; registered: boolean } {
  const section = module['CONFIG_SECTION']

  if (isRecord(section) && isRecord(section['fields'])) {
    const fields: SettingsField[] = []
    for (const [key, spec] of Object.entries(section['fields'])) {
      const field = normalizeField(key, spec)
      if (field !== undefined) fields.push(field)
    }
    return {
      fields,
      title: typeof section['title'] === 'string' ? section['title'] : '',
      registered: true,
    }
  }

  // 无段字段：只有 FIELD_SPECS。
  const specs = module['FIELD_SPECS']
  if (!isRecord(specs)) return { fields: [], title: '', registered: false }

  const sectionKeys = module['SECTION_KEYS']
  /** camel → kebab，由插件的 `SECTION_KEYS` 反向得到。 */
  const camelToKebab: Record<string, string> = {}
  if (isRecord(sectionKeys)) {
    for (const [kebab, camel] of Object.entries(sectionKeys)) {
      if (typeof camel === 'string') camelToKebab[camel] = kebab
    }
  }

  const fields: SettingsField[] = []
  for (const [camel, spec] of Object.entries(specs)) {
    const field = normalizeField(camelToKebab[camel] ?? camel, spec)
    if (field !== undefined) fields.push(field)
  }
  return { fields, title: '', registered: false }
}

/** 扫描一个插件目录，返回它声明的段。没有可读产物时返回 undefined。 */
async function scanPlugin(root: string, dir: string): Promise<{ section: SettingsSection } | undefined> {
  const file = join(root, dir, 'lib', 'settings.js')
  let module: Record<string, unknown>
  try {
    module = (await import(pathToFileURL(file).href)) as Record<string, unknown>
  } catch {
    // 没有 `lib/settings.js`、或它有副作用导致 import 失败。两种情况都跳过：
    // 一个插件读不出配置，不该拖垮整张设置页。
    return undefined
  }

  const { fields, title, registered } = collectFields(module)
  if (fields.length === 0) return undefined

  const declaredId = module['CONFIG_SECTION_ID']
  const sectionId = typeof declaredId === 'string' && declaredId !== '' ? declaredId : dir.replace(/^ondra-/, '')

  const owner = isRecord(module['CONFIG_SECTION']) && typeof module['CONFIG_SECTION']['owner'] === 'string'
    ? module['CONFIG_SECTION']['owner']
    : dir

  return {
    section: {
      id: sectionId,
      title: title === '' ? dir : title,
      dir,
      owner,
      active: false, // 由外层按启用名单填。
      registered,
      fields,
    },
  }
}

/**
 * 扫描全部插件。
 *
 * @param root `plugins/` 的绝对路径。
 * @param enabled 已装载的插件 id 集合。用于标记 `active`，见 §6.7 的灰显义务。
 */
export async function scanSections(root: string, enabled: ReadonlySet<string>): Promise<SettingsSection[]> {
  let entries: string[]
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    // `plugins/` 缺失（比如只装了宿主）不是错误，只是没有配置段。
    return []
  }

  const scanned = await Promise.all(entries.map((dir) => scanPlugin(root, dir)))
  const sections: SettingsSection[] = []
  for (const item of scanned) {
    if (item === undefined) continue
    const section = item.section
    // 已装载判断同时认目录名与 owner：122 段里 12 个段 id 与目录名不同，
    // 而用户设 `ONDRA_CORE_ENABLE` 时写的是目录名去掉 ondra- 之后的短名。
    section.active = enabled.has(section.dir)
      || enabled.has(section.id)
      || enabled.has(section.dir.replace(/^ondra-/, ''))
      || enabled.has(section.owner)
    sections.push(section)
  }

  // 按段名排序，让界面顺序稳定。不按目录名：用户读的是「记忆内核」而不是
  // 「ondra-memory-core」，排序也该按他读到的那个。
  sections.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
  return sections
}

/** 用户层配置的读写。 */
export class SettingsStore {
  private readonly path: string
  private value: UserLayerFile

  private constructor(path: string, value: UserLayerFile) {
    this.path = path
    this.value = value
  }

  /**
   * 打开用户层。
   *
   * 文件不存在是正常状态（没人改过任何设置）。损坏时留一份 `.bak`
   * 再退回空层——用户手改坏了 JSON，不该让整个设置页打不开。
   */
  static async open(path: string): Promise<SettingsStore> {
    try {
      const raw = await readFile(path, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      return new SettingsStore(path, { user: isRecord(parsed) && isRecord(parsed['user']) ? sanitize(parsed['user']) : {} })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        await rename(path, `${path}.bak`).catch(() => {})
      }
      return new SettingsStore(path, { user: {} })
    }
  }

  /** 读用户层快照。 */
  read(): Record<string, Record<string, unknown>> {
    return structuredClone(this.value.user)
  }

  /**
   * 写一个字段。
   *
   * 传 `undefined` 表示**删掉这一层对这个键的设置**，让它回落到下层默认值。
   * 这与"把值设成 null"是两件事：`null` 是显式置空，会覆盖下层（见 O-005
   * `LayerSet` 的注释）。界面上的「恢复默认」用的就是删键，不是写 null。
   */
  async set(section: string, key: string, value: unknown): Promise<void> {
    const bucket = this.value.user[section] ?? {}
    if (value === undefined) delete bucket[key]
    else bucket[key] = value

    if (Object.keys(bucket).length === 0) delete this.value.user[section]
    else this.value.user[section] = bucket

    await this.persist()
  }

  /** 落盘。先写临时文件再 rename，避免断电留下半截 JSON。 */
  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, JSON.stringify(this.value, undefined, 2), 'utf8')
    await rename(temporary, this.path)
  }
}

/** 把磁盘上读到的用户层收窄成「段 → 字段 → 值」，丢掉形状不对的部分。 */
function sanitize(raw: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [section, fields] of Object.entries(raw)) {
    if (!isRecord(fields)) continue
    out[section] = { ...fields }
  }
  return out
}
