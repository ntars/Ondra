/**
 * 设置左栏的分类表：把 65 个配置段按「使用者要解决什么问题」分组。
 *
 * ## 为什么不是按插件分组
 *
 * 插件名回答的是「谁写的这段代码」，用户问的是「我想让她少说两句，去哪儿改」。
 * 上一版的教训写得很清楚：123 个配置段平铺，用户找不到任何一个旋钮。
 *
 * 四组的顺序也是这个道理：先她是谁（人设），再她记得什么（记忆与情绪），
 * 再她什么时候开口（主动与节奏），最后才是程序怎么跑（运行与安全）。
 * 越靠前越像「她」，越靠后越像「机器」。
 *
 * ## 分类表是源码事实快照，不是运行时推断
 *
 * 下面的段 id 全部来自各插件 `settings.ts` 的 `CONFIG_SECTION_ID`（盘点于
 * 本版 65 段）。新增插件后必须同步本表，否则它会被兜底归到「运行与安全」
 * ——那仍然可见，只是位置不对。兜底存在是为了「不准丢」，不是为了让分类
 * 可以偷懒。
 *
 * ## 为什么段 id 不复用 `SCENE_ITEMS` 的写法
 *
 * 场景层是「12 个真实旋钮」，这里要的是「65 个段各自的归属」。两件事，
 * 一张表不能同时干。
 */

/** 四个分类的稳定标识。顺序即渲染顺序。 */
export type SettingsCategoryId = 'persona' | 'memory' | 'pace' | 'runtime'

/** 一个分类。 */
export interface SettingsCategory {
  readonly id: SettingsCategoryId
  /** 左栏与分组头显示的名字。 */
  readonly name: string
  /** 一句说明：这一组回答什么问题。 */
  readonly subtitle: string
  /** 组内段 id，顺序即显示顺序。 */
  readonly sections: readonly string[]
}

/**
 * 人设与表达：她是谁、怎么说话、发出什么声音。
 *
 * 顺序按「基础 → 进阶」：装上人设包 → 变量与拼装 → 世界书 → 演化与工坊。
 */
const PERSONA_SECTIONS: readonly string[] = Object.freeze([
  'persona-loader',
  'persona-core',
  'persona-vars',
  'persona-assemble',
  'worldbook',
  'persona-evolve',
  'first-meet',
  'onboarding',
  'live',
  'lexicon',
  'oral',
  'expression-decide',
  'tts',
  'tts-gate',
  'asr',
  'vision',
])

/**
 * 记忆与情绪：她记得什么、怎么忘、情绪怎么起伏。
 *
 * 前半是记忆的写入与召回，后半是情绪与关系。读的人关心的是「她记不记得」，
 * 不是「哪个插件在做」。
 */
const MEMORY_SECTIONS: readonly string[] = Object.freeze([
  'memory-core',
  'memory-extract',
  'memory-recall',
  'memory-dedupe',
  'memory-decay',
  'memory-graph',
  'memory-pool',
  'memory-recognition',
  'memory-prospective',
  'memory-audit',
  'memory-humanlike',
  'memory-dream',
  'memory-heal',
  'memory-vector',
  'multimodal-memory',
  'evidence-gate',
  'inject-dedupe',
  'emotion-core',
  'emotion-diffuse',
  'emotion-stage',
  'emotion-project',
  'emotion-express',
  'drive-gap',
  'forget-right',
])

/**
 * 主动与节奏：她什么时候开口、说多快、什么时候安静。
 *
 * 主动三件套在前（她会不会突然说话），节奏与作息在后（说话的样子）。
 */
const PACE_SECTIONS: readonly string[] = Object.freeze([
  'proactive-gate',
  'proactive-quota',
  'proactive-reason',
  'rhythm',
  'rhythm-typing',
  'life-rhythm',
  'breath',
  'absence',
  'crisis',
  'dialogue',
  'dialogue-protocol',
])

/**
 * 运行与安全：程序怎么跑。多数人一辈子不用进来，但它必须在场。
 */
const RUNTIME_SECTIONS: readonly string[] = Object.freeze([
  'privacy',
  'sandbox',
  'llm-gateway',
  'prompt-inject',
  'filter-chain',
  'store-json',
  'window',
  'port-picker',
  'installer',
  'install-doctor',
  'startup-check',
  'process-host',
  'organ-host',
  'organ-gate',
])

/** 四个分类，顺序即渲染顺序。 */
export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = Object.freeze([
  { id: 'persona', name: '人设与表达', subtitle: '她是谁、怎么说话、发出什么声音', sections: PERSONA_SECTIONS },
  { id: 'memory', name: '记忆与情绪', subtitle: '她记得什么、怎么忘、情绪怎么起伏', sections: MEMORY_SECTIONS },
  { id: 'pace', name: '主动与节奏', subtitle: '她什么时候开口、说多快、什么时候安静', sections: PACE_SECTIONS },
  { id: 'runtime', name: '运行与安全', subtitle: '模型接入、注入链、进程与安装', sections: RUNTIME_SECTIONS },
])

