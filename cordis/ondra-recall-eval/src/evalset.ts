/**
 * 题集的解析与「真值落地」。**纯函数，不碰 ctx**。
 *
 * 这个文件存在的唯一理由，是一条被库重建逼出来的事实：
 *
 * > 如果评估集的真值只写记忆 id，那么库一重建、一搬迁、一导入导出，
 * > 全部题目会一起变成 `missing`，报告显示 recall 从 0.72 掉到 0.00，
 * > 而代码一个字都没改。
 *
 * 所以真值支持两种写法，且**正文优先**：
 *
 * | 写法 | 优点 | 缺点 | 用在 |
 * |---|---|---|---|
 * | `expect: ["她说的那句原文片段"]` | 换库不失效 | 需要 ≥4 字才不歧义 | 长期题集（推荐） |
 * | `expectIds: ["mem-001"]` | 快、精确 | 换库即失效 | 一次性排查 |
 *
 * 解析出来的四种状态（`ExpectResolution`）：
 * - `id`：`expectIds` 命中；
 * - `text`：指纹唯一命中（**跨库仍有效的那一种**）；
 * - `ambiguous`：指纹命中多条 → 题目本身不可判，**剔除且报出来**；
 * - `missing`：一条都没命中 → 题目失效，**剔除且报出来**。
 *
 * 后两种被剔除，而不是按 0 分计入。理由见 `types.ts` 文件头第 3 条：
 * 「不可判」与「召回失败」是两件事，混在一起就会让一次库重建看起来像一次性能退化。
 */

import { EvalError } from './types.js'
import type {
  CaseKind,
  EvalCaseSpec,
  EvalSetSpec,
  ExpectResolution,
  MemoryRecordLike,
  ResolvedCase,
  SkippedCase,
} from './types.js'
import { CASE_KINDS } from './types.js'

/** 指纹归一化时剥掉的字符：空白、标点、符号。数字与字母（含中文）保留。 */
const NOISE_PATTERN = /[\s\p{P}\p{S}]+/gu

/**
 * 模板占位标记。
 *
 * `seed()` 无法把「这题还没填」这个事实写进 schema 之外的地方
 * （`parseSet` 只认契约里的字段），所以把标记放在问法开头。
 * 好处：人一眼看得见、机器一眼判得出、填的时候顺手删掉。
 */
export const TEMPLATE_MARK = '【待改写】'

/**
 * 归一化一段文本，供指纹比对。
 *
 * 剥掉空白、标点与符号（`\p{P}` + `\p{S}`），并转小写。
 * **不剥数字与字母**：`28 岁` 与 `1280` 的区别必须保住——
 * 手册里「`28` 不能匹配到 `1280`」那个子串陷阱，正是这类判定最容易踩的坑。
 * @param text 原始文本。
 */
export function fingerprintOf(text: string): string {
  return text.replace(NOISE_PATTERN, '').toLowerCase()
}

/** 判断是不是字符串数组。 */
function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/**
 * 校验并解析一份题集。
 *
 * **坏题集一律抛错，不静默跳过**：跳过一道题，报告就少测一件事，
 * 而报告上只会显示「30 题」变成「29 题」——没人会注意。
 * @param raw 磁盘读出来的 JSON（或调用方直接给的题集）。
 * @param fallbackName 题集没写名字时用哪个。
 */
export function parseSet(raw: unknown, fallbackName: string): EvalSetSpec {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new EvalError('bad-set', '题集不是一个 JSON 对象')
  }
  const obj = raw as Record<string, unknown>
  const casesRaw = obj['cases']
  if (!Array.isArray(casesRaw)) {
    throw new EvalError('bad-set', '题集缺少 cases 数组')
  }

  const seen = new Set<string>()
  const cases: EvalCaseSpec[] = []
  for (let index = 0; index < casesRaw.length; index += 1) {
    const item = casesRaw[index]
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new EvalError('bad-set', `第 ${index + 1} 题不是一个对象`)
    }
    const row = item as Record<string, unknown>
    const id = row['id']
    if (typeof id !== 'string' || id.trim() === '') {
      throw new EvalError('bad-set', `第 ${index + 1} 题缺少 id`)
    }
    if (seen.has(id)) {
      throw new EvalError('bad-set', `题号「${id}」重复`)
    }
    seen.add(id)

    const query = row['query']
    if (query !== undefined && typeof query !== 'string') {
      throw new EvalError('bad-set', `题「${id}」的 query 不是字符串`)
    }

    const kindRaw = row['kind']
    let kind: CaseKind | undefined
    if (kindRaw !== undefined) {
      if (typeof kindRaw !== 'string' || !(CASE_KINDS as readonly string[]).includes(kindRaw)) {
        throw new EvalError('bad-set', `题「${id}」的 kind 只能是 real / paraphrase / fabricated`)
      }
      kind = kindRaw as CaseKind
    }

    const expect = row['expect']
    if (expect !== undefined && !isStringArray(expect)) {
      throw new EvalError('bad-set', `题「${id}」的 expect 必须是字符串数组`)
    }
    const expectIds = row['expectIds']
    if (expectIds !== undefined && !isStringArray(expectIds)) {
      throw new EvalError('bad-set', `题「${id}」的 expectIds 必须是字符串数组`)
    }

    const of = row['of']
    const note = row['note']
    cases.push({
      id,
      ...(kind === undefined ? {} : { kind }),
      query: typeof query === 'string' ? query : '',
      ...(expect === undefined ? {} : { expect }),
      ...(expectIds === undefined ? {} : { expectIds }),
      ...(typeof of === 'string' ? { of } : {}),
      ...(typeof note === 'string' ? { note } : {}),
    })
  }

  const name = typeof obj['name'] === 'string' && obj['name'] !== '' ? obj['name'] : fallbackName
  return Object.freeze({ version: 1, name, cases: Object.freeze(cases) })
}

