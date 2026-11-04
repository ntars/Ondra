/**
 * 四拍约束表：**本插件唯一的「共创该长什么样」的定义**。
 *
 * ## 这里为什么一条内容都没有
 *
 * 一旦这里出现「你可以先写个开头……」，共创就有了第二份内容来源，
 * 而那份来源不经过冻结前缀（O-033）与九步过滤（O-037）。所以每一拍只写四样：
 * **该谁开口、要解决什么、必须做到什么、绝对不许做什么**。怎么做归对话链。
 *
 * ## 禁令为什么比要求多
 *
 * 「要做什么」模型自己会；「不许做什么」才是共创最容易翻车的地方——
 * 另起一稿、一次交两版、点评时列五条、收束时自己替人定稿。每一条禁令
 * 都对应一种真实发生过的翻车方式。
 *
 * ## 为什么「不许另起一稿」写在出稿拍而不是收束拍
 *
 * 另起一稿是**动手那一刻**犯的错，等收束时再说已经晚了：那时有两份稿，
 * 版号只跟了其中一份，谁也说不清在改的是哪一份。
 */

import type { RoundBrief, RoundKind } from './types.js'
import { ROUND_KINDS } from './types.js'

/** 生成一拍所需的上下文。全部来自状态机，调用方不能自己编。 */
export interface BriefInput {
  /** 拍 id。 */
  readonly kind: RoundKind
  /** 已交出的版数。 */
  readonly edition: number
  /** 版数硬上限。 */
  readonly maxEditions: number
  /** 是否已经只能收束。 */
  readonly closing: boolean
  /** 人设硬边界条数；`null` 表示 O-021 缺席、取不到。 */
  readonly boundaryCount: number | null
}

/** 每题共享的一条底线：产物不许越过人设边界。 */
function boundaryRule(count: number | null): string {
  return count === null
    ? '不许在没核对人设边界的情况下说「可以了」（O-021 缺席，边界条数取不到）'
    : '不许让产物越过人设的硬边界（当前取到 ' + String(count) + ' 条）'
}

/** 立题拍（提出方）：只定目标与验收标准，不给做法。 */
function briefRound(): RoundBrief {
  return Object.freeze({
    kind: 'brief' as const,
    owner: 'author' as const,
    intent: '把「要一起做出什么」说成一句可验收的话：做出什么、给谁用、什么样算成',
    mustDo: Object.freeze([
      '说清产物是什么',
      '说清给谁用',
      '给出一条验收标准：什么样算成',
      '说明自己这一方能提供什么、不能提供什么',
    ]),
    mustNot: Object.freeze([
      '不许在这一拍给做法或步骤',
      '不许给范例文本（范例一出，对方只会照着改，共创就成了抄写）',
      '不许问「你想怎么做」把选题推回去',
      '不许当场定轮次：版数上限由配置管，不由这一拍谈',
    ]),
  })
}

/** 出稿拍（动手方）：第 1 版是最小可用，之后每版只改上一版被指出的问题。 */
function makeRound(input: BriefInput): RoundBrief {
  const first = input.edition === 0
  const base = first
    ? '交出第 1 版：能跑通的最小一版，不是最全的一版'
    : '交出第 ' + String(input.edition + 1) + ' 版：只在第 ' + String(input.edition) + ' 版上改'
  return Object.freeze({
    kind: 'make' as const,
    owner: 'maker' as const,
    intent: base,
    mustDo: Object.freeze([
      first ? '对着立题拍给的验收标准做，不自立标准' : '对着上一轮那条意见改，不扩题',
      '一次只交一版',
      '交的时候用一句交接备注说清这一版改了哪几处',
    ]),
    mustNot: Object.freeze([
      '不许另起一稿（另起之后版号就断了，谁也说不清在改哪一份）',
      '不许一次交两版让人挑',
      '不许在没接到意见时连改两版',
      '不许夹带上一轮没被要求的改动',
      boundaryRule(input.boundaryCount),
    ]),
  })
}

/** 意见拍（提出方）：只指一处最该改的，不亲自动手。 */
function reviewRound(): RoundBrief {
  return Object.freeze({
    kind: 'review' as const,
    owner: 'author' as const,
    intent: '只给一句定向意见：这一版最该改的一处是哪一处',
    mustDo: Object.freeze([
      '指出一处最该改的地方',
      '说清改成什么样算改到了',
    ]),
    mustNot: Object.freeze([
      '不许在这一拍自己动手改稿（提出方一动手，两个角色就重合了）',
      '不许说「都行」「挺好」这类没有指向的话',
      '不许一次列五条（列五条等于没提意见）',
      '不许换题：换题要重新立题，不是在这一拍顺手换',
    ]),
  })
}

/** 收束拍（提出方）：只问一句，然后停住。 */
function closeRound(input: BriefInput): RoundBrief {
  const reason = input.closing
    ? '版数已用尽（上限 ' + String(input.maxEditions) + ' 版）：现在只能收束'
    : '这一版先做到这里：收束，把定稿的决定权交回去'
  return Object.freeze({
    kind: 'close' as const,
    owner: 'author' as const,
    intent: reason,
    mustDo: Object.freeze([
      '原话问出「这版算定稿吗」或同义的一句',
      '把当前版号说清楚（是第几版）',
      '问完就停，等回答',
    ]),
    mustNot: Object.freeze([
      '不许替对方回答',
      '不许说「那就这么定了」自己定稿',
      '不许在没得到回答前承诺下一版',
      '不许把收束说成「我先这样，你有空再看」（那不是收束，是把话题挂起来）',
      boundaryRule(input.boundaryCount),
    ]),
  })
}

/**
 * 取一拍的约束。**纯函数**：同样的入参永远同一份约束。
 * @param input 上下文。
 */
export function briefAt(input: BriefInput): RoundBrief {
  switch (input.kind) {
    case 'brief':
      return briefRound()
    case 'make':
      return makeRound(input)
    case 'review':
      return reviewRound()
    case 'close':
      return closeRound(input)
  }
}

/** 四拍约束（按默认上下文的只读副本，供自检与文档枚举）。 */
export function allBriefs(): readonly RoundBrief[] {
  return Object.freeze(
    ROUND_KINDS.map(kind =>
      briefAt({ kind, edition: 0, maxEditions: 3, closing: false, boundaryCount: null }),
    ),
  )
}

/**
 * 一句中文提示。**不含台词、不含作品内容、不含分数。**
 * @param input 上下文。
 */
export function noteOf(input: BriefInput): string {
  switch (input.kind) {
    case 'brief':
      return '立题：目标、给谁用、什么样算成，三样说清就可以停'
    case 'make':
      return input.edition === 0
        ? '第 1 版：能跑通的最小一版，不是最全的一版'
        : '第 ' +
            String(input.edition + 1) +
            ' 版：只在第 ' +
            String(input.edition) +
            ' 版上改，另起一稿会让版号失去意义'
    case 'review':
      return '意见：只指一处最该改的，说清改成什么样算改到'
    case 'close':
      return input.closing
        ? '版数已用尽（' +
            String(input.maxEditions) +
            ' 版）：只能收束，原话问「这版算定稿吗」'
        : '收束：原话问「这版算定稿吗」，问完就停；答案不归本插件记'
  }
}
