/**
 * 判定的**纯逻辑**层：输入候选与阈值，输出五分类裁决。不碰 ctx、不碰库、不调模型。
 *
 * ## 判定顺序（顺序本身就是设计）
 *
 * ```
 * 正文为空            → drop（不写）
 * 墓碑命中            → drop（不写、不合并）
 * 正文过短            → add （不判重）
 * 候选为空            → add （不调模型，省 4 倍成本）
 * 包含度 ≥ 全等线     → 新颖度低 → drop（复述，只记一次被提起）
 *                       新颖度高 → merge（并入主条，旧正文进 oldText）
 * 包含度 ≥ 合并线     → 槽位替换 → conflict（同一句式、只换了一个值）
 *                       否则     → append（灰区：同一件事的补充，只加固）
 * 其余                → add
 * ```
 *
 * ## 三条必须写清的取舍
 *
 * 1. **「复述」与「补充」用新颖度分，不用包含度分。**
 *    包含度只能回答「像不像」，回答不了「有没有新东西」。
 *    把「用户喜欢猫」和「用户喜欢猫和狗」都判成复述，就会永久丢掉「狗」；
 *    都判成合并，则每句重复都会被改写一次正文，`oldText` 被无意义地冲刷。
 *
 * 2. **冲突靠「槽位替换」识别，不靠否定词。**
 *    最初只用否定词与数字差异判冲突，漏掉了最典型的一类：
 *    「用户住在上海」vs「用户住在北京」——两句都没有否定词、也都没有数字。
 *    改为「公共前后缀覆盖 ≥ 覆盖线，且**中间两段都不为空**」：只换了一个值才算冲突，
 *    一边为空说明是**追加**（「喜欢猫」→「喜欢猫和狗」），不该报冲突。
 *
 * 3. **灰区一律 `needsModel = true`，但默认动作保守。**
 *    手册要求「候选 ≤5 条才交模型」，本插件只负责把闸门做到位、把灰区标出来；
 *    默认动作取 `append`（只加固、不改正文）——**少记一句可以补，改错一句查不出**。
 */

import { digitsDiffer, digitTokens, negationCount, normalizeForCompare, pickMergedText } from './similarity.js'
import type { Config } from './settings.js'
import type { DedupeCandidate, DedupeConflict, DedupeRequest, DedupeVerdict } from './types.js'

/** 判定入参。 */
export interface JudgeInput {
  /** 待写入的请求。 */
  readonly request: DedupeRequest
  /** 已按包含度降序排好的候选（最多 `maxCandidates` 条）。 */
  readonly candidates: readonly DedupeCandidate[]
  /** 这段正文是否已被用户要求忘记。 */
  readonly tombstoned: boolean
  /** 有效字数（由调用方算好，避免在这里重复归一化）。 */
  readonly chars: number
  /** 配置。 */
  readonly settings: Config
}

/** 槽位差异：公共前缀 + 公共后缀 + 两侧中间段。 */
export interface SlotDiff {
  /** 公共前缀长度（码点）。 */
  readonly prefix: number
  /** 公共后缀长度（码点）。 */
  readonly suffix: number
  /** 旧条中间段。 */
  readonly oldMid: string
  /** 新条中间段。 */
  readonly newMid: string
}

/**
 * 求两条归一化正文的「公共前后缀 + 中间差异段」。
 *
 * 例：`用户住在上海` vs `用户住在北京`
 * → `prefix=4`（用户住在）、`suffix=0`、`oldMid=上海`、`newMid=北京`。
 * @param a 旧条归一化正文。
 * @param b 新条归一化正文。
 */
export function slotDiff(a: string, b: string): SlotDiff {
  const left = [...a]
  const right = [...b]
  const max = Math.min(left.length, right.length)

  let prefix = 0
  while (prefix < max && left[prefix] === right[prefix]) prefix += 1

  let suffix = 0
  // 后缀不能与前缀重叠：`abc` vs `abc` 若允许重叠，会得出 prefix=3 且 suffix=3，
  // 中间段变成两个空串——「完全相同」会被误判成「没有差异」，后续规则就失去依据。
  while (suffix < max - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) {
    suffix += 1
  }

  return Object.freeze({
    prefix,
    suffix,
    oldMid: left.slice(prefix, left.length - suffix).join(''),
    newMid: right.slice(prefix, right.length - suffix).join(''),
  })
}

/**
 * 判定是否为「槽位替换」（同一句式只换了一个值）。
 *
 * 五道闸，顺序即优先级：
 * 1. 公共前后缀覆盖较长那条的 `coverage` 以上——保证是同一句式（最便宜也最可靠的一刀）；
 * 2. 两侧中间段全空 → 交给「全等线」那条规则，这里不管；
 * 3. **只有一边有中间段** → 纯插入，不算替换；
 *    **例外**：插进来的正好是否定词（`怕狗` → `不怕狗`）→ 极性翻转，算替换；
 * 4. **两段互不包含**——`上海` 与 `上海的浦东` 是「补了一句」，不是「换了个值」；
 * 5. 两段合计不超过 `maxSlotChars`——差异太长说明是两件事，不是换了个值。
 * @param oldText 旧正文（已归一化）。
 * @param newText 新正文（已归一化）。
 * @param coverage 覆盖线（0–1）。
 * @param maxSlotChars 差异段字数上限。
 */
