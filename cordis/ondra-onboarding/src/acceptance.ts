/**
 * 宣传片 01 章的**验收判定**（§1.11 + §6.4）。纯函数，不读状态、不发消息。
 *
 * ## 五条从哪来
 *
 * §6.4 验收原文三句 + §1.11 章 01 两处，拆成五条可判定的检查：
 *
 * | 检查 | 出处 |
 * |---|---|
 * | 安装器标题 | §6.4「标题『安装 空谷 Ondra 1.0』」 |
 * | 实时进度百分比 | §6.4「实时进度百分比」 |
 * | 状态行两句 | §6.4「状态行（『正在准备运行环境』→『安装完成，已就绪』）」 |
 * | 首条消息由人设主动发出 | §6.4「首条消息由当前人设主动发出」+ §1.11 章 01 |
 * | 不调模型、不写代码 | §1.11 章 01「下载就能用，不调模型，不写代码」 |
 *
 * ## 三值而不是布尔
 *
 * 「判不了」必须能说出来。把判不了当成过，验收就成了自欺；当成不过，一个正常的
 * 首启会被标红。所以每条都有 `pass / fail / unverifiable`，报告只在这三值上聚合。
 *
 * ## 首条消息的文案为什么不写死人名
 *
 * §1.11 明写「文案取当前人设名」，出厂是鲸鲸、示例是夏柠柒。把任何一个名字写进
 * 代码，都是在插件里存了第二份人设真源——换人设那天，这里会对不上且没有任何报错。
 */

import { STATUS_PREPARING, STATUS_READY } from './segments.js'
import type {
  AcceptanceCheck,
  AcceptanceFacts,
  AcceptanceReport,
  CheckVerdict,
  FirstMessageObservation,
  FirstMessageSpec,
  InstallerTitle,
  SegmentRecord,
} from './types.js'

/** 首条消息的模板（§1.11 章 01 原文形状，只换名字）。 */
export function firstMessageTextOf(personaName: string): string {
  return `你好呀，我是${personaName}`
}

/**
 * 首条消息规格。名字没给就不给文案——**不替人设签字**。
 * @param personaName 当前人设名。
 */
export function firstMessageSpecOf(personaName?: string): FirstMessageSpec {
  const name = typeof personaName === 'string' ? personaName.trim() : ''
  if (name === '') {
    return { resolved: false, personaName: '', text: '', by: 'persona', reason: 'no-persona' }
  }
  return { resolved: true, personaName: name, text: firstMessageTextOf(name), by: 'persona' }
}

/**
 * 安装器标题：`安装 <空谷 Ondra> <1.0>`，产品名与版本都走 O-001。
 *
 * 拿不到 O-001 时给 `安装 Ondra` 并标 `resolved: false`：`Ondra` 是包名与仓库名里
 * 都有的那个词，比编一个「空谷」诚实。
 * @param identity O-001 服务（可能缺席）。
 */
export function installerTitleOf(identity: { readonly product: { readonly fullName: string; readonly version: string } } | null): InstallerTitle {
  if (identity === null) {
    return { resolved: false, text: '安装 Ondra', source: 'fallback' }
  }
  const fullName = identity.product.fullName.trim()
  const version = identity.product.version.trim()
  if (fullName === '' || version === '') {
    return { resolved: false, text: '安装 Ondra', source: 'fallback' }
  }
  return { resolved: true, text: `安装 ${fullName} ${version}`, source: 'identity' }
}

/** 一次验收要的全部输入。 */
export interface AcceptanceInput {
  readonly title: InstallerTitle
  readonly records: Readonly<Record<string, SegmentRecord>>
  readonly samples: readonly number[]
  readonly statusLines: readonly string[]
  readonly firstMessage: FirstMessageObservation | undefined
  readonly facts: AcceptanceFacts
}

/**
 * 造一条检查。
 * @param id 检查 id。
 * @param title 中文标题。
 * @param verdict 结论。
 * @param detail 依据。
 * @param source 出处。
 */
function check(
  id: AcceptanceCheck['id'],
  title: string,
  verdict: CheckVerdict,
  detail: string,
  source: string,
): AcceptanceCheck {
  return { id, title, verdict, detail, source }
}

/**
 * 跑五条验收。
 * @param input 输入。
 */
