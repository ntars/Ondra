/**
 * The status page: the right column's answer to "how is she right now".
 *
 * Four cards, in the order the column reads top to bottom: the present moment,
 * the relationship, what she remembers, and the desktop pet. Each card is one
 * question a user asks about a companion they cannot see — and each answers it
 * with a length, not a hue, so the page survives a colour-blind reader and a
 * monochrome screenshot alike (the handbook retired the sixteen-colour
 * semantic ramp for exactly this reason: 9.9 界面精确规格).
 *
 * The numbers are REAL: they come from the one snapshot this column is allowed
 * to read (7.5: the display column never calls a model and never writes business
 * data). The engines that fill that snapshot — emotion quick variables, the five
 * relationship dimensions, the memory recall feed, the pet host — are not wired
 * yet, so the reading below is empty: zero meters, empty lists, and an honest
 * line saying there is nothing measured. A page that invented a plausible
 * number would be worse than a page that admits the gap.
 */
import type { ReactNode } from 'react'
import type {
  InjectFace, PropsLocale, PropsRuntime,
} from '@ntars/ondra-client-ui-slots'
import type {} from '../../contract/slots.ts'
import { StateGlyph } from './StateGlyph.tsx'
import { PetGlyph } from './PetGlyph.tsx'
import css from './StateBody.module.css'

/** One relationship dimension: stable key, the caption, and its 0–100 reading. */
interface RelationReading {
  readonly key: string
  readonly label: string
  readonly value: number
}

/** One remembered line: what she recalls, and how long ago it surfaced. */
interface MemoryReading {
  readonly id: string
  readonly summary: string
  readonly relative: string
}

/** The reading shape the four cards consume; the sampling below fills it now. */
interface StateReading {
  readonly summary: string
  readonly mood: number
  readonly energy: number
  readonly moodLabel: string
  readonly stage: string
  readonly relation: readonly RelationReading[]
  readonly memories: readonly MemoryReading[]
}

/**
 * The reading the four cards render.
 *
 * Every number is zero and every list is empty: the engines that will produce
 * them (emotion quick variables, the five relationship dimensions, the memory
 * recall feed, the pet host) are not wired yet, and a page that invented a
 * plausible number would be worse than a page that admits the gap. The shape
 * below is the contract those engines will fill; until then the page shows the
 * truth — nothing measured yet — rather than a demo.
 */
const EMPTY: StateReading = {
  /** One natural-language sentence: the quick variables projected as words. */
  summary: '',
  /** Mood quick variable, 0–100. */
  mood: 0,
  /** Energy quick variable, 0–100. */
  energy: 0,
  /** The six-state label the emotion engine settled on. */
  moodLabel: '',
  /** Relationship stage, shown on the card's trailing edge. */
  stage: '',
  /** The five relationship dimensions, 0–100 each; the bar denominator is 100. */
  relation: [],
  /** Recently recalled or written memories, newest first. */
  memories: [],
}

/** Everything the page needs beyond the framework shares. */
export interface StateBodyInjected {
  /** Open the memory drawer the "all" control leads to (7.3-⑤). */
  readonly openMemory: () => void
  /** Ask the pet host to bring the companion onto the desktop (6.3). */
  readonly summonPet: () => void
}

/** The page's composed props: the tab it draws plus its own two actions. */
export type StateBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & InjectFace<StateBodyInjected>
  & PropsLocale<'sidebarRight'>

/** One labelled meter: a caption, a track, and the reading on the trailing edge. */
function Meter({ label, value }: { readonly label: string; readonly value: number }): ReactNode {
  return (
    <div className={css.meter}>
      <span className={css.meterLabel}>{label}</span>
      <span
        className={css.meterTrack}
        role="meter"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <span className={css.meterFill} style={{ inlineSize: `${value}%` }} />
      </span>
      <span className={css.meterValue}>{value}</span>
    </div>
  )
}