export function isSlotReplacement(
  oldText: string,
  newText: string,
  coverage: number,
  maxSlotChars: number,
): boolean {
  if (oldText === '' || newText === '') return false
  const diff = slotDiff(oldText, newText)
  const longer = Math.max([...oldText].length, [...newText].length)
  if (longer === 0) return false
  // 1. 先卡「是不是同一句式」。这一步放在最前，因为它是最便宜也最可靠的一刀：
  //    `她说她怕狗` 与 `用户怕狗` 只共享「怕狗」两个字的尾巴，覆盖只有 0.4，不是同一句式。
  if ((diff.prefix + diff.suffix) / longer < coverage) return false
  // 2. 中间段全空 = 两条完全一样，交给「全等线」那条规则处理，这里不管。
  if (diff.oldMid === '' && diff.newMid === '') return false

  const polarityDiffers = (negationCount(diff.oldMid) > 0) !== (negationCount(diff.newMid) > 0)

  // 3. 只有一边有中间段 = 纯插入/纯追加。
  //    **例外**：插进来的正好是否定词（`怕狗` → `不怕狗`），那是极性翻转，
  //    必须算替换——而它在字面上就是「一边为空」，靠「两边都非空」永远判不出来。
  if (diff.oldMid === '' || diff.newMid === '') return polarityDiffers

  // 4. 两段互相包含 = 补了一句（`上海` → `上海的浦东`），不是换了个值。
  //    否定极性不同时不短路：`怕` 与 `不怕` 互为子串，而那是最典型的冲突。
  if (!polarityDiffers && (diff.oldMid.includes(diff.newMid) || diff.newMid.includes(diff.oldMid))) {
    return false
  }

  // 5. 差异太长说明是两件事，不是换了个值。
  return [...diff.oldMid].length + [...diff.newMid].length <= maxSlotChars
}

/** 造一个 `add` 裁决。 */
function verdictAdd(reason: string): DedupeVerdict {
  return Object.freeze({
    action: 'add',
    containment: 0,
    needsModel: false,
    reasons: Object.freeze([reason]),
  })
}

/**
 * 判定。
 * @param input 入参。
 */
