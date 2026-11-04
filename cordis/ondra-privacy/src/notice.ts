/**
 * 合规告知与三层提醒的**文本真源**。
 *
 * ## 为什么文本要单独一个文件
 *
 * 「告知」是本包的产品意义所在：用户点「同意」之前必须看懂**什么会出去、去哪、
 * 为什么必须出去、怎么撤回**。这四件事如果散在 `service.ts` 的字符串拼接里，
 * 早晚会出现「面板上说 A、日志里说 B」。
 *
 * ## 每一句都要有出处
 *
 * 本文件里凡是「产品承诺」性质的句子，都带章节号。没有出处的句子只写机制
 * （例如「凭据只以变量名登记」是 master-plan §6 禁令 6 的直接推论），不写形容词。
 *
 * ## 三层提醒：台账的四个字，手册里查不到
 *
 * 台账写「风控三层提醒」，而手册全文 `三层` / `提醒` / `告知` / `出站` 都是
 * **0 命中**。所以三层的定义不是抄来的，是从 §8.7 的三档审批反推出来的
 * （L1 低风险直过 / L2 高风险确认 / L3 任何档位都不放行），每层都标了出处。
 * 这件事写进 README「与文档的口径差异」，免得下一个人去手册里找一段不存在的规范。
 */

import type { EgressSpec, NoticeText, TierDoc } from './types.js'

/** 三层提醒的静态定义。 */
export const TIERS: readonly TierDoc[] = Object.freeze([
  Object.freeze({
    tier: 'notice' as const,
    title: 'L1 告知',
    meaning: '只发元数据或不带身份的文本，发出去也撤得回来。不打断人，但要留痕。',
    source: '手册 §8.7「自动：低风险直接执行」',
    behavior: '直接放行，写一条计数与日志。',
  }),
  Object.freeze({
    tier: 'confirm' as const,
    title: 'L2 确认',
    meaning: '发的是图片 / 语音 / 文件，或带可识别身份，或发出去撤不回来。对方一旦收到就收不回。',
    source: '手册 §8.7「监督：每个高风险都弹确认」',
    behavior: '要一次点头（同意按「能力 + 主机」记住，默认 30 天）。',
  }),
  Object.freeze({
    tier: 'block' as const,
    title: 'L3 阻断',
    meaning: '密钥形状的内容要出域、凭据引用写成值、目标主机没在声明里、或有人调了没登记的能力。',
    source: '手册 §9.1 许可红线 / §9.4 隐私 / master-plan §6 禁令 6',
    behavior: '**任何档位都不放行**，包括「全自动」。',
  }),
])

/**
 * 生成合规告知文本。
 * @param specs 当前全部声明。
 * @param approvalMode 当前档位（写进正文，让人知道现在会被问几次）。
 * @param ledgerDisplay 账本位置（相对路径；没有落盘时 `undefined`）。
 * @returns 可直接显示的告知文本。
 */
export function buildNotice(
  specs: readonly EgressSpec[],
  approvalMode: string,
  ledgerDisplay: string | undefined,
): NoticeText {
  const body: string[] = [
    '你的对话与记忆默认只存在这台电脑上——手册 §1.10 的原话是「数据全部落在本机，无遥测、无崩溃上报、无使用统计」，宣传片 04 章写的是「长期记忆，只存在你自己的电脑里」。',
    '只有下面这几件事会把内容发出去。没列在这里的能力，本包一律拒绝它出站（不是「默认允许」，是「没登记就不许」）。',
    '凭据只登记**变量名**，值从不经过本包、不进日志、不进面板（master-plan §6 禁令 6；与 O-035 的口径一致）。',
    `当前审批档位是「${approvalMode}」：低风险直接过，高风险按档位问或自动放行，红线任何档位都拦（§8.7）。`,
    '关掉隐私闸门只会取消「告知与确认」，**不会取消红线**——密钥出域与未声明主机仍然会被拒。',
  ]

  const entries = specs.map(spec =>
    Object.freeze({
      id: spec.id,
      title: spec.title,
      hosts: spec.hosts,
      payload: spec.payload,
      localOnly: spec.localOnly,
      ...(spec.credentialRef !== undefined ? { credentialRef: spec.credentialRef } : {}),
    }),
  )

  const revokeHint =
    ledgerDisplay === undefined
      ? '撤回：在面板里对某条能力点「撤回」。当前同意只存在内存里（没有账本位置），重启即全部失效。'
      : `撤回：在面板里对某条能力点「撤回」，或删掉 ${ledgerDisplay}（删掉等于全部撤回）。`

  return Object.freeze({
    title: '数据出本机前的告知',
    body: Object.freeze(body),
    entries: Object.freeze(entries),
    revokeHint,
  })
}
