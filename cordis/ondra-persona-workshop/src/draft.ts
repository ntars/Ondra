/**
 * 派生草案：把体检的「哪里不够」翻译成「改哪几处」的清单。
 *
 * ## 它产出什么、不产出什么
 *
 * 产出：动作类型 + 包内相对路径 + 位置 + 为什么改 + 优先级。
 * **不产出**：任何一句改写后的文案。
 *
 * 这条线是刻意的。写文案是创作，插件自己编出来的句子会被人当成产品资产的一部分
 * 抄进包里，然后没人知道它是机器写的。所以草案只回答「这里空着」，
 * 「填什么」必须由人（或经 O-035 网关计费的模型调用）决定。
 *
 * ## 为什么固定「必须自己定的三件事」
 *
 * 列十条的结果是用户一条都不做。三件事是「改完这三件才算另一个人」的最小集合：
 * 名字与自称、说话方式、驱动力。换了这三样，同一个包就能立住另一个角色；
 * 只换名字不改另外两样，就是换皮。
 */

import { problemsOf } from './audit.js'
import type { CheckResult, DraftItem, PersonaDetailLike, VariantDraft } from './types.js'

/**
 * 一条体检结论 → 一条改动。
 *
 * 用 `switch` 逐项映射而不是查表：每项的动作类型、改哪个文件、
 * 优先级都不同，写成表反而看不出「为什么这项要改这个文件」。
 * @param check 一条不合格/警告结论。
 */
function itemOf(check: CheckResult): DraftItem {
  switch (check.id) {
    case 'id-match':
      return {
        action: 'rename',
        file: '',
        where: 'meta.slug',
        because: check.evidence,
        priority: 2,
      }
    case 'meta-declared':
      return {
        action: 'declare',
        file: 'meta.json',
        where: 'files',
        because: check.evidence,
        priority: 3,
      }
    case 'skill-size':
      return {
        action: check.evidence.includes('低于') ? 'fill' : 'shorten',
        file: 'SKILL.md',
        where: '',
        because: check.evidence,
        priority: 1,
      }
    case 'slot-coverage':
      return {
        action: 'add-section',
        file: 'SKILL.md',
        where: check.evidence,
        because: check.evidence,
        priority: 1,
      }
    case 'trigger-words':
      return {
        action: 'fill',
        file: 'meta.json',
        where: 'trigger_words',
        because: check.evidence,
        priority: 4,
      }
    case 'boundaries':
      return {
        action: 'fill',
        file: 'SKILL.md',
        where: '硬规则 / 红线',
        because: check.evidence,
        priority: 2,
      }
    case 'profile-fields':
      return {
        action: 'fill',
        file: 'meta.json',
        where: 'profile',
        because: check.evidence,
        priority: 4,
      }
    case 'license':
      return {
        action: 'fill',
        file: 'meta.json',
        where: 'license',
        because: check.evidence,
        priority: 5,
      }
    default:
      return {
        action: 'fill',
        file: '',
        where: '',
        because: check.evidence,
        priority: 9,
      }
  }
}

/**
 * 新包骨架：目录树 + 文件清单，**只有路径没有内容**。
 *
 * 骨架照着源包的实际文件清单生成，而不是给一个「标准模板」——
 * 源包里有什么，新包就该有什么，多出来的文件用户自己决定要不要带走。
 * @param detail 源包详情。
 * @param newId 新包 id（用于拼外层目录名）。
 */
export function skeletonOf(detail: PersonaDetailLike, newId: string): readonly string[] {
  const root = newId + '.skill/'
  const out: string[] = [root]
  const seenDirs = new Set<string>()
  for (const entry of detail.files) {
    const path = entry.path
    const cut = path.lastIndexOf('/')
    if (cut > 0) {
      const dir = root + path.slice(0, cut + 1)
      if (!seenDirs.has(dir)) {
        seenDirs.add(dir)
        out.push(dir)
      }
    }
    out.push(root + path)
  }
  return Object.freeze(out)
}

/**
 * 「必须自己定的三件事」。
 *
 * 三条都不是「建议」，是「不做就等于换皮」。
 * @param detail 源包详情。
 */
export function mustChangeOf(detail: PersonaDetailLike): readonly string[] {
  const name = detail.displayName === '' ? detail.name : detail.displayName
  return Object.freeze([
    `名字与自称：现在是「${name}」，换一个人就得换掉它，以及 SKILL.md 里每一处自称。`,
    '说话方式：句长、语气词、标点习惯、称呼。这一块不同，读者立刻能分出是两个人。',
    '驱动力：她为什么这样说话。同样的语气配不同的动机，会像同一个演员换了件衣服。',
  ])
}

/**
 * 组装草案。
 * @param detail 源包详情。
 * @param checks 体检八项。
 * @param newId 建议的新包 id（由调用方定，本插件不替它起名）。
 * @param at 时刻。
 */
export function draftOf(
  detail: PersonaDetailLike,
  checks: readonly CheckResult[],
  newId: string,
  at: number,
): VariantDraft {
  const problems = problemsOf(checks)
  const items = problems.map(itemOf).slice().sort((a, b) => a.priority - b.priority)
  return Object.freeze({
    sourceId: detail.id,
    fromBundled: detail.rootKind === 'bundled',
    items: Object.freeze(items),
    skeleton: skeletonOf(detail, newId),
    mustChange: mustChangeOf(detail),
    at,
  })
}