export function acceptanceOf(input: AcceptanceInput): AcceptanceReport {
  const facts = input.facts
  const checks: AcceptanceCheck[] = []

  // 1. 安装器标题。
  if (facts.installerTitle === undefined) {
    checks.push(
      check('installer-title', '安装器标题', 'unverifiable', `没有拿到安装器实际标题；应为「${input.title.text}」`, '§6.4'),
    )
  } else if (facts.installerTitle.trim() === input.title.text) {
    checks.push(check('installer-title', '安装器标题', 'pass', `「${input.title.text}」`, '§6.4'))
  } else {
    checks.push(
      check(
        'installer-title',
        '安装器标题',
        'fail',
        `实际「${facts.installerTitle}」，应为「${input.title.text}」（产品名与版本必须来自 O-001）`,
        '§6.4',
      ),
    )
  }

  // 2. 实时进度百分比。
  const distinct = new Set(input.samples).size
  if (input.samples.length === 0) {
    checks.push(check('live-progress', '实时进度百分比', 'unverifiable', '一次进度读数都没有', '§6.4'))
  } else if (distinct >= 2) {
    checks.push(
      check('live-progress', '实时进度百分比', 'pass', `观察到 ${distinct} 个不同读数（${input.samples[0]}% … ${input.samples[input.samples.length - 1]}%）`, '§6.4'),
    )
  } else {
    checks.push(
      check('live-progress', '实时进度百分比', 'fail', `只出现过一个读数（${input.samples[0]}%），界面不会动`, '§6.4'),
    )
  }

  // 3. 状态行两句。用 startsWith 而不是等值：准备中的那句后面会拼当前段标题。
  const hasPreparing = input.statusLines.some(line => line.startsWith(STATUS_PREPARING))
  const hasReady = input.statusLines.some(line => line.startsWith(STATUS_READY))
  if (input.statusLines.length === 0) {
    checks.push(check('status-line', '状态行两句', 'unverifiable', '一条状态行都没记到', '§6.4'))
  } else if (hasPreparing && hasReady) {
    checks.push(check('status-line', '状态行两句', 'pass', `「${STATUS_PREPARING}」与「${STATUS_READY}」都出现过`, '§6.4'))
  } else {
    const missing = [!hasPreparing ? `「${STATUS_PREPARING}」` : '', !hasReady ? `「${STATUS_READY}」` : ''].filter(text => text !== '')
    checks.push(check('status-line', '状态行两句', 'fail', `缺 ${missing.join(' 与 ')}`, '§6.4'))
  }

  // 4. 首条消息由人设主动发出。
  const personaName = typeof facts.personaName === 'string' ? facts.personaName.trim() : ''
  if (input.firstMessage === undefined) {
    checks.push(check('first-message', '首条消息由人设主动发出', 'unverifiable', '没有观察到首条消息', '§1.11 章 01'))
  } else if (personaName === '') {
    checks.push(check('first-message', '首条消息由人设主动发出', 'unverifiable', '不知道当前人设名，无法核对文案', '§1.11 章 01'))
  } else {
    const expected = firstMessageTextOf(personaName)
    if (input.firstMessage.text.trim() !== expected) {
      checks.push(
        check('first-message', '首条消息由人设主动发出', 'fail', `实际「${input.firstMessage.text}」，应为「${expected}」`, '§1.11 章 01'),
      )
    } else if (input.firstMessage.initiative !== 'persona') {
      checks.push(
        check('first-message', '首条消息由人设主动发出', 'fail', `文案对了，但先说话的是「${input.firstMessage.initiative}」`, '§1.11 章 01'),
      )
    } else {
      checks.push(check('first-message', '首条消息由人设主动发出', 'pass', `「${expected}」`, '§1.11 章 01'))
    }
  }

  // 5. 不调模型、不写代码。
  const route = facts.modelRoute ?? 'unknown'
  if (route === 'unknown') {
    checks.push(check('zero-config', '不调模型、不写代码', 'unverifiable', '不知道首轮走的哪条模型通路', '§1.11 章 01'))
  } else if (route !== 'builtin') {
    checks.push(
      check('zero-config', '不调模型、不写代码', 'fail', `首轮走了「${route}」，用户得先有密钥才聊得起来`, '§1.11 章 01'),
    )
  } else if (facts.userEditedConfig === true) {
    checks.push(check('zero-config', '不调模型、不写代码', 'fail', '首轮之前用户改过配置', '§1.11 章 01'))
  } else {
    checks.push(check('zero-config', '不调模型、不写代码', 'pass', '首轮走内置通路、未要求改配置', '§1.11 章 01'))
  }

  const passed = checks.filter(item => item.verdict === 'pass').length
  const failed = checks.filter(item => item.verdict === 'fail').length
  const unverifiable = checks.filter(item => item.verdict === 'unverifiable').length
  const verdict: CheckVerdict = failed > 0 ? 'fail' : unverifiable > 0 ? 'unverifiable' : 'pass'

  return { checks, verdict, passed, failed, unverifiable }
}
