/**
 * 配置的**单一真源**。
 *
 * ## 出厂值为什么这么保守
 *
 * 1. `enable=false`：端侧默认全关（master-plan §16.3 隔离六条）。
 * 2. `bridgeUrl=''`：**空 = 不启动**。手册没给任何一个桌宠桥的地址与端口，
 *    编一个默认值等于让「没配」看起来像「配好了」，而现象是「一直在重连一个不存在的端口」。
 * 3. `allowedOrigins=[]`：**空 = 全拒**（§9.2）。填一个 `*` 之类的通配不是「方便」，
 *    是把 CSWSH 那道门拆掉。
 * 4. `render='static'`：§6.3 原话「Live2D 注意：Cubism Core 专有不可再分发——1.0 阶段不做
 *    （P2 + 静态降级）」。所以 `live2d` 是一个**会被拒绝的值**，不是一个待实现的选项。
 *
 * ## 为什么 token 不在配置里
 *
 * master-plan §6 禁令 6：密钥绝不写进配置文件。一次性 token 若落进配置，
 * 它会出现在设置面板、导出包、用户贴出来的截图里。所以它只作为 `summon()` 的参数存在，
 * 用完即弃——这也正好对上手册语料里「两端 token 不一致」那个坑：
 * 每次显式给，不一致会立刻表现为「连不上」，而不是「某天突然连不上」。
 *
 * ## 为什么没有尺寸 / 位置 / 透明度
 *
 * 手册 §6.3 六条里没有任何一条给这些参数。桌宠窗口的观感归上游实现（ondra-pet / agentpet
 * 自己的配置），本包再存一份就是双真源：用户在上游改了位置，本包的配置里还写着旧值，
 * 而两边谁生效没人说得清。唯一留下的是 `scale`——它影响的是「她有多大」这件
 * 用户第一眼会抱怨的事，且上游各实现的口径不一致，需要一个跨实现的中立值。
 */

import type { FieldSpecLike, RenderMode, SectionDeclLike } from './types.js'
import { RENDER_MODES } from './types.js'

/** 本插件配置。字段与 `FIELD_SPECS` 一一对应。 */
export interface Config {
  /** 总开关。 */
  readonly enable: boolean
  /** 用哪个生态桌宠（`dsh-pet` / `agentpet` / …；查 `adapters()`）。 */
  readonly adapter: string
  /** 渲染档。`live2d` 会被拒绝（§6.3）。 */
  readonly render: RenderMode
  /** 桥地址（`ws://127.0.0.1:端口/路径`）。空 = 不启动。 */
  readonly bridgeUrl: string
  /** 允许连接到桥的来源（Origin）。**空 = 全拒。** */
  readonly allowedOrigins: readonly string[]
  /** 一次性 token 有效期（毫秒）。 */
  readonly tokenTtlMs: number
  /** 是否允许 token 走 URL query（默认关：URL 会进日志）。 */
  readonly allowTokenInUrl: boolean
  /** 是否置顶。 */
  readonly alwaysOnTop: boolean
  /** 缩放（0.5–2）。 */
  readonly scale: number
  /** 每次操作打一行日志（**不含 token 与地址**）。 */
  readonly verbose: boolean
}

/** 段键。符合 §8.4。 */
export const CONFIG_SECTION_ID = 'pet'

/** 缩放下界 / 上界。 */
export const SCALE_FLOOR = 0.5

/** 缩放上界。 */
export const SCALE_CEIL = 2

/** token 有效期默认值（毫秒）。 */
export const TOKEN_TTL_MS = 120_000

/** token 有效期下界 / 上界（毫秒）。 */
export const TTL_FLOOR = 1_000

/** token 有效期上界（毫秒）。 */
export const TTL_CEIL = 600_000

/** 来源清单条数上限。 */
export const MAX_ORIGINS = 16

/** Config 键（camel）→ 段字段键（kebab）。 */
const KEY_PAIRS: Readonly<Record<keyof Config, string>> = Object.freeze({
  enable: 'enable',
  adapter: 'adapter',
  render: 'render',
  bridgeUrl: 'bridge-url',
  allowedOrigins: 'allowed-origins',
  tokenTtlMs: 'token-ttl-ms',
  allowTokenInUrl: 'allow-token-in-url',
  alwaysOnTop: 'always-on-top',
  scale: 'scale',
  verbose: 'verbose',
})

/** 查表版。 */
const KEY_MAP: ReadonlyMap<string, string> = new Map(Object.entries(KEY_PAIRS))

/** 出厂适配器：手册 §6.3 与 §1.8 都点名它为首选。 */
export const DEFAULT_ADAPTER = 'dsh-pet'