/**
 * 高风险段：改了会影响别的程序、或放宽了机器访问边界。
 *
 * 不是「危险系数排名」——它只回答一个问题：这一段的改动要不要先提醒一句。
 * 界面上的用法是段头挂一枚「高风险」标，不做二次确认（改配置不是执行动作）。
 */
export const HIGH_RISK_SECTIONS: ReadonlySet<string> = new Set([
  'privacy',
  'sandbox',
  'organ-host',
  'organ-gate',
])

/**
 * 未列进任何分类的段落在哪一组。
 *
 * 兜底必须存在：新插件装进来时，它的段绝不能因为「忘了更新分类表」而消失。
 * 落到最末一组，位置不对但可见——「找得到」比「顺序对」重要。
 */
const FALLBACK: SettingsCategoryId = 'runtime'

/**
 * 已有**专门页面**承载的段：扩展功能的模块层不再重复列出它们。
 *
 * ## 为什么需要这张表
 *
 * 人物设定页的四张卡（朗读声音 / 说话口吻 / 说话节奏 / 说话的规矩）各自
 * 只绑了对应段的 `enable` 一个开关，而那个段还有十几个字段留在扩展功能里。
 * 结果是同一件事被劈成两处，且**界面自己在提示这件事**——`VoiceCard` 的
 * 末尾原话是「想让她什么都念，可以在『模块』里调闸门的三个数」。
 *
 * 用户读到这句的处境是：我在「她怎么说话」这一页，却被指去「底层每个字段
 * 是什么」那一页。这不是提示不清楚，是归属错了。
 *
 * ## 判据：这个段的主要旋钮属于哪个问题
 *
 * 一张表按「这个问题归谁回答」判定，不按「哪个插件提供」判定：
 *
 * | 段 | 归谁 | 理由 |
 * | --- | --- | --- |
 * | `tts` / `tts-gate` | 人物设定 · 朗读声音 | 她的声音是什么样的 |
 * | `oral` | 人物设定 · 说话口吻 | 她怎么用词、加不加语气词 |
 * | `rhythm` / `rhythm-typing` | 人物设定 · 说话节奏 | 分几条、多快、停顿多久 |
 * | `filter-chain` | 人物设定 · 说话的规矩 | 什么话不说、说什么会拦 |
 * | `persona-vars` | 人物设定 · 人设包 | 她叫什么、怎么称呼你 |
 * | `lexicon` | 人物设定 · 说话口吻 | 她学谁的语感、学多久、带几个语气词 |
 * | `expression-decide` | 人物设定 · 说话口吻 | 什么时候配表情、门槛多高 |
 * | `life-rhythm` / `proactive-gate` / `proactive-quota` / `proactive-reason` | 通用 · 主动发言 | 她什么时候开口、什么时候安静 |
 * | `memory-core` / `memory-decay` / `memory-audit` | 人物设定 · 记忆 | 她记多久、怎么忘 |
 *
 * `window` **没有**上移：它的字段是 `platform` / `patch-target` /
 * `expected-versions`，那是给窗口打补丁的开发配置，不是「窗口怎么开」。
 * 放进通用页会让普通用户看到一串他自己不会填的键。
 *
 * 未列入的段（`privacy` / `sandbox` / `installer` / `llm-gateway` 等）
 * 仍留在扩展功能：它们回答的是「程序怎么跑」，没有日常页面收它们。
 */
export const DEDICATED_SECTIONS: ReadonlySet<string> = new Set([
  'tts',
  'tts-gate',
  'oral',
  'rhythm',
  'rhythm-typing',
  'filter-chain',
  'persona-vars',
  'lexicon',
  'expression-decide',
  'life-rhythm',
  'proactive-gate',
  'proactive-quota',
  'proactive-reason',
  'memory-core',
  'memory-decay',
  'memory-audit',
])

/**
 * 这一段是否已由专门页面承载。
 *
 * @param sectionId 段 id。
 * @returns 是则扩展功能不应再列出它。
 */
export function isDedicated(sectionId: string): boolean {
  return DEDICATED_SECTIONS.has(sectionId)
}

/**
 * 段 id → 分类 id。
 *
 * 在模块加载时建一次，之后查表是 O(1)。65 个段的线性查找发生在每次渲染，
 * 是那种「看不出慢但一直在做」的开销。
 */
const SECTION_INDEX: ReadonlyMap<string, SettingsCategoryId> = (() => {
  const index = new Map<string, SettingsCategoryId>()
  for (const category of SETTINGS_CATEGORIES) {
    for (const id of category.sections) index.set(id, category.id)
  }
  return index
})()

/**
 * 查一个段属于哪一类。
 *
 * @param sectionId 段 id。
 * @returns 分类 id；表里没有的一律兜底到「运行与安全」。
 */
export function categoryOfSection(sectionId: string): SettingsCategoryId {
  return SECTION_INDEX.get(sectionId) ?? FALLBACK
}

/**
 * 这一段是否标着高风险。
 *
 * @param sectionId 段 id。
 * @returns 是否高风险。
 */
export function isHighRisk(sectionId: string): boolean {
  return HIGH_RISK_SECTIONS.has(sectionId)
}
