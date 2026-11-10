/**
 * 宿主的本地配置。
 *
 * ## 为什么配置存在宿主而不是内核
 *
 * 内核是"给定端点和密钥，把话说出去"的纯执行体。它读不了用户目录、
 * 也不该知道自己在哪个操作系统上。把配置留在宿主这一层，内核就能被
 * 放进任何沙箱，而配置文件在哪、怎么加密、怎么迁移，全由宿主一个地方决定。
 *
 * ## 为什么是明文 JSON
 *
 * 里面有 API 密钥，明文存盘并不理想。但替代方案都要额外代价：
 * 系统钥匙串需要用户授权、每次读都弹窗；自建加密需要一把同样要落盘的密钥，
 * 只是把问题挪了一层。当前选择是**明文 + 严格的文件权限（0600）**，
 * 并在 README 里写明这一点——与其给用户一个"看起来加密了"的错觉，
 * 不如把事实写清楚。
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 一条供应商配置。字段与内核 `ModelProfile` 对应。 */
export interface StoredProfile {
  id: string
  label: string
  baseUrl: string
  model: string
  apiKey: string
  contextWindow?: number
}

/** 配置文件的完整形状。 */
export interface HostConfig {
  /** 上次选中的模型 id。空字符串表示用默认。 */
  currentModel: string
  /** 供应商列表。 */
  profiles: StoredProfile[]
  /** 权限档位。见 {@link PermissionLevel}。 */
  permission: PermissionLevel
}

/**
 * 权限档位。
 *
 * 三个档位对应设计图里输入框左下角那个「完全访问」选择器。当前版本三档
 * 在行为上尚无差异——真正的差异要等工具接入后才体现（完全访问允许写文件、
 * 执行命令；仅对话禁止一切副作用）。先把档位与界面做出来，是为了让
 * "这个应用会碰我的东西吗"这个问题在第一次使用时就有答案，
 * 而不是等某天突然开始读写文件才被发现。
 */
export type PermissionLevel = 'full' | 'workspace' | 'chat'

/** 默认配置。 */
function defaultConfig(): HostConfig {
  return { currentModel: '', profiles: [], permission: 'full' }
}

/**
 * 首次启动时写入的内置网关配置。
 *
 * ## 为什么内置一条
 *
 * 这个应用出厂时没有任何密钥，而用户打开它第一件事就是想说话。若此时
 * 界面上只有一个"未配置"的模型选择器，第一次体验就是"装了个不能用"。
 *
 * ## 为什么是 magpie
 *
 * magpie 是本机上的 OpenAI 兼容网关（`127.0.0.1:3425`），不需要密钥，
 * 且聚合了多个上游模型。对本机用户来说它是**已经可用**的那个，
 * 不是让用户去申请 key 才能用。
 *
 * ## 为什么只在首次写入
 *
 * 只在配置文件不存在时写。用户后来删掉这条、或改成自己的供应商，
 * 都是他的选择；每次启动都补回来会变成"删不掉的项"。
 */
function builtinProfiles(): StoredProfile[] {
  return [
    {
      id: 'magpie-dsv4',
      label: 'DeepSeek V4.1 Flash',
      baseUrl: 'http://127.0.0.1:3425/v1',
      model: 'auto/deepseek-v4.1-flash',
      // 本地网关不校验密钥，留空即可。留空也让同步给内核的请求不带
      // Authorization 头——带一个空 Bearer 有的网关会当成非法凭据拒绝。
      apiKey: '',
      contextWindow: 1_000_000,
    },
  ]
}

/**
 * 解析数据目录。
 *
 * 顺序：环境变量 → 平台标准位置。
 * 环境变量优先是为了让测试与多实例能各自指向不同目录，
 * 否则两个实例会共用同一批会话文件。
 */
export function resolveDataDir(): string {
  const fromEnv = process.env.ONDRA_DATA_DIR?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv

  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'com.ntars.ondra')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'com.ntars.ondra')
  }
  // Linux 及其他：遵循 XDG 规范，未设时退回 ~/.local/share。
  const xdg = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
  return join(xdg, 'com.ntars.ondra')
}

/** 配置读写。 */
export class ConfigStore {
  private readonly path: string
  private value: HostConfig

