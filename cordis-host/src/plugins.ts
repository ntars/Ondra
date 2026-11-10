/**
 * 插件目录清单与启停开关。
 *
 * ## 为什么清单要扫目录，而不是读设置段
 *
 * `scanSections` 只返回**声明了 `CONFIG_SECTION`** 的包。全仓 78 个目录里
 * 有十来个没有任何设置字段（纯基础设施，例如时钟与身份），它们在设置面板
 * 里不存在，但确实是正在运行的扩展。扩展抽屉要说「一共装了哪些包」，
 * 判据只能是目录本身。
 *
 * ## 为什么开关要落到文件
 *
 * 启用名单目前来自代码里的常量加环境变量（见宿主 `DEFAULT_CORE_ENABLE`）。
 * 用户在界面上关掉一个包，这个决定必须能跨重启存活，否则下一次启动它又
 * 自己回来了——那是最难解释的一类「设置没生效」。落盘位置与 `settings.json`
 * 同级，属于用户数据，不进源码树。
 *
 * ## 为什么停用要等重启
 *
 * 卸载一个已经 `provide` 了服务键的插件会留下悬空引用：别的插件在启动时
 * 已经 `ctx.get` 过它，运行中撤走只会让那些调用在下一次命中时抛错。
 * 因此开关只改「下次启动的名单」，当前进程不动——界面必须如实说明这一点，
 * 而不是让用户以为关掉就立刻消失。
 */

import { readFile, readdir, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SettingsSection } from './settings.js'

/** 扩展抽屉里的一行（静态信息部分）。 */
export interface PluginRow {
  /** 目录名，也是启用名单里写的标识。 */
  id: string
  /** `package.json` 里的包名；缺失时回落到目录名。 */
  name: string
  /** 版本号；缺失时为空串，界面显示「版本未知」。 */
  version: string
  /** 一句话描述；缺失时为空串。 */
  description: string
  /** 当前进程是否装载了它。 */
  loaded: boolean
  /**
   * 是否核心链成员。
   *
   * 核心成员不允许停用：它们提供的是别的包在启动时就 `ctx.get` 的服务键，
   * 停掉不会有报错，只会让一批能力静默降级。界面把这个开关置灰并说明原因，
   * 比允许点下去再让人排查「她为什么突然不记事了」诚实。
   */
  core: boolean
  /** 对应的设置段 id；没有声明设置段时为 null。 */
  sectionId: string | null
  /** 设置段的中文名；没有时为 null。 */
  sectionTitle: string | null
  /** 该段的字段数。没有设置段时为 0。 */
  fields: number
}

/**
 * 开关文件的内容。
 *
 * 两份名单而不是一份「启用名单」：默认名单由代码常量与环境变量给出，
 * 界面只该在它之上做加减。`extra` 记住「用户额外打开的」，
 * `disabled` 记住「用户关掉的」——两者都为空时就是默认行为。
 */
export interface PluginSwitches {
  /** 用户额外启用（不在默认名单里的包）。 */
  extra: Set<string>
  /** 用户停用（默认名单里被关掉的包）。 */
  disabled: Set<string>
}

/** 开关文件的形状。 */
interface SwitchFile {
  version: 1
  extra: string[]
  disabled: string[]
}

/**
 * 读开关文件。
 *
 * 文件不存在、坏掉、结构不符一律当作「没有任何改动」：这个文件是用户的
 * 一个偏好，不是运行必需的数据。为它让宿主起不来，代价远大于收益。
 */
export async function readPluginSwitches(file: string): Promise<PluginSwitches> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return { extra: new Set(), disabled: new Set() }
  }
  if (typeof parsed !== 'object' || parsed === null) return { extra: new Set(), disabled: new Set() }
  const record = parsed as { extra?: unknown; disabled?: unknown }
  return {
    extra: toStringSet(record.extra),
    disabled: toStringSet(record.disabled),
  }
}

/**
 * 写入开关文件。
 *
 * 先落临时文件再 `rename`：`rename` 在同一文件系统内是原子的，进程在写入
 * 中途被杀时磁盘上要么是旧名单、要么是新名单，不会出现半截 JSON 被下一次
 * 启动读成「没有任何改动」——那样用户刚关掉的插件会自己回来。
 */
export async function writePluginSwitches(file: string, switches: PluginSwitches): Promise<void> {
  const payload: SwitchFile = {
    version: 1,
    extra: [...switches.extra].sort(),
    disabled: [...switches.disabled].sort(),
  }
  const temporary = `${file}.${String(process.pid)}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(payload, null, 2), 'utf8')
    await rename(temporary, file)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

/** 把任意值收窄成字符串集合。空白项与非字符串一律丢掉。 */
function toStringSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set()
  return new Set(value.filter((item): item is string => typeof item === 'string' && item !== ''))
}

/**
 * 扫出全部插件目录。
 *
 * @param root `plugins/` 绝对路径。
 * @param loaded 当前进程的启用名单。
 * @param core 核心链成员（目录名）。
 * @param sections 已扫描的设置段，用来补「配置入口」要用的段 id。
 * @returns 按目录名排序的行。排序求稳定：每次打开抽屉顺序一致，用户才能凭位置找。
 */
export async function scanPlugins(
  root: string,
  loaded: ReadonlySet<string>,
  core: ReadonlySet<string>,
  sections: readonly SettingsSection[],
): Promise<PluginRow[]> {
  let names: string[]
  try {
    names = (await readdir(root, { withFileTypes: true }))
      // `node_modules` 里是按包名建的软链，指向同一批插件。不跳过会出现两份。
      .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
      .map((entry) => entry.name)
  } catch {
    // `plugins/` 缺失不是错误：只装了宿主时扩展列表就是空的。
    return []
  }

  const byDir = new Map<string, SettingsSection>()
  for (const section of sections) byDir.set(section.dir, section)

  const rows = await Promise.all(names.map(async (id): Promise<PluginRow> => {
    const meta = await readPackageMeta(join(root, id, 'package.json'))
    const section = byDir.get(id)
    return {
      id,
      name: meta.name === '' ? id : meta.name,
      version: meta.version,
      description: meta.description,
      /*
       * 装载判定与 `scanSections` 保持同一套键：目录名、段 id、去掉
       * `ondra-` 前缀的短名、以及段声明方。四处只要有一处对得上就算装载——
       * `ONDRA_CORE_ENABLE` 允许用户写其中任意一种写法。
       */
      loaded: loaded.has(id)
        || (section !== undefined && (loaded.has(section.id) || loaded.has(section.id.replace(/^ondra-/, '')))),
      core: core.has(id),
      sectionId: section?.id ?? null,
      sectionTitle: section?.title ?? null,
      fields: section?.fields.length ?? 0,
    }
  }))

  rows.sort((a, b) => a.id.localeCompare(b.id, 'en'))
  return rows
}

/** 从 `package.json` 里取展示用的三个字段。读不到就给空值，不抛。 */
async function readPackageMeta(file: string): Promise<{ name: string; version: string; description: string }> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) {
      return { name: '', version: '', description: '' }
    }
    const record = parsed as Record<string, unknown>
    return {
      name: typeof record.name === 'string' ? record.name : '',
      version: typeof record.version === 'string' ? record.version : '',
      description: typeof record.description === 'string' ? record.description : '',
    }
  } catch {
    return { name: '', version: '', description: '' }
  }
}
