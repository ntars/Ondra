/**
 * 体检：八项判据，**全是元数据判定**，不读正文、不调模型。
 *
 * ## 为什么正好是这八项
 *
 * 判据必须满足两个条件才配进这张表：
 *
 * 1. **能用 O-020 已给的元数据判定**（`PersonaDetail` 字段 + 文件清单 + 字符数）。
 * 2. **不合格时用户知道该改哪儿**。凡是「读一读才知道好不好」的（文笔、像不像、
 *    有没有 OOC），一律不进——那是验收测试集（O-118）与人的事，硬塞进来只会
 *    产出一堆用户无法处理的抱怨。
 *
 * ## `skip` 与 `fail` 必须分开
 *
 * 没装 O-021 时，槽位这项查不了。如果记成 `fail`，用户会去改一个其实没问题的包，
 * 而且改完还是 `fail`（因为查不了），于是永远修不好。所以 `skip` 单列，
 * 且**不进健康分的分母**。
 */

import {
  CHECK_IDS,
  PROFILE_FIELDS_MIN,
  SKILL_CHARS_MAX,
  SKILL_CHARS_MIN,
  TRIGGER_WORDS_MAX,
} from './types.js'
import type {
  BoundaryLike,
  CheckId,
  CheckResult,
  CheckStatus,
  CoreLike,
  PersonaDetailLike,
} from './types.js'

/** 六槽位的中文名（只用于「缺了哪几个」的说明；判据本身来自 O-021）。 */
const SLOT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  identity: '身份锚定',
  voice: '说话方式',
  drive: '底层机制',
  scene: '场景与连续',
  format: '回复格式',
  selfcheck: '发出前自检',
})

/** 构造一条 pass / warn / fail。 */
function result(
  id: CheckId,
  title: string,
  status: CheckStatus,
  criterion: string,
  evidence: string,
  suggestion: string,
): CheckResult {
  return Object.freeze({ id, title, status, criterion, evidence, suggestion })
}

/**
 * 第 1 项：id 与包文件名是否对得上。
 *
 * 判据：包文件名去掉 `.skill.zip` 后，要么等于 `meta.slug`，要么包内没有 slug
 * （O-020 会用文件名兜底）。对不上说明「用户以为装的是 A、实际装成了 B」，
 * 这在列表里是完全看不出来的，必须报出来。
 * @param detail 人设详情。
 */
function checkIdMatch(detail: PersonaDetailLike): CheckResult {
  const id = detail.id
  const fileStem = detail.archiveName.replace(/\.skill\.zip$/i, '')
  const same = fileStem === id
  // 中文包名（无 slug）本来就对不上，那是正常形态，不是问题——O-020 明确允许。
  const asciiName = /^[\x20-\x7e]+$/.test(fileStem)
  if (same) {
    return result('id-match', 'id 与包名', 'pass', '包文件名应与 meta.slug 一致', `一致（${id}）`, '')
  }
  if (!asciiName) {
    return result(
      'id-match',
      'id 与包名',
      'pass',
      '包文件名应与 meta.slug 一致',
      `中文包名「${fileStem}」，id 取自 meta.slug（${id}）`,
      '',
    )
  }
  return result(
    'id-match',
    'id 与包名',
    'warn',
    '包文件名应与 meta.slug 一致',
    `文件名「${fileStem}」与 id「${id}」不一致`,
    '把 meta.json 的 slug 改成与文件名一致，或把包文件改名——两者不一致时，用户很难在列表里认出哪个是哪个。',
  )
}

/**
 * 第 2 项：`meta.files` 是否把包内文件都登记了。
 *
 * 判据：未声明文件占比超过一半即 warn。**不要求 100%**：两个实包都有未声明文件
 * （`README.md` 之类），严格要求会把所有人都打成不合格。
 * @param detail 人设详情。
 */