/** 真值解析的选项。 */
export interface ResolveOptions {
  /** 指纹最短长度。 */
  readonly minFingerprintChars: number
  /**
   * 全库正文。为 `undefined` 表示**不能按文本解析**（记忆内核缺席）：
   * 此时只认 `expectIds`，写了 `expect` 的题会被判 `missing` 并给出原因，
   * 而不是悄悄当 0 分。
   */
  readonly corpus: readonly MemoryRecordLike[] | undefined
}

/** 一题的解析结果。 */
export interface CaseResolution {
  /** 解析后的题。 */
  readonly resolved: ResolvedCase
  /** 被剔除时给原因；正常为 `undefined`。 */
  readonly skip?: SkippedCase
}

/** 归一化后的库（只建一次，逐题复用）。 */
interface NormalizedCorpus {
  readonly ids: readonly string[];
  readonly texts: readonly string[]
}

/** 建归一化库。 */
function normalizeCorpus(corpus: readonly MemoryRecordLike[]): NormalizedCorpus {
  return {
    ids: corpus.map(item => item.id),
    texts: corpus.map(item => fingerprintOf(item.text)),
  }
}

/**
 * 一次指纹查找的结果。
 *
 * `exact` 是「指纹与某条正文归一化后完全相等」，`false` 表示走的是子串包含。
 * 两者必须分开传出去：子串包含会误命中（`28` ⊂ `1280`、`喜欢猫` ⊂ `不喜欢猫`），
 * 而误命中只会让 `recall` 悄悄变高、不报任何错。
 */
interface TextLookup {
  readonly ids: readonly string[]
  readonly exact: boolean
}

/**
 * 按指纹找 id。
 *
 * 先比**完全相等**，再退到**包含**。顺序很重要：正文完全相等是唯一的
 * 「就是这条」，而包含可能是「这条里提到了那条」。先相等再包含，
 * 能让「指纹正好是整条正文」的题不被旁边一条更长的正文抢走。
 * @param needle 归一化后的指纹。
 * @param corpus 归一化库。
 * @param minChars 最短长度。
 */
function lookupByText(needle: string, corpus: NormalizedCorpus, minChars: number): TextLookup {
  if (needle.length < minChars) return { ids: [], exact: false }
  const exact: string[] = []
  for (let index = 0; index < corpus.texts.length; index += 1) {
    if (corpus.texts[index] !== needle) continue
    const id = corpus.ids[index]
    if (id !== undefined) exact.push(id)
  }
  if (exact.length > 0) return { ids: exact, exact: true }
  const partial: string[] = []
  for (let index = 0; index < corpus.texts.length; index += 1) {
    const text = corpus.texts[index]
    const id = corpus.ids[index]
    if (text !== undefined && id !== undefined && text.includes(needle)) partial.push(id)
  }
  return { ids: partial, exact: false }
}

/**
 * 解析一道题的真值。
 * @param spec 题目定义。
 * @param options 选项。
 * @param corpus 归一化库（可能为 `undefined`）。
 */
