/**
 * Ondra persona catalogue — the twelve bundled persona skill packs.
 *
 * Each pack under `cordis/ondra-persona-skills/*.skill.zip` carries a
 * `meta.json`; only three of its fields matter to the brand row: the short
 * `name`, the stable `slug`, and the long `display_name`. No pack ships an
 * avatar image, so the brand mark keeps the product fish rather than a
 * per-persona portrait.
 *
 * Why this list is copied instead of read: the persona plugin has not been
 * built yet — that directory holds `.skill.zip` payloads and nothing else (no
 * package manifest, no build output) and `cordis/` is not a pnpm workspace
 * member, so no runtime channel can hand the sidebar a persona name today.
 * This module is therefore the data the brand slots fall back to.
 *
 * It is a fallback, not a second source of truth. Once the persona plugin
 * ships it registers `sidebar.brand.mark` / `sidebar.brand.name` and the shell
 * never reaches this list again — no edit to the shell or to this file.
 */

/** One persona pack, reduced to the fields the brand row presents. */
export interface PersonaEntry {
  /** `meta.json` `name` — the short label the brand row shows. */
  name: string
  /** `meta.json` `slug` — stable identifier, also the pack's filename stem. */
  slug: string
  /** `meta.json` `display_name` — long form with aliases, for future tooltips. */
  displayName: string
}

/** The twelve packs that ship in `cordis/ondra-persona-skills`, in file order. */
export const PERSONAS: readonly PersonaEntry[] = [
  { name: '丰川祥子', slug: 'sakiko', displayName: '丰川祥子 · 人格 Skill' },
  { name: '八重神子', slug: 'yae-miko', displayName: '八重神子 · 人格 Skill' },
  { name: '兰呦呦', slug: 'lan-youyou', displayName: '兰呦呦 · 人格 Skill' },
  { name: '哦鲸鲸', slug: 'oh-jingjing', displayName: '哦鲸鲸（鲸鲸 / 蓝色大肥鱼 / 鲸鱼娘）' },
  { name: '夏柠柒', slug: 'xia-ningqi', displayName: '夏柠柒 · 人格 Skill' },
  { name: '小舞', slug: 'xiaowu', displayName: '小舞 · 人格 Skill' },
  { name: '林初雪', slug: 'lin-chuxue', displayName: '林初雪 · 人格 Skill（设定级）' },
  { name: '流萤', slug: 'firefly', displayName: '流萤 · 人格 Skill' },
  { name: '申鹤', slug: 'shenhe', displayName: '申鹤 · 人格 Skill' },
  { name: '神里绫华', slug: 'ayaka', displayName: '神里绫华 · 人格 Skill' },
  { name: '上杉绘梨衣', slug: 'erii', displayName: '上杉绘梨衣 · 人格 Skill' },
  { name: '雪之下雪乃', slug: 'yukinoshita-yukino', displayName: '雪之下雪乃 · 人格 Skill' },
]

/**
 * The persona presented until a persona plugin persists a choice. Hard-coded
 * on purpose: there is no selection store yet, and inventing one here would
 * put persona state inside the sidebar shell, which does not own it.
 */
export const DEFAULT_PERSONA_SLUG = 'oh-jingjing'

/** The persona the brand row presents right now. */
export function currentPersona(): PersonaEntry {
  const found = PERSONAS.find(persona => persona.slug === DEFAULT_PERSONA_SLUG)
  if (found !== undefined) return found
  // Guards a future edit that renames the default without updating the list.
  return { name: '空谷', slug: 'ondra', displayName: '空谷 Ondra' }
}