function checkMetaDeclared(detail: PersonaDetailLike): CheckResult {
  const total = detail.files.length
  const declared = detail.files.filter(item => item.declared).length
  const ratio = total === 0 ? 0 : declared / total
  const evidence = `包内 ${String(total)} 个文件，其中 ${String(declared)} 个在 meta.files 里声明过`
  if (total === 0) {
    return result('meta-declared', '文件登记', 'fail', 'meta.files 应登记包内主要文件', '包内没有文件', '这个包是空的，重新打包一份。')
  }
  if (ratio >= 0.5) {
    return result('meta-declared', '文件登记', 'pass', 'meta.files 应登记包内主要文件', evidence, '')
  }
  return result(
    'meta-declared',
    '文件登记',
    'warn',
    'meta.files 应登记包内主要文件',
    evidence,
    '在 meta.json 的 files 里补上这些文件的说明。没登记的进不了渐进披露索引，模型就不知道有这么个文件可读。',
  )
}

/**
 * 第 3 项：`SKILL.md` 篇幅是否在合理区间。
 *
 * 阈值见 `types.ts` 的 `SKILL_CHARS_MIN` / `SKILL_CHARS_MAX`，都是工程取值：
 * 下限参照两个实包（19982 与另一个过万的量级）取 6000；
 * 上限 60000 是「一篇塞太满，模型反而抓不住重点」的量级。
 * @param detail 人设详情。
 */
function checkSkillSize(detail: PersonaDetailLike): CheckResult {
  const chars = detail.skillChars
  if (chars <= 0) {
    return result(
      'skill-size',
      'SKILL.md 篇幅',
      'fail',
      'SKILL.md 应可读且篇幅适中',
      '没读到 SKILL.md',
      '补一个 SKILL.md。它是运行入口——没有它，人设能在列表里看到，但组装不出内核。',
    )
  }
  if (chars < SKILL_CHARS_MIN) {
    return result(
      'skill-size',
      'SKILL.md 篇幅',
      'warn',
      'SKILL.md 应可读且篇幅适中',
      `${String(chars)} 字，低于 ${String(SKILL_CHARS_MIN)} 字的参考下限`,
      '补厚一点：身份、说话方式、驱动力、场景这四块各写一段，通常就够了。',
    )
  }
  if (chars > SKILL_CHARS_MAX) {
    return result(
      'skill-size',
      'SKILL.md 篇幅',
      'warn',
      'SKILL.md 应可读且篇幅适中',
      `${String(chars)} 字，高于 ${String(SKILL_CHARS_MAX)} 字的参考上限`,
      '把细节挪到 references/ 里按需读，SKILL.md 只留每次都要进提示词的部分。',
    )
  }
  return result('skill-size', 'SKILL.md 篇幅', 'pass', 'SKILL.md 应可读且篇幅适中', `${String(chars)} 字`, '')
}

/**
 * 第 4 项：六个槽位到齐几个。**需要 O-021 在位**，缺席即 `skip`。
 * @param detail 人设详情。
 * @param core O-021 服务；缺席为 `undefined`。
 */
function checkSlotCoverage(detail: PersonaDetailLike, core: CoreLike | undefined): CheckResult {
  if (core === undefined || !core.available) {
    return result(
      'slot-coverage',
      '六槽位覆盖',
      'skip',
      '身份 / 说话 / 驱动力 / 场景 / 格式 / 自检 六块应齐全',
      '人格内核服务（ondra-persona-core）未装载，查不了',
      '',
    )
  }
  let kernel: ReturnType<CoreLike['kernel']>
  try {
    kernel = core.kernel(detail.id)
  } catch {
    return result(
      'slot-coverage',
      '六槽位覆盖',
      'skip',
      '身份 / 说话 / 驱动力 / 场景 / 格式 / 自检 六块应齐全',
      '读内核时出错，本次跳过（不算不合格）',
      '',
    )
  }
  if (kernel === undefined) {
    return result(
      'slot-coverage',
      '六槽位覆盖',
      'skip',
      '身份 / 说话 / 驱动力 / 场景 / 格式 / 自检 六块应齐全',
      '这个包没组装出内核（可能缺 SKILL.md）',
      '',
    )
  }
  const missing = kernel.missing
  if (missing.length === 0) {
    return result('slot-coverage', '六槽位覆盖', 'pass', '身份 / 说话 / 驱动力 / 场景 / 格式 / 自检 六块应齐全', '六块齐全', '')
  }
  const names = missing.map(id => SLOT_LABELS[id] ?? id).join('、')
  // 缺一到两块算 warn（还能用，只是偏薄），缺三块以上算 fail（组装出来的不像一个人）。
  const status: CheckStatus = missing.length < 3 ? 'warn' : 'fail'
  return result(
    'slot-coverage',
    '六槽位覆盖',
    status,
    '身份 / 说话 / 驱动力 / 场景 / 格式 / 自检 六块应齐全',
    `缺 ${String(missing.length)} 块：${names}`,
    `在 SKILL.md 里补上「${names}」这几块的章节标题（关键词见 persona-core 的槽位表），内容由你自己写。`,
  )
}