function resolveOne(spec: EvalCaseSpec, options: ResolveOptions, corpus: NormalizedCorpus | undefined): CaseResolution {
  const kind: CaseKind = spec.kind ?? 'real'

  // 编造题没有真值——这是定义，不是缺项。写了 expect 就忽略并留痕（在报告 notes 里）。
  if (kind === 'fabricated') {
    return {
      resolved: Object.freeze({
        id: spec.id,
        kind,
        query: spec.query,
        expected: Object.freeze([]),
        resolution: 'none',
        match: 'none',
        ...(spec.of === undefined ? {} : { of: spec.of }),
        ...(spec.note === undefined ? {} : { note: spec.note }),
      }),
    }
  }

  const base = {
    id: spec.id,
    kind,
    query: spec.query,
    ...(spec.of === undefined ? {} : { of: spec.of }),
    ...(spec.note === undefined ? {} : { note: spec.note }),
  }

  // 1. 先认精确 id。
  const wantIds = spec.expectIds ?? []
  if (wantIds.length > 0) {
    return {
      resolved: Object.freeze({
        ...base,
        expected: Object.freeze([...wantIds]),
        resolution: 'id' as ExpectResolution,
        match: 'id',
      }),
    }
  }

  // 2. 再认文本指纹。
  const wants = spec.expect ?? []
  if (wants.length === 0) {
    return {
      resolved: Object.freeze({
        ...base,
        expected: Object.freeze([]),
        resolution: 'missing' as ExpectResolution,
        match: 'none',
      }),
      skip: Object.freeze({
        id: spec.id,
        resolution: 'missing',
        reason: '没有写 expect / expectIds，无法判断这题该想起什么',
      }),
    }
  }
  if (corpus === undefined) {
    return {
      resolved: Object.freeze({
        ...base,
        expected: Object.freeze([]),
        resolution: 'missing' as ExpectResolution,
        match: 'none',
      }),
      skip: Object.freeze({
        id: spec.id,
        resolution: 'missing',
        reason: '没有记忆内核（ondra-memory-core），只能按 expectIds 解析；这题写的是正文指纹',
      }),
    }
  }

  const found: string[] = []
  const ambiguous: string[] = []
  const missing: string[] = []
  let anyPartial = false
  for (const want of wants) {
    const needle = fingerprintOf(want)
    if (needle === '') {
      missing.push(want)
      continue
    }
    const look = lookupByText(needle, corpus, options.minFingerprintChars)
    const only = look.ids.length === 1 ? look.ids[0] : undefined
    if (only !== undefined) {
      found.push(only)
      // 只要有一条走的是子串包含，整题就标 partial——它可能不是那条记忆。
      if (!look.exact) anyPartial = true
    } else if (look.ids.length === 0) {
      missing.push(want)
    } else {
      ambiguous.push(`${want}（命中 ${look.ids.length} 条）`)
    }
  }

  // 有一条指纹不可判，整题就不可判：残缺的真值集会让 recall 分子分母错位。
  if (ambiguous.length > 0) {
    return {
      resolved: Object.freeze({
        ...base,
        expected: Object.freeze([]),
        resolution: 'ambiguous' as ExpectResolution,
        match: 'none',
      }),
      skip: Object.freeze({
        id: spec.id,
        resolution: 'ambiguous',
        reason: `真值指纹不唯一：${ambiguous.join('、')}。把指纹写长一点，或改用 expectIds`,
      }),
    }
  }
  if (missing.length > 0) {
    return {
      resolved: Object.freeze({
        ...base,
        expected: Object.freeze([]),
        resolution: 'missing' as ExpectResolution,
        match: 'none',
      }),
      skip: Object.freeze({
        id: spec.id,
        resolution: 'missing',
        reason: `库里找不到：${missing.join('、')}。可能是这条记忆已被删/改成别的说法，或指纹少于 ${options.minFingerprintChars} 字`,
      }),
    }
  }

  return {
    resolved: Object.freeze({
      ...base,
      expected: Object.freeze([...new Set(found)]),
      resolution: 'text' as ExpectResolution,
      match: anyPartial ? 'partial' : 'exact',
    }),
  }
}

/**
 * 批量解析。
 * @param cases 题目定义。
 * @param options 选项。
 */
export function resolveCases(
  cases: readonly EvalCaseSpec[],
  options: ResolveOptions,
): readonly CaseResolution[] {
  const corpus = options.corpus === undefined ? undefined : normalizeCorpus(options.corpus)
  return cases.map(spec => resolveOne(spec, options, corpus))
}

/**
 * 数一遍各类题。
 * @param cases 题目定义。
 */
export function countKinds(cases: readonly EvalCaseSpec[]): Readonly<Record<CaseKind, number>> {
  const counts: Record<CaseKind, number> = { real: 0, paraphrase: 0, fabricated: 0 }
  for (const item of cases) counts[item.kind ?? 'real'] += 1
  return Object.freeze(counts)
}

/**
 * 题集中还有几道「模板没填」。
 *
 * 两种都算没填：问法为空串，或 `query` 是 `seed()` 塞进去的正文占位
 * （那时 `seed()` 会同时写 `needsRewrite: true`，本函数也会因为解析出的 spec
 * 丢掉这个字段而看不到——所以 `seed()` 生成的模板必须在 `query` 前面加标记词，
 * 见 `report.ts` 的 `TEMPLATE_MARK`）。
 * @param cases 题目定义。
 */
export function countUnfilled(cases: readonly EvalCaseSpec[]): number {
  let count = 0
  for (const item of cases) {
    if (item.query.trim() === '') count += 1
    else if (item.query.startsWith(TEMPLATE_MARK)) count += 1
  }
  return count
}
