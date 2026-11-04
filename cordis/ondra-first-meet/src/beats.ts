/**
 * 五拍节拍表：**本插件唯一的「初见该长什么样」的定义**。
 *
 * ## 这里为什么一条台词都没有
 *
 * 一旦这里出现「你好呀，我是……」这样的句子，人格就有了第二份声音来源，
 * 而那份声音不经过冻结前缀（O-033）与九步过滤（O-037）。所以每一拍只写
 * 三样东西：**要解决什么、必须做到什么、绝对不许做什么**。怎么开口归人格。
 *
 * ## 禁令为什么比要求多
 *
 * 「要说什么」人格自己会；「不许说什么」才是初见最容易翻车的地方——
 * 客服腔、报功能清单、一上来就要名字、把边界说成免责声明。每一条禁令
 * 都对应一种真实发生过、且用户一眼就能认出来的翻车方式。
 *
 * ## 句数为什么按「句」不按「字」
 *
 * 字数上限会让人把三句话塞进一句长句（用分号、用破折号），读起来更累。
 * 句数是硬的：说完两句就得停，停不住才是问题。
 */

import type { BeatId, ScriptBeat } from './types.js'
import { BEAT_IDS } from './types.js'

/** 出厂句数（受配置 `maxSentencesCap` 向下约束）。 */
const BEAT_SPECS: Readonly<Record<BeatId, ScriptBeat>> = Object.freeze({
  arrival: Object.freeze({
    id: 'arrival',
    title: '到场',
    intent: '让对方知道这儿有个人在，而且不是客服窗口',
    mustDo: Object.freeze(['先说一句短的招呼，不铺垫', '用「我」作主语，不用「本助手」这类自称']),
    mustNot: Object.freeze([
      '不许先要名字',
      '不许问「有什么可以帮你」',
      '不许一开口就报功能清单',
      '不许用「亲」「您」这类客服称呼',
    ]),
    maxSentences: 2,
    skippable: false,
  }),
  introduce: Object.freeze({
    id: 'introduce',
    title: '自我介绍',
    intent: '说清自己是什么、最常做的一件事、以及做不到什么',
    mustDo: Object.freeze([
      '说明自己是什么（住在本地的一方，不是通用问答）',
      '只说一项最常做的事，不列清单',
    ]),
    mustNot: Object.freeze([
      '不许自称万能',
      '不许把能力说成「什么都能聊」',
      '不许在这拍交代技术细节（模型名、参数量、版本号）',
      '不许超过两句',
    ]),
    maxSentences: 2,
    skippable: false,
  }),
  boundary: Object.freeze({
    id: 'boundary',
    title: '立边界',
    intent: '先说清我不会做什么，再谈别的',
    mustDo: Object.freeze([
      '至少说一条「我不会做的事」',
      '把「我记不住你没说过的事」讲明白',
    ]),
    mustNot: Object.freeze([
      '不许把边界说成免责声明口吻',
      '不许用「为了您的安全」这类法务句',
      '不许在这一拍索要任何权限（文件、屏幕、麦克风）',
    ]),
    maxSentences: 3,
    skippable: false,
  }),
  invite: Object.freeze({
    id: 'invite',
    title: '邀请',
    intent: '给对方一个具体的、容易答的开口',
    mustDo: Object.freeze(['问一个具体的问题（现在手上在忙什么、今天怎么找到这儿的）', '一次只问一个']),
    mustNot: Object.freeze([
      '不许问「你想聊什么」——那把选择权整个推回给对方',
      '不许连问两个问题',
      '不许在问句后面再跟一段自我介绍',
    ]),
    maxSentences: 1,
    skippable: false,
  }),
  settle: Object.freeze({
    id: 'settle',
    title: '收束',
    intent: '把这次认识收成一条可复用的事实：怎么称呼，加一个偏好',
    mustDo: Object.freeze([
      '确认一次该怎么称呼对方',
      '把称呼经 O-010 记成一条记忆事实（本插件自己不存正文）',
    ]),
    mustNot: Object.freeze([
      '不许在这一拍索要更多个人信息',
      '不许复述对方说过的原话（只记称呼与一项偏好）',
      '不许问「还有什么想让我知道的」',
    ]),
    maxSentences: 2,
    skippable: true,
  }),
})

/**
 * 按配置天花板派生节拍表。**顺序固定为 `BEAT_IDS`，不接受外部排序。**
 * @param cap 句数天花板（1–3）。
 */
export function allBeats(cap: number): readonly ScriptBeat[] {
  return Object.freeze(
    BEAT_IDS.map(id => {
      const spec = BEAT_SPECS[id]
      // 只收不放：cap 比出厂值大时不会有任何效果，这样「调大一点」不能变成开场白。
      const maxSentences = Math.min(spec.maxSentences, Math.max(1, Math.trunc(cap)))
      return Object.freeze({ ...spec, maxSentences })
    }),
  )
}

/**
 * 取某一拍。越界返回 `undefined`（不抛错：进度归零后旧索引会被算到 5）。
 * @param beats 节拍表。
 * @param index 序号。
 */
export function beatAt(beats: readonly ScriptBeat[], index: number): ScriptBeat | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= beats.length) return undefined
  return beats[index]
}

/**
 * 一句中文状态说明。**不含台词、不含分数。**
 * @param position 已走完的拍数。
 * @param done 是否走完。
 * @param autoStart 是否允许自动开始。
 */
export function noteOf(position: number, done: boolean, autoStart: boolean): string {
  if (done) return '初见已经走完，之后按平常对话即可'
  if (position === 0 && !autoStart) return '自动初见已关闭，需要调用方显式开始'
  if (position === 0) return '还没开始，第一拍是到场'
  return '已经走到第 ' + String(position + 1) + ' 拍，下一拍按顺序推进'
}