/**
 * 第 5 项：触发词。
 * @param detail 人设详情。
 */
function checkTriggerWords(detail: PersonaDetailLike): CheckResult {
  const count = detail.triggerWords.length
  if (count === 0) {
    return result(
      'trigger-words',
      '触发词',
      'warn',
      'meta.trigger_words 应有若干条，且不超过上限',
      '一条都没有',
      '补几条触发词，否则这个角色只能靠界面手动切换，喊她名字不会有反应。',
    )
  }
  if (count > TRIGGER_WORDS_MAX) {
    return result(
      'trigger-words',
      '触发词',
      'warn',
      'meta.trigger_words 应有若干条，且不超过上限',
      `${String(count)} 条，超过上限 ${String(TRIGGER_WORDS_MAX)} 条`,
      '精简到最像「喊她」的几条。触发词太多会让日常对话被误触发。',
    )
  }
  return result('trigger-words', '触发词', 'pass', 'meta.trigger_words 应有若干条，且不超过上限', `${String(count)} 条`, '')
}

/**
 * 第 6 项：硬红线。**需要 O-021**，缺席即 `skip`。
 * @param detail 人设详情。
 * @param core O-021 服务。
 */
function checkBoundaries(detail: PersonaDetailLike, core: CoreLike | undefined): CheckResult {
  if (core === undefined || !core.available) {
    return result(
      'boundaries',
      '硬红线',
      'skip',
      '应有至少一条硬约束（红线 / 硬规则 / 禁止项）',
      '人格内核服务（ondra-persona-core）未装载，查不了',
      '',
    )
  }
  let list: readonly BoundaryLike[]
  try {
    list = core.boundaries(detail.id)
  } catch {
    return result('boundaries', '硬红线', 'skip', '应有至少一条硬约束（红线 / 硬规则 / 禁止项）', '读边界时出错，本次跳过', '')
  }
  const hard = list.filter(item => item.hard).length
  if (hard > 0) {
    return result(
      'boundaries',
      '硬红线',
      'pass',
      '应有至少一条硬约束（红线 / 硬规则 / 禁止项）',
      `硬约束 ${String(hard)} 条（边界共 ${String(list.length)} 条）`,
      '',
    )
  }
  return result(
    'boundaries',
    '硬红线',
    'warn',
    '应有至少一条硬约束（红线 / 硬规则 / 禁止项）',
    list.length === 0 ? '一条边界都没有' : `有 ${String(list.length)} 条边界，但全是「诚实边界」这类软约束`,
    '补几条硬红线（明确写「禁止」「红线」这类词，才会被识别成硬约束）。没有红线的角色，遇到越界请求时没有可援引的依据。',
  )
}

/**
 * 第 7 项：`profile` 字段是否够用。
 *
 * 判据是「至少 3 项非空」而不是「全部都要」：两个实包互相缺字段（一个有 `alias`、一个没有），
 * 严格要求会把出厂包也打成不合格。
 * @param detail 人设详情。
 */