export function judge(input: JudgeInput): DedupeVerdict {
  const { request, candidates, tombstoned, chars, settings } = input
  const text = typeof request.text === 'string' ? request.text : ''

  // 1. 空正文：不写。空记忆没有任何价值，还会占一条配额。
  if (chars === 0) {
    return Object.freeze({
      action: 'drop',
      containment: 0,
      needsModel: false,
      reasons: Object.freeze(['正文为空（去掉空白与标点后没有内容），不写入']),
    })
  }

  // 2. 墓碑闸：用户要求忘记的事不许借「重新写入」复活。
  //    放在判重之前，因为「已忘记」与「像不像别的记忆」是两件事——
  //    哪怕它跟某条旧记忆一模一样，也不该被合并进去（那等于复活）。
  if (tombstoned) {
    return Object.freeze({
      action: 'drop',
      containment: 0,
      needsModel: false,
      reasons: Object.freeze(['这条正文曾被用户明确要求忘记（墓碑命中），不写入、也不合并']),
    })
  }

  // 3. 太短不判重：「好的」与「好的呀」包含度是 1.0，合并等于丢语气。
  if (chars < settings.minCompareChars) {
    return verdictAdd(`正文只有 ${chars} 字，短于判重下限 ${settings.minCompareChars} 字，直接新建`)
  }

  // 4. 无候选：手册 §2.2「索引命中为空直接 add 不调模型」。
  const first = candidates[0]
  if (first === undefined) {
    return verdictAdd('没有达到合并阈值的候选，直接新建（此步不调模型）')
  }

  // 两个不同的问题，必须分开看：
  // - `top`：包含度最高的那条（回答「是不是同一句话」）；
  // - `slotTop`：命中槽位替换的那条（回答「是不是同一句话换了值」）。
  // 只用包含度，`我28岁` 与 `我30岁` 会被判成「毫无关系」（每个二元组都不同）。
  const top = candidates.reduce((best, item) => (item.containment > best.containment ? item : best), first)
  const slotTop = candidates.find(item => item.slotMatch)

  const reasons: string[] = [`最相近的是 ${top.id}（包含度 ${top.containment.toFixed(2)}）`]

  // 5. 近乎全等：由新颖度决定「复述」还是「补充」。
  //    **两个条件同时满足才算复述**：占比低（`appendNovelty`）**且**绝对新增少
  //    （`appendNoveltyGrams`）。只看占比会漏掉长句里的真补充（「三岁了」占 0.2），
  //    只看绝对量会放过短句里的真补充（加两个字就占 0.33）。
  if (top.containment >= settings.duplicateThreshold) {
    if (top.novelty <= settings.appendNovelty && top.freshGrams <= settings.appendNoveltyGrams) {
      reasons.push(
        `新颖度 ${top.novelty.toFixed(2)}（新增 ${top.freshGrams} 个二元组）都在复述线内，只记一次「又被提起」`,
      )
      return Object.freeze({
        action: 'drop',
        targetId: top.id,
        containment: top.containment,
        needsModel: false,
        reasons: Object.freeze(reasons),
      })
    }
    reasons.push(
      `新颖度 ${top.novelty.toFixed(2)}（新增 ${top.freshGrams} 个二元组）超出复述线，确有新内容，并入主条`,
    )
    return Object.freeze({
      action: 'merge',
      targetId: top.id,
      containment: top.containment,
      needsModel: false,
      reasons: Object.freeze(reasons),
      mergedText: pickMergedText(top.text, text),
    })
  }

  // 6. 槽位替换：同一句式、只换了一个值。
  if (slotTop !== undefined) {
    const diff = slotDiff(normalizeForCompare(slotTop.text), normalizeForCompare(text))
    const polarity: readonly [number, number] = [negationCount(slotTop.text), negationCount(text)]
    const conflict: DedupeConflict = Object.freeze({
      targetId: slotTop.id,
      polarity,
      digitsDiffer: digitsDiffer(digitTokens(slotTop.text), digitTokens(text)),
      detail: `同一句式但取值不同：「${diff.oldMid}」→「${diff.newMid}」`,
    })
    reasons.push(`与 ${slotTop.id} 是同一句式、只换了取值，不自动合并——照常写入新条并报出冲突`)
    return Object.freeze({
      action: 'conflict',
      targetId: slotTop.id,
      containment: slotTop.containment,
      needsModel: true,
      reasons: Object.freeze(reasons),
      conflict,
    })
  }

  // 7. 合并线以上、全等线以下：同一件事的补充。默认只加固、不改正文。
  if (top.containment < settings.mergeThreshold) {
    return verdictAdd(`最高包含度只有 ${top.containment.toFixed(2)}，低于合并线 ${settings.mergeThreshold}，直接新建`)
  }

  /*
   * 7.5 灰区里先看数字：旧条一个数字都没有、新条有，这是**纯新增**。
   *
   * ## 为什么必须挡在 `append` 之前
   *
   * `append` 的落库语义是只 `reinforce()` 旧条、**不写库**（`service.ts:219-225`）。
   * 它的前提是「新条没有带来旧条以外的东西」——而数字恰恰是事实的**值**，
   * 不是修饰。一旦新条的数字在旧条里根本不存在，那句话就不是「又被提起」，
   * 而是「第一次说出来」。
   *
   * ## 实测怎么丢的
   *
   * ```
   * 旧条 m-121e17e680  用户有一把自行车锁，并问密码是多少      ← 无数字
   * 新条              用户的自行车锁密码是 4712。             ← 数字 4712
   * 包含度 0.46 → 灰区 → 槽位不匹配 → append → 只加固旧条
   * 结果：她回「记下了」，库里 count(*)=0 条
   * ```
   *
   * 用户此后再问密码，召回的是那条「问密码是多少」，还是拿不出答案。
   *
   * ## 判据为什么收得这么窄
   *
   * 只认「旧条零数字」。旧条已有数字而新条不同，那是**换值**，属于
   * 槽位那条路（第 6 步 `conflict`）——放这里会跟它抢判定，把冲突降级成新建。
   * 收窄之后本分支只处理一种情形：旧条压根没提到过任何值，新条第一次给了值。
   * 这种情形不可能是复述，也不可能是换值，改判 `add` 没有误伤面。
   */
  const newDigits = digitTokens(text)
  const oldDigits = digitTokens(top.text)
  if (newDigits.length > 0 && oldDigits.length === 0) {
    reasons.push(
      `新条带来旧条没有的数字（${newDigits.join('、')}），是首次给出的取值而非补充，改为新建`,
    )
    return Object.freeze({
      action: 'add',
      containment: top.containment,
      needsModel: false,
      reasons: Object.freeze(reasons),
    })
  }

  reasons.push(`包含度在 ${settings.mergeThreshold}–${settings.duplicateThreshold} 之间，判为补充而非重复`)
  reasons.push('默认只记一次「又被提起」，不改旧正文；若上层有模型，可把这条候选交它再判一次')
  return Object.freeze({
    action: 'append',
    targetId: top.id,
    containment: top.containment,
    needsModel: true,
    reasons: Object.freeze(reasons),
  })
}

/**
 * 候选排序：**槽位命中优先**，其次包含度降序，同分取更新写入的那条。
 *
 * 槽位命中优先的理由：它比包含度更具体（「同一句式换了个值」几乎不可能是巧合），
 * 而包含度 0.42 的候选很可能是「都提到了猫」这类弱相关。截断到 5 条时，
 * 先保住强信号那一条，比按分数排更不容易漏掉真冲突。
 */
export function byRankDesc(a: DedupeCandidate, b: DedupeCandidate): number {
  if (a.slotMatch !== b.slotMatch) return a.slotMatch ? -1 : 1
  if (b.containment !== a.containment) return b.containment - a.containment
  return b.createdAt - a.createdAt
}