/** 字段声明表 —— 默认值的唯一存放处。 */
export const FIELD_SPECS: Readonly<Record<keyof Config, FieldSpecLike>> = Object.freeze({
  enable: {
    kind: 'boolean',
    default: false,
    doc: '桌宠入口开关。默认关：它会开一个独立窗口，而窗口是你桌面上的东西。',
  },
  adapter: {
    kind: 'string',
    default: DEFAULT_ADAPTER,
    pattern: '^[a-z][a-z0-9-]{1,31}$',
    doc: '用哪个生态桌宠：`dsh-pet`（首选）/ `agentpet`。`coopanion` 是 AGPL-3.0，会被拒。',
  },
  render: {
    kind: 'enum',
    values: RENDER_MODES,
    default: 'static',
    doc: '渲染档。**只有 `static` 可用**：Live2D 的 Cubism Core 专有且不可再分发（§6.3，1.0 阶段不做）。',
  },
  bridgeUrl: {
    kind: 'string',
    default: '',
    doc: '桌宠桥地址，必须回环 + `ws://`/`wss://` + 显式端口，例 `ws://127.0.0.1:19387/pet`。**空 = 不启动。**',
  },
  allowedOrigins: {
    kind: 'json',
    default: Object.freeze([] as readonly string[]),
    doc: '允许连到桥的来源（Origin），例 `http://localhost:5173`。**空 = 全拒**——不填就启动等于不校验 Origin（§9.2）。',
  },
  tokenTtlMs: {
    kind: 'number',
    default: TOKEN_TTL_MS,
    min: TTL_FLOOR,
    max: TTL_CEIL,
    advancedOnly: true,
    doc: '一次性 token 的有效期（毫秒）。给长了等于「一次性」失效。',
  },
  allowTokenInUrl: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '允许把 token 放在 URL query 里。默认关：URL 会进日志、崩溃报告与浏览器历史。',
  },
  alwaysOnTop: {
    kind: 'boolean',
    default: false,
    doc: '是否置顶。默认不置顶：她的窗口盖住你正在做的事，第一周就会被关掉。',
  },
  scale: {
    kind: 'number',
    default: 1,
    min: SCALE_FLOOR,
    max: SCALE_CEIL,
    doc: '缩放倍数（0.5–2）。上游各实现的「1 倍」口径不一，这是跨实现的中立值。',
  },
  verbose: {
    kind: 'boolean',
    default: false,
    advancedOnly: true,
    doc: '每次操作一行日志（**不含 token、不回显桥地址**）。',
  },
})

/** 运行期默认值。与 `FIELD_SPECS.default` 逐键同值。 */
export const DEFAULT_CONFIG: Config = Object.freeze({
  enable: false,
  adapter: DEFAULT_ADAPTER,
  render: 'static' as RenderMode,
  bridgeUrl: '',
  allowedOrigins: Object.freeze([] as readonly string[]),
  tokenTtlMs: TOKEN_TTL_MS,
  allowTokenInUrl: false,
  alwaysOnTop: false,
  scale: 1,
  verbose: false,
})

/** 段字段键（kebab）→ Config 键（camel）。 */
export const SECTION_KEYS: Readonly<Record<string, keyof Config>> = Object.freeze(
  Object.fromEntries(Object.entries(KEY_PAIRS).map(([camel, kebab]) => [kebab, camel as keyof Config])),
)

/** 查表版。 */
const SECTION_MAP: ReadonlyMap<string, keyof Config> = new Map(
  Object.entries(SECTION_KEYS) as readonly (readonly [string, keyof Config])[],
)

/** 交给 O-005 的段声明。 */
export const CONFIG_SECTION: SectionDeclLike = Object.freeze({
  id: CONFIG_SECTION_ID,
  title: '桌宠入口',
  fields: Object.freeze(
    Object.fromEntries(
      (Object.keys(KEY_PAIRS) as (keyof Config)[]).map(camel => [KEY_PAIRS[camel], FIELD_SPECS[camel]]),
    ),
  ) as Readonly<Record<string, FieldSpecLike>>,
  owner: 'ondra-pet',
})

/** 判空对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把用户层归一化成段字段键。
 * @param raw 原始配置。
 */
export function normalizeUserLayer(raw: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(raw)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    out[KEY_MAP.get(key) ?? key] = value
  }
  return out
}

/**
 * 把 O-005 的结果回填成 Config 形状。
 * @param values 解析结果 `values`。
 */
export function valuesToConfigShape(values: unknown): Record<string, unknown> {
  if (!isRecord(values)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    out[SECTION_MAP.get(key) ?? key] = value
  }
  return out
}

/**
 * 夹一个整数。
 * @param value 待夹值。
 * @param fallback 回退值。
 * @param min 下界。
 * @param max 上界。
 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * 夹一个浮点（缩放用，不取整）。
 * @param value 待夹值。
 * @param fallback 回退值。
 * @param min 下界。
 * @param max 上界。
 */
function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * 归一化渲染档。
 *
 * 未知值**回退 `static` 并报一条**，不抛错：一个拼错的 `live2D` 不该让整插件加载失败，
 * 但也不能静默变成默认值——所以它进 `configDriftOf()`。
 * @param value 原始值。
 * @param onBad 坏值回调。
 */