  private constructor(path: string, value: HostConfig) {
    this.path = path
    this.value = value
  }

  /**
   * 打开配置。
   *
   * 文件不存在或损坏时退回默认值而不是抛错：首次启动没有配置文件是正常状态，
   * 而一个手改坏了的文件不该让应用起不来。损坏的原文件会留一份 `.bak` 副本。
   *
   * 首次启动（含损坏回退）时顺手写入内置网关，让应用开箱就能说话。
   */
  static async open(path: string): Promise<ConfigStore> {
    try {
      const raw = await readFile(path, 'utf8')
      return new ConfigStore(path, normalize(JSON.parse(raw)))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        process.stderr.write(`[host] 配置无法读取，使用默认值：${String(error)}\n`)
        // 保留原件，便于用户找回自己填过的密钥。
        await rename(path, `${path}.bak`).catch(() => {})
      }
      const profiles = builtinProfiles()
      const store = new ConfigStore(path, { ...defaultConfig(), profiles, currentModel: profiles[0]?.id ?? '' })
      // 落盘失败不阻断启动：内存里的这份配置已可用，只是下次启动会重来一遍。
      await store.persist().catch((caught: unknown) => {
        process.stderr.write(`[host] 写入初始配置失败：${String(caught)}\n`)
      })
      return store
    }
  }

  /** 读当前配置的副本。 */
  read(): HostConfig {
    return { ...this.value, profiles: this.value.profiles.map((profile) => ({ ...profile })) }
  }

  /**
   * 合并写入。
   *
   * 用合并而非整体替换：前端每次只改自己关心的字段（改了权限就只发权限），
   * 整体替换要求它把整份配置都发回来，一旦前端版本落后就会把新字段抹掉。
   */
  async update(patch: Partial<HostConfig>): Promise<HostConfig> {
    this.value = {
      currentModel: patch.currentModel ?? this.value.currentModel,
      profiles: patch.profiles ?? this.value.profiles,
      permission: patch.permission ?? this.value.permission,
    }
    await this.persist()
    return this.read()
  }

  /** 写入磁盘。先落临时文件再 rename，避免写到一半断电留下半截 JSON。 */
  private async persist(): Promise<void> {
    const directory = dirname(this.path)
    await mkdir(directory, { recursive: true })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, JSON.stringify(this.value, undefined, 2), 'utf8')
    // 权限收到 0600：文件里有 API 密钥，不该让同机其他用户读到。
    await chmod(temporary, 0o600).catch(() => {
      // Windows 上 chmod 语义不同，失败不阻断写入。
    })
    await rename(temporary, this.path)
  }
}

/**
 * 把磁盘上读到的任意值收窄成 {@link HostConfig}。
 *
 * 逐字段检查：配置文件是用户可见的，手工编辑过是常态。缺字段就用默认值补，
 * 而不是整份丢弃——用户改坏了 `permission` 不该顺带丢掉填好的密钥。
 */
function normalize(value: unknown): HostConfig {
  const fallback = defaultConfig()
  if (typeof value !== 'object' || value === null) return fallback
  const record = value as Record<string, unknown>

  const profiles: StoredProfile[] = []
  if (Array.isArray(record.profiles)) {
    for (const item of record.profiles) {
      if (typeof item !== 'object' || item === null) continue
      const profile = item as Record<string, unknown>
      if (typeof profile.baseUrl !== 'string' || typeof profile.model !== 'string') continue
      if (profile.baseUrl.trim() === '' || profile.model.trim() === '') continue
      profiles.push({
        id: typeof profile.id === 'string' && profile.id !== '' ? profile.id : `${profile.model}`,
        label: typeof profile.label === 'string' && profile.label !== '' ? profile.label : profile.model,
        baseUrl: profile.baseUrl,
        model: profile.model,
        apiKey: typeof profile.apiKey === 'string' ? profile.apiKey : '',
        ...(typeof profile.contextWindow === 'number' ? { contextWindow: profile.contextWindow } : {}),
      })
    }
  }

  const permission = record.permission === 'chat' || record.permission === 'workspace'
    ? record.permission
    : 'full'

  return {
    currentModel: typeof record.currentModel === 'string' ? record.currentModel : '',
    profiles,
    permission,
  }
}
