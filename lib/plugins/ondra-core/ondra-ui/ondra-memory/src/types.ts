/** 记忆的形状。所有字段都能被序列化——一条记忆要能原样写进 JSONL 再从盘上读回来。 */
export interface MemoryPoint {
  /** 稳定 id，抽取时生成，去重与合并以它为准。 */
  id: string
  /** 记忆正文，一句话。长于此的文本应先被归纳，而不是整段塞进来。 */
  text: string
  /** 分类：事实 / 偏好 / 事件 / 关于她自己的。 */
  kind: 'fact' | 'preference' | 'event' | 'self'
  /** 首次写下的时间（毫秒）。 */
  createdAt: number
  /** 最近一次被引用（召回命中）的时间；衰减只看这个。 */
  lastUsedAt: number
  /** 被引用次数，影响排序，不影响是否淘汰。 */
  hits: number
  /** 与哪些记忆相关（双向存一份，读的时候取并集）。 */
  links: string[]
}

/** 召回结果：带上「为什么是这条」，界面与提示词都要能解释。 */
export interface RecallHit {
  point: MemoryPoint
  score: number
  reason: 'linked' | 'recent' | 'keyword'
}

/** 服务对外的方法名，单独一处，避免拼写漂移。 */
export const MEMORY_SERVICE = 'memory'
