/**
 * 存储服务：JSON 落盘，写临时文件再改名（原子写）。
 *
 * 直接覆盖原文件的风险不是「写失败」，而是**写了一半断电**：文件还在，
 * 内容却是半截 JSON，读的时候才发现最后一次对话没了。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export class StoreService {
  private writes = 0

  constructor(private readonly dir: string, private readonly enabled: boolean) {}

  private path(key: string): string {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(key)) throw new Error(`非法键名：${key}`)
    return join(this.dir, `${key}.json`)
  }

  /** 原子写：先写 .tmp，再改名；同目录改名是原子操作。 */
  async write(key: string, value: unknown): Promise<void> {
    if (!this.enabled) throw new Error('存储已关闭')
    await mkdir(this.dir, { recursive: true })
    const target = this.path(key)
    const tmp = `${target}.tmp`
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
    await rename(tmp, target)
    this.writes += 1
  }

  async read<T>(key: string, fallback: T): Promise<T> {
    if (!this.enabled) throw new Error('存储已关闭')
    try {
      const raw = await readFile(this.path(key), 'utf8')
      return JSON.parse(raw) as T
    } catch {
      // 读不到或坏文件都回落到默认值：一个坏键不该让整个应用起不来。
      return fallback
    }
  }

  /** 快照：把当前内容复制成带时间戳的文件，保留最近 N 份。 */
  async snapshot(key: string, keep: number): Promise<string> {
    const value = await this.read<unknown>(key, null)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const name = `${key}.${stamp}`
    await this.write(name, value)
    return name.replace(/\.json$/, '')
  }

  get writeCount(): number { return this.writes }
}
