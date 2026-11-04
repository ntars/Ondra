/**
 * 分支 A：**闸式做梦**（默认，手册 §2.7）。
 *
 * 「只补带出处的事实」——这条分支的全部价值在**四道闸**上，不在模型上。
 * 模型只负责「从素材里挑哪一句、提炼成什么」，剩下四件事全由确定性代码判：
 *
 * 1. 引文必须逐字出现在素材里（`gateQuote`）。
 * 2. 不许改人格 / 改称呼（`gatePersona`）。
 * 3. 不许与已有记忆重复（`dedupe.judge()`，与 O-012 共用一把尺子）。
 * 4. 不许是无人称的工程结论（`gateImpersonal`）。
 *
 * 外加一道**墓碑闸**：用户明确要求忘记的事，不许借一场梦复活
 * （`core.tombstoned()`，与 O-011 的写库前检查同一道）。
 *
 * ## 三道保险里的「开工前备份」
 *
 * 手册 §9.7 要求夜跑前 `VACUUM INTO` 备份。复制文件在 WAL 下会漏数据，
 * 所以这件事归 O-009（它用的正是 `VACUUM INTO`）。本插件只在**动手写记忆之前**
 * 请它做一份快照：做成 → `created`，没装 → `skipped`，失败 → `failed`（并记 issue）。
 * **失败不阻断**：备份是为了「万一」，为它挡住一次正常的巩固是本末倒置。
 *
 * ## 写完必须读回
 *
 * 手册 §2.7「梦正文必须交回来」：写完读回校验，读不回就不算成功。
 * 这不是洁癖——`addFact()` 可能因为端口问题只写了一半，
 * 而「报告说写了 3 条、库里只有 2 条」是最难查的一类不一致。
 */

import { gateImpersonal, gatePersona, gateQuote, gateShape } from '../gates.js'
import type { RawCandidate } from '../gates.js'
import { DREAM_SYSTEM_PROMPT, buildMaterialMessage } from '../prompt.js'
import { dateKey } from '../quote.js'
import { makeId } from '../store.js'
import type {
  BranchContext,
  DreamBranch,
  DreamFactRecord,
  DreamInput,
  DreamMaterial,
  DreamRejection,
  DreamReport,
  EvidenceSource,
} from '../types.js'

/** 一条通过全部闸门的候选。 */
interface Accepted {
  readonly text: string
  readonly category: string
  readonly kind: string
  readonly subject: string | undefined
  readonly quote: string
  readonly source: EvidenceSource
  readonly materialIndex: number
}

/** 分支实现。 */
export class GateBranch implements DreamBranch {
  /** 分支名。 */
  readonly mode = 'gate' as const
  /** 需要模型网关。 */
  readonly needsModel = true