/** A card shell: the heading row is the card's whole chrome. */
function Card({ title, aside, children }: {
  readonly title: string
  readonly aside?: ReactNode
  readonly children: ReactNode
}): ReactNode {
  return (
    <section className={css.card}>
      <header className={css.cardHead}>
        <h2 className={css.cardTitle}>{title}</h2>
        {aside !== undefined && <div className={css.cardAside}>{aside}</div>}
      </header>
      {children}
    </section>
  )
}

/**
 * Draw the status page.
 * @param props - tab runtime share, the page's two actions, and copy.
 * @returns the four-card column.
 */
export function StateBody({ openMemory, summonPet, t }: StateBodyProps): ReactNode {
  return (
    <div className={css.root} data-sidebar-right-state>
      {/* The page's own top edge. While the strip withdraws (the resting panel —
          see SidebarRight.module.css) this row is what the column hangs its
          title from, so the panel reads as a standing status column rather than
          a viewer with its chrome missing. Its height matches the strip it
          replaces, so nothing jumps when a second tab puts the strip back.
          It scrolls with the cards, so it is content rather than a chrome row:
          no drag mark here, because a drag region over a scrolling content
          container would carry its text instead of receiving clicks. */}
      <header className={css.pageHead}>
        <h1 className={css.pageTitle}>{t('tab.state.title')}</h1>
        <span className={css.pageStamp}>{t('state.stamp')}</span>
      </header>
      <Card
        title={t('state.now.title')}
        aside={EMPTY.moodLabel === '' ? undefined : <span className={css.chip}>{EMPTY.moodLabel}</span>}
      >
        {EMPTY.summary === ''
          ? <p className={css.empty}>{t('state.now.empty')}</p>
          : <p className={css.summary}>{EMPTY.summary}</p>}
        <Meter label={t('state.now.mood')} value={EMPTY.mood} />
        <Meter label={t('state.now.energy')} value={EMPTY.energy} />
      </Card>

      <Card
        title={t('state.relation.title')}
        aside={EMPTY.stage === '' ? undefined : <span className={css.chipQuiet}>{EMPTY.stage}</span>}
      >
        {EMPTY.relation.length === 0
          ? <p className={css.empty}>{t('state.relation.empty')}</p>
          : EMPTY.relation.map(({ key, label, value }) => (
            <Meter key={key} label={label} value={value} />
          ))}
        <p className={css.note}>{t('state.relation.note')}</p>
      </Card>

      <Card
        title={t('state.memory.title')}
        aside={(
          <button type="button" className={css.link} onClick={openMemory}>
            {t('state.memory.all')}
          </button>
        )}
      >
        {EMPTY.memories.length === 0
          ? <p className={css.empty}>{t('state.memory.empty')}</p>
          : (
            <ul className={css.memoryList}>
              {EMPTY.memories.map(memory => (
                <li key={memory.id} className={css.memoryRow}>
                  <span className={css.memoryText}>{memory.summary}</span>
                  <span className={css.memoryTime}>{memory.relative}</span>
                </li>
              ))}
            </ul>
          )}
      </Card>

      <Card
        title={t('state.pet.title')}
        aside={<span className={css.chipQuiet}>{t('state.pet.idle')}</span>}
      >
        <div className={css.petBody}>
          <span className={css.petMark} aria-hidden="true"><PetGlyph size={26} /></span>
          <p className={css.petHint}>{t('state.pet.hint')}</p>
          <button type="button" className={css.petButton} onClick={summonPet}>
            {t('state.pet.summon')}
          </button>
        </div>
      </Card>
    </div>
  )
}

/** The page's chip title: a gauge before the type's label, under the same rule the guide uses. */
export function StateTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return (
    <>
      <StateGlyph size={13} className={css.titleIcon} />
      {/* `css.titleText` carries the primary ink. The strip's own chip colour is
          the secondary label alias, which reads as "disabled" beside the
          neighbouring controls in dark mode; a chip that names the page the
          column is showing should read at the same weight as the page's own
          headings. */}
      <span className={css.titleText}>{tab.title}</span>
    </>
  )
}
