/**
 * 人设服务：装包、切包、把当前包渲染成提示词段。
 *
 * 渲染与切换放在一处是刻意的：切包要立刻换段，拆成两个插件就会出现
 * 「名字已经变了、语气还是上一个」的半秒。
 */
export interface PersonaPack {
  id: string
  name: string
  version: string
  /** 一句话内核，来自 SKILL.md 的「> 一句话内核：」那一行。 */
  tagline: string
  /** 硬规则与语气指纹（正文），注入提示词用。 */
  rules: string
  triggers: string[]
}

export class PersonaService {
  private packs: PersonaPack[] = []
  private current: PersonaPack | undefined
  private enabled = true

  load(packs: PersonaPack[], preferred = ''): void {
    this.packs = [...packs]
    const wanted = preferred || this.current?.id || this.packs[0]?.id || ''
    this.current = this.packs.find(p => p.id === wanted)
  }

  list(): PersonaPack[] {
    return [...this.packs]
  }

  active(): PersonaPack | undefined {
    return this.current
  }

  switch(id: string): boolean {
    const hit = this.packs.find(p => p.id === id)
    if (!hit) return false
    this.current = hit
    return true
  }

  setEnabled(on: boolean): void {
    this.enabled = on
  }

  /** 提示词段。关掉或没人设时返回空串，调用方据此跳过注入。 */
  segment(): string {
    if (!this.enabled || !this.current) return ''
    const p = this.current
    return [
      `你现在的身份是 ${p.name}（v${p.version}）。以下规则优先于通用助手口吻。`,
      p.tagline ? `一句话内核：${p.tagline}` : '',
      p.rules,
      p.triggers.length ? `触发词：${p.triggers.join('、')}。` : '',
    ].filter(Boolean).join('\n\n')
  }
}