  /**
   * 做一场闸式梦。
   * @param input 入参。
   * @param at 时间戳。
   * @param context 上下文。
   */
  async run(input: DreamInput, at: number, context: BranchContext): Promise<DreamReport> {
    const { core, gateway, snapshot, settings, log, report } = context
    const date = dateKey(at)
    const rejected: DreamRejection[] = []
    const written: DreamFactRecord[] = []
    const material = input.mode === 'gate' ? input.material : { items: [] }

    const base = {
      mode: this.mode,
      at,
      date,
      candidates: 0,
      written: Object.freeze([]) as readonly DreamFactRecord[],
      rejected: Object.freeze([]) as readonly DreamRejection[],
      cards: Object.freeze([]),
      talk: Object.freeze([]),
      edges: 0,
      backup: 'skipped' as const,
      logged: false,
    }

    if (core === undefined || !core.available) {
      return Object.freeze({ ...base, ok: false, reason: 'no-core' as const, note: '没有可用的记忆内核' })
    }
    if (gateway === undefined || !gateway.available) {
      // 闸式做梦**必须**有模型：四道闸只负责「拒」，不负责「想」。
      return Object.freeze({
        ...base,
        ok: false,
        reason: 'no-model' as const,
        note: '没有可用的模型网关：闸式做梦只补带出处的事实，不能凭空生成。想零模型调用请切 mode=lightweight',
      })
    }
    if (material.items.length === 0) {
      return Object.freeze({ ...base, ok: true, note: '没有素材，今晚不做梦（空手比凑数好）' })
    }

    // 三道保险之一：动手写之前先备份。失败不阻断。
    let backup: 'created' | 'skipped' | 'failed' = 'skipped'
    if (snapshot !== undefined && snapshot.available) {
      try {
        backup = snapshot.create(`dream:gate ${date}`).ok ? 'created' : 'failed'
        if (backup === 'failed') {
          report({ code: 'backup-failed', detail: '做梦前的快照被拒（库可能未关或不可写），本次照常继续' })
        }
      } catch (error) {
        backup = 'failed'
        log.warn('做梦前快照失败（不阻断）：%s', messageOf(error))
      }
    }

    // 1. 问模型。
    let answer = ''
    try {
      const completion = await gateway.complete({
        messages: [{ role: 'user', content: buildMaterialMessage(material.items) }],
        system: DREAM_SYSTEM_PROMPT,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        ...(input.mode === 'gate' && input.signal !== undefined ? { signal: input.signal } : {}),
      })
      answer = completion.text
    } catch (error) {
      report({ code: 'gateway-failed', detail: `做梦调用失败：${messageOf(error)}` })
      return Object.freeze({
        ...base,
        ok: false,
        reason: 'no-model' as const,
        backup,
        note: `模型调用失败，今晚没做梦（${messageOf(error)}）`,
      })
    }

    // 2. 解析（只认 JSON 行 / JSON 数组，解析不出就一条都不写）。
    const raw = parseCandidates(answer, settings.maxCandidates)
    if (raw.length === 0) {
      report({ code: 'parse-empty', detail: '模型没有给出可解析的候选（不是事故：梦补不到事实明天还能再梦）' })
    }

    // 3. 过闸。
    const accepted: Accepted[] = []
    for (const candidate of raw) {
      const verdict = this.screen(candidate, material, context)
      if (verdict.ok) {
        accepted.push(verdict.accepted)
      } else {
        rejected.push(verdict.rejection)
      }
    }

    // 4. 写库（每晚 `maxItems` 条上限，超出的记 max-items 而不是静默丢）。
    for (const item of accepted) {
      if (written.length >= settings.maxItems) {
        rejected.push({
          code: 'max-items',
          text: item.text,
          detail: `今晚已写满 ${settings.maxItems} 条，这条留到明晚（不静默丢）`,
        })
        continue
      }

      let id = ''
      try {
        const record = core.addFact({
          kind: item.kind,
          category: item.category,
          text: item.text,
          ...(item.subject === undefined ? {} : { subject: item.subject }),
          salience: settings.dreamSalience,
          evidence: [{ source: item.source, quote: item.quote, messageIndex: item.materialIndex }],
          at,
        })
        id = record.id
      } catch (error) {
        rejected.push({
          code: 'empty-text',
          text: item.text,
          detail: `写入失败（${messageOf(error)}），已放弃这一条`,
        })
        continue
      }

      // 5. 读回校验（手册 §2.7「梦正文必须交回来」）。
      const back = core.getFact(id)
      const readback = back !== undefined && back.text === item.text
      if (!readback) {
        report({ code: 'readback-failed', id, detail: '写完读回不一致：报告与库里的内容对不上，已记入问题列表' })
      }
      written.push({
        id,
        text: item.text,
        category: item.category,
        kind: item.kind,
        quote: item.quote,
        source: item.source,
        readback,
      })
    }

    const note = this.summarize(raw.length, accepted.length, written.length, rejected.length)
    context.store.recordDream({
      id: makeId('dl', at),
      date,
      mode: this.mode,
      at,
      facts: written.length,
      cards: 0,
      talk: 0,
      edges: 0,
      note,
    })

    return Object.freeze({
      ok: true,
      mode: this.mode,
      at,
      date,
      candidates: raw.length,
      written: Object.freeze(written),
      rejected: Object.freeze(rejected),
      cards: Object.freeze([]),
      talk: Object.freeze([]),
      edges: 0,
      backup,
      logged: context.store.available,
      note,
    })
  }