function normalizeRender(value: unknown, onBad: (text: string) => void): RenderMode {
  if (typeof value !== 'string') return 'static'
  const text = value.trim().toLowerCase()
  const hit = RENDER_MODES.find(mode => mode === text)
  if (hit === undefined) {
    onBad(value)
    return 'static'
  }
  return hit
}

/**
 * 归一化来源清单。
 *
 * 只做形状层面的收束（去空、去重、限条数），**不在这里判合法性**——
 * 合法性归 `checkOrigins()`，因为它要给出「哪一条错、错在哪」的指路。
 * 两处各判一次会出现「配置层说可以、启动层说不行」的分叉。
 * @param value 原始值。
 * @param onBad 坏条目回调。
 */
function normalizeOrigins(value: unknown, onBad: (text: string) => void): readonly string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') {
      onBad(String(item))
      continue
    }
    const text = item.trim()
    if (text === '') continue
    if (!out.includes(text)) out.push(text)
  }
  if (out.length > MAX_ORIGINS) {
    onBad(`更多 ${out.length - MAX_ORIGINS} 条`)
    return Object.freeze(out.slice(0, MAX_ORIGINS))
  }
  return Object.freeze(out)
}

/**
 * 归一化适配器 id。
 * @param value 原始值。
 * @param onBad 坏值回调。
 */
function normalizeAdapter(value: unknown, onBad: (text: string) => void): string {
  if (typeof value !== 'string') return DEFAULT_ADAPTER
  const text = value.trim().toLowerCase()
  if (text === '') return DEFAULT_ADAPTER
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(text)) {
    onBad(value)
    return DEFAULT_ADAPTER
  }
  return text
}

/**
 * 补全并夹紧配置。**永不抛错**。
 * @param value 原始配置。
 * @param onBad 坏条目回调。
 */
export function completeConfig(value: unknown, onBad?: (text: string, kind: string) => void): Config {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const report = (text: string, kind: string): void => {
    if (onBad !== undefined) onBad(text, kind)
  }

  const bool = (key: keyof Config, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === true

  const render =
    raw['render'] === undefined ? DEFAULT_CONFIG.render : normalizeRender(raw['render'], t => report(t, 'render'))
  const adapter =
    raw['adapter'] === undefined ? DEFAULT_ADAPTER : normalizeAdapter(raw['adapter'], t => report(t, 'adapter'))
  const origins =
    raw['allowedOrigins'] === undefined
      ? DEFAULT_CONFIG.allowedOrigins
      : normalizeOrigins(raw['allowedOrigins'], t => report(t, 'allowedOrigins'))
  const bridgeUrl =
    raw['bridgeUrl'] === undefined
      ? ''
      : typeof raw['bridgeUrl'] === 'string'
        ? raw['bridgeUrl'].trim()
        : ''

  return Object.freeze({
    enable: bool('enable', DEFAULT_CONFIG.enable),
    adapter,
    render,
    bridgeUrl,
    allowedOrigins: origins,
    tokenTtlMs: clampInt(raw['tokenTtlMs'], DEFAULT_CONFIG.tokenTtlMs, TTL_FLOOR, TTL_CEIL),
    allowTokenInUrl: bool('allowTokenInUrl', DEFAULT_CONFIG.allowTokenInUrl),
    alwaysOnTop: bool('alwaysOnTop', DEFAULT_CONFIG.alwaysOnTop),
    scale: clampFloat(raw['scale'], DEFAULT_CONFIG.scale, SCALE_FLOOR, SCALE_CEIL),
    verbose: bool('verbose', DEFAULT_CONFIG.verbose),
  })
}

/**
 * 配置有没有被悄悄改过（夹紧、回退、丢条目）。
 *
 * 只报「用户给的值与最终生效的值不一样」的字段。`tokenMinLength` 之类派生值不进这里——
 * 它们不是用户填的，报出来只会让人去找一个不存在的配置项。
 * @param value 原始配置。
 */
export function configDriftOf(value: unknown): readonly string[] {
  const raw: Record<string, unknown> = isRecord(value) ? value : {}
  const drift: string[] = []

  const numeric: readonly (readonly [string, number, number])[] = [
    ['tokenTtlMs', TTL_FLOOR, TTL_CEIL],
    ['scale', SCALE_FLOOR, SCALE_CEIL],
  ]
  for (const [key, min, max] of numeric) {
    const given = raw[key]
    if (given === undefined) continue
    if (typeof given !== 'number' || !Number.isFinite(given) || given < min || given > max) drift.push(key)
  }

  const givenRender = raw['render']
  if (typeof givenRender === 'string' && givenRender.trim() !== '') {
    const text = givenRender.trim().toLowerCase()
    if (!RENDER_MODES.some(mode => mode === text)) drift.push('render')
  }

  const givenAdapter = raw['adapter']
  if (typeof givenAdapter === 'string' && givenAdapter.trim() !== '') {
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(givenAdapter.trim().toLowerCase())) drift.push('adapter')
  }

  const givenOrigins = raw['allowedOrigins']
  if (Array.isArray(givenOrigins) && givenOrigins.length > MAX_ORIGINS) drift.push('allowedOrigins')

  return drift
}