function checkProfile(detail: PersonaDetailLike): CheckResult {
  const keys = ['fullName', 'alias', 'ageRange', 'occupation', 'personality', 'attachmentStyle', 'loveLanguage', 'speechFingerprint']
  const filled: string[] = []
  for (const key of keys) {
    const value = detail.profile[key]
    if (value === undefined || value === null) continue
    if (Array.isArray(value) && value.length === 0) continue
    if (typeof value === 'string' && value.trim() === '') continue
    filled.push(key)
  }
  if (filled.length >= PROFILE_FIELDS_MIN) {
    return result(
      'profile-fields',
      '档案字段',
      'pass',
      `profile 至少 ${String(PROFILE_FIELDS_MIN)} 项非空`,
      `${String(filled.length)} 项非空：${filled.join('、')}`,
      '',
    )
  }
  return result(
    'profile-fields',
    '档案字段',
    'warn',
    `profile 至少 ${String(PROFILE_FIELDS_MIN)} 项非空`,
    `只有 ${String(filled.length)} 项非空`,
    '补几项：身份、年龄段、性格标签、依恋类型。这些决定人设卡上显示什么，缺了卡片是空的。',
  )
}

/**
 * 第 8 项：许可证声明。
 * @param detail 人设详情。
 */
function checkLicense(detail: PersonaDetailLike): CheckResult {
  const text = typeof detail.license === 'string' ? detail.license.trim() : ''
  if (text === '') {
    return result(
      'license',
      '版权声明',
      'warn',
      'meta.license 应写明授权方式',
      '没写',
      '补一句版权声明。人设包是产品资产，没有声明的话，日后分发与二次创作的边界说不清。',
    )
  }
  return result('license', '版权声明', 'pass', 'meta.license 应写明授权方式', text.slice(0, 60), '')
}

/**
 * 跑完整八项。
 * @param detail 人设详情（元数据）。
 * @param core O-021 服务。
 */
export function auditOf(detail: PersonaDetailLike, core: CoreLike | undefined): readonly CheckResult[] {
  return Object.freeze([
    checkIdMatch(detail),
    checkMetaDeclared(detail),
    checkSkillSize(detail),
    checkSlotCoverage(detail, core),
    checkTriggerWords(detail),
    checkBoundaries(detail, core),
    checkProfile(detail),
    checkLicense(detail),
  ])
}

/**
 * 计数。
 * @param checks 八项结果。
 */
export function tallyOf(checks: readonly CheckResult[]): Readonly<Record<CheckStatus, number>> {
  const tally: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0 }
  for (const item of checks) tally[item.status] += 1
  return Object.freeze(tally)
}

/**
 * 健康分。
 *
 * `pass` 满分、`warn` 半分、`fail` 0 分，**`skip` 不进分母**。
 * 这一条是本节最要紧的设计：没装 O-021 时六项里有两项是 `skip`，
 * 若把它们算 0 分，所有包的健康分都会凭空掉四分之一，
 * 而用户既没做错什么也没有任何办法改——那种分数只会让人关掉这个功能。
 * @param checks 八项结果。
 */
export function scoreOf(checks: readonly CheckResult[]): number {
  let earned = 0
  let total = 0
  for (const item of checks) {
    if (item.status === 'skip') continue
    total += 1
    if (item.status === 'pass') earned += 1
    else if (item.status === 'warn') earned += 0.5
  }
  if (total === 0) return 0
  return Math.round((earned / total) * 1000) / 1000
}

/**
 * 缺哪几项（给草案用）。按固定顺序返回，保证草案条目顺序稳定。
 * @param checks 八项结果。
 */
export function problemsOf(checks: readonly CheckResult[]): readonly CheckResult[] {
  const order = new Map<CheckId, number>(CHECK_IDS.map((id, index) => [id, index]))
  return Object.freeze(
    checks
      .filter(item => item.status === 'warn' || item.status === 'fail')
      .slice()
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)),
  )
}
