/**
 * 内容闸（§5.3-1）。
 *
 * 三类红线：**赌博 / 诈骗代办 / 色情**。手册原话「这几类是硬扣号不是限流」——
 * 也就是说它们不是「发多了会限流」，而是「发一条就可能封号」，所以放在最前面。
 *
 * ## 为什么只有三条、且写得很窄
 *
 * §5.3-8 自己承认了这条闸的局限：**「正则不懂语义」**。
 * 手册给的实测是「12 拦截 0 误伤」——0 误伤来自「宁可漏拦」。
 * 所以本文件的模式刻意收窄到**只匹配没有正常用法的词**：
 *
 * - 不写裸的「色情」：`别去看色情内容` 是一句正常的话，会被误杀；
 * - 不写裸的「赌」：`我赌五毛` 是口语；
 * - 写「百家乐」「六合彩」这类**专有名词**，正常对话里不会出现。
 *
 * 漏拦的代价是「一条本该被拦的话发出去了」（她本来也不会说这些）；
 * 误伤的代价是「一句正常的话被丢掉」，而丢掉的症状是「她突然不说话了」，
 * 没有任何报错。两者不对称，所以选窄。
 *
 * ## 归一化只用于**去重**，不用于红线匹配
 *
 * 红线匹配必须看原文：把标点全去掉之后，「赌。球」会变成「赌球」，
 * 那反而是把一句正常话变成命中。去重则相反——「嗯，好。」与「嗯好」是同一句。
 * 两件事用两套归一化，**刻意不合并**。
 */

/** 一类红线。 */
export interface BlockPattern {
  /** 稳定 id（进日志与原因码）。 */
  readonly id: string
  /** 中文说明。 */
  readonly label: string
  /** 模式。 */
  readonly re: RegExp
}

/**
 * 内置三类红线。
 *
 * 全部是**专有名词或行业黑话**，正常对话里不会出现。
 */
export const BLOCK_PATTERNS: readonly BlockPattern[] = Object.freeze([
  {
    id: 'gambling',
    label: '赌博',
    re: /(博彩|赌球|六合彩|时时彩|百家乐|网络赌场|押注平台|盘口|代充值)/u,
  },
  {
    id: 'fraud',
    label: '诈骗代办',
    re: /(代开发票|代办证件|刷单返利|跑分平台|洗钱|套现|代实名|接码平台|代办营业执照)/u,
  },
  {
    id: 'adult',
    label: '色情',
    re: /(约炮|裸聊|招嫖|卖淫|嫖娼|成人影片|色情服务)/u,
  },
])

/** 命中红线的结果。 */
export interface BlockHit {
  /** 类 id。 */
  readonly id: string
  /** 中文名。 */
  readonly label: string
  /** 命中的片段。 */
  readonly matched: string
}

/**
 * 判一段正文有没有命中红线。
 * @param text 原文（**不归一化**，见文件头）。
 * @param extraWords 追加的字面量屏蔽词。
 */
export function blockedHit(text: string, extraWords: readonly string[] = []): BlockHit | undefined {
  for (const pattern of BLOCK_PATTERNS) {
    const match = pattern.re.exec(text)
    if (match !== null) {
      return Object.freeze({ id: pattern.id, label: pattern.label, matched: match[0] })
    }
  }
  for (const word of extraWords) {
    const at = text.indexOf(word)
    if (at >= 0) {
      return Object.freeze({ id: 'custom', label: '自定义屏蔽词', matched: word })
    }
  }
  return undefined
}

/**
 * 去重用的归一化：全半角统一、去空白、去标点与符号、英文小写。
 *
 * `NFKC` 顺带解决全角数字与全角标点（`１２３` → `123`）。
 * @param text 原文。
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

/**
 * 两句是不是同一句（去重口径）。
 * @param a 第一句。
 * @param b 第二句。
 */
export function sameText(a: string, b: string): boolean {
  if (a === b) return true
  const left = normalizeForMatch(a)
  const right = normalizeForMatch(b)
  if (left === '' || right === '') return false
  return left === right
}

/**
 * 正文是否为空（或只有标点与空白）。
 *
 * 空正文会变成一条「空气泡」：用户看得见、日志全绿（§15-82）。
 * @param text 原文。
 */
export function isEmptyText(text: string): boolean {
  return normalizeForMatch(text) === ''
}