  /**
   * 逐道闸筛一条候选。
   * @param candidate 原始候选。
   * @param material 素材。
   * @param context 上下文。
   */
  private screen(
    candidate: RawCandidate,
    material: DreamMaterial,
    context: BranchContext,
  ):
    | { readonly ok: true; readonly accepted: Accepted }
    | { readonly ok: false; readonly rejection: DreamRejection } {
    const reject = (code: DreamRejection['code'], detail: string): { readonly ok: false; readonly rejection: DreamRejection } => ({
      ok: false,
      rejection: { code, text: candidate.text, detail },
    })

    const shape = gateShape(candidate.text, context.settings)
    if (!shape.ok) return reject(shape.code, shape.detail)

    const persona = gatePersona(candidate.text)
    if (!persona.ok) return reject(persona.code, persona.detail)

    const impersonal = gateImpersonal(candidate.text)
    if (!impersonal.ok) return reject(impersonal.code, impersonal.detail)

    const quote = gateQuote(candidate, material, context.settings)
    if (!quote.ok) return reject(quote.code, quote.detail)

    const text = candidate.text.trim()

    // 墓碑闸：用户要求忘记的事，不许借一场梦复活。
    if (context.core !== undefined && context.core.tombstoned(text)) {
      return reject('tombstoned', '这条正文已被用户明确要求忘记（墓碑里有它），梦不许把它写回来')
    }

    // 重复拒：走 O-012 的 judge()，**共用一把尺子**。
    // 没有 O-012 时只做「同批去重 + 墓碑」，不自己写一个包含度阈值——
    // 那就是第二把尺子（裁决⑥ 明令「口径不同不可互搬」）。
    const dedupe = context.dedupe
    if (dedupe !== undefined && dedupe.available) {
      try {
        const verdict = dedupe.judge({
          text,
          category: candidate.category,
          kind: candidate.kind,
          ...(candidate.subject === undefined ? {} : { subject: candidate.subject }),
        })
        if (verdict.action !== 'add') {
          return reject('duplicate', `与已有记忆重复（判重裁决 ${verdict.action}：${verdict.reasons.join('；')}）`)
        }
      } catch (error) {
        // 判重挂了不该让整场梦失败：降级为「放过」，但要说出来。
        context.report({ code: 'no-dedupe', detail: `判重服务出错，这一条未做重复拒：${messageOf(error)}` })
      }
    }

    return {
      ok: true,
      accepted: {
        text,
        category: typeof candidate.category === 'string' ? candidate.category : '',
        kind: typeof candidate.kind === 'string' ? candidate.kind : '',
        subject: typeof candidate.subject === 'string' && candidate.subject !== '' ? candidate.subject : undefined,
        quote: quote.quote,
        source: quote.source,
        materialIndex: quote.materialIndex,
      },
    }
  }

  /** 一句话小结。 */
  private summarize(candidates: number, accepted: number, written: number, rejected: number): string {
    if (candidates === 0) return '模型没给出候选，今晚没记下东西'
    return `候选 ${candidates} 条，过闸 ${accepted} 条，写入 ${written} 条，拒收 ${rejected} 条`
  }
}

/**
 * 解析模型输出。
 *
 * **只认两种形状**：每行一个 JSON 对象，或整段是一个 JSON 数组。
 * 不做五级兜底（那是 O-011 的活，因为提炼漏一条是损失）；
 * 做梦漏一条不是事故，而解析出错写进一条半截话是**不可逆**的污染。
 * @param text 模型输出。
 * @param max 最多取几条。
 */
export function parseCandidates(text: string, max: number): readonly RawCandidate[] {
  const trimmed = text.trim()
  if (trimmed === '') return Object.freeze([])

  const out: RawCandidate[] = []

  // 形状一：整段是数组。
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const candidate = asCandidate(item)
          if (candidate !== undefined) out.push(candidate)
          if (out.length >= max) return Object.freeze(out)
        }
        return Object.freeze(out)
      }
    } catch {
      // 落到形状二，不在这里报错。
    }
  }

  // 形状二：每行一个对象（顺带剥掉代码块围栏）。
  for (const line of trimmed.split('\n')) {
    const body = line.trim().replace(/^```[a-zA-Z]*/, '').replace(/```$/, '').trim()
    if (!body.startsWith('{')) continue
    try {
      const candidate = asCandidate(JSON.parse(body) as unknown)
      if (candidate !== undefined) out.push(candidate)
    } catch {
      // 单行坏了就跳过这一行：不因为一行 JSON 语法错误丢掉整场梦。
      continue
    }
    if (out.length >= max) break
  }

  return Object.freeze(out)
}

/** 判一个解析结果是不是候选。 */
function asCandidate(value: unknown): RawCandidate | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  if (typeof row['text'] !== 'string' || row['text'].trim() === '') return undefined
  return {
    text: row['text'],
    category: typeof row['category'] === 'string' ? row['category'] : '',
    kind: typeof row['kind'] === 'string' ? row['kind'] : '',
    ...(typeof row['subject'] === 'string' && row['subject'] !== '' ? { subject: row['subject'] } : {}),
    quote: typeof row['quote'] === 'string' ? row['quote'] : '',
  }
}

/** 取错误消息。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
