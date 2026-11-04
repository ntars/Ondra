/**
 * Sidebar shell: column geometry and global panel navigation.
 * The frame locks the column to a quarter split (ui-layout columns.ts), so the
 * shell has a single state: it never collapses, hides, or expands, and no
 * control animates between two widths. Every seat therefore receives
 * `wide: true`. The workspace/session browsing region between global panel rows
 * and the foot is the `sidebar.workspaces` registrant's, and the foot holds
 * `sidebar.settings` plus `sidebar.footer.action`.
 *
 * The column also owns whether the scroll regions nested in it draw a
 * scrollbar at all: the shell tracks the pointer and rebinds ui-theme's
 * scrollbar indirection away while it is elsewhere, so a list the user is not
 * pointing at carries no bar.
 */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  FishLogo, IconAppsAddOutlineRegular, IconPlusOutlineRegular,
  isDarwinDesktop, Menu,
} from '@ntars/ondra-client-ui-primitives'
import type { InjectFace, PropsRenderSlots, PropsRuntime } from '@ntars/ondra-client-ui-slots'
import type {
  SidebarPanelActionsOwnerProps, SidebarPanelMetadata, SidebarRootComponentProps, SidebarRootInjected,
} from './contract/slots.ts'
import { FIXED_PANEL_ID } from './panel-pins.ts'
import { currentPersona } from './persona-catalog.ts'
import { ViewSwitch } from './ViewSwitch.tsx'
import css from './SidebarRoot.module.css'

/**
 * How long the column's scrollbars stay drawn after the pointer leaves it.
 * The bar is a pointer affordance here, and hiding it on the leave event
 * itself makes it blink out while the pointer is only crossing the column's
 * edge — on the way to the conversation, or around a portalled menu.
 */
const SCROLLBAR_LINGER_MS = 2000

type PanelRowProps =
  Pick<SidebarPanelMetadata, 'id' | 'label'>
  & Pick<PropsRuntime<'sidebar'>, 'usePanelInfo'>
  & Pick<InjectFace<SidebarRootInjected>, 'selectPanel' | 'trackEntryClick'>
  & PropsRenderSlots<'sidebar.panellist'>

/** Analytics category of an official panel; other panels are never reported. */
function officialEntry(id: string): 'plugin' | 'cron' | undefined {
  if (id === 'plugins') return 'plugin'
  return id === 'schedules' ? 'cron' : undefined
}

/** Each panel row subscribes only to its own selection state. */
function PanelRow({ id, label, usePanelInfo, selectPanel, trackEntryClick, renderSlot }: PanelRowProps) {
  const active = usePanelInfo(info => info.activePanelId === id)
  return (
    <button
      type="button"
      className={clsx(css.panelRow, active && css.panelActive)}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      onClick={() => {
        const entry = officialEntry(id)
        if (entry !== undefined) trackEntryClick({ menu_name: entry, position: 'sidebar' })
        selectPanel(id)
      }}
    >
      <span className={css.panelGlyph} aria-hidden="true">
        {renderSlot('sidebar.panellist', { size: 16, active }, { only: id })}
      </span>
      <span className={css.panelTitle}>
        {label}
      </span>
    </button>
  )
}

type PanelMoreMenuProps =
  Omit<SidebarPanelActionsOwnerProps, 'onDismiss'>
  & PropsRenderSlots<'sidebar.panellist.actions'>
  & Pick<InjectFace<SidebarRootInjected>, 'trackEntryClick'>
  & { readonly label: string }

/** The panel list's More launcher: a panel-row button whose menu rows come from `sidebar.panellist.actions`. */
function PanelMoreMenu({ label, entries, onOpen, onPinnedChange, trackEntryClick, renderSlot }: PanelMoreMenuProps) {
  const [open, setOpen] = useState(false)
  const onDismiss = (): void => { setOpen(false) }
  return (
    <Menu open={open} onClose={onDismiss} portal autoFocus className={css.moreAnchor} listClassName={css.moreMenu}
      anchor={(
        <button type="button" className={css.panelRow} aria-label={label} aria-haspopup="menu" aria-expanded={open}
          onClick={() => {
            trackEntryClick({ menu_name: 'more', position: 'sidebar' })
            setOpen(value => !value)
          }}>
          <span className={css.panelGlyph} aria-hidden="true"><IconAppsAddOutlineRegular size={16} /></span>
          <span className={css.panelTitle}>{label}</span>
        </button>
      )}>
      {renderSlot('sidebar.panellist.actions', { entries, onOpen, onPinnedChange, onDismiss })}
    </Menu>
  )
}

/**
 * Render the sidebar column shell.
 * @param props - composed slot props (runtime share + injected callbacks, contract/slots.ts).
 * @returns the sidebar element tree.
 */
export function SidebarRoot({
  width,
  startSession,
  selectPanel,
  setPinned,
  trackEntryClick,
  useRemoteAccess,
  usePanels,
  useEntryPins,
  useEntryActions,
  useShortcuts,
  usePanelInfo,
  viewSelection,
  t,
  renderSlot,
}: SidebarRootComponentProps) {
  const panels = usePanels(snapshot => snapshot)
  const unpinned = useEntryPins(ids => ids)
  const activePanelId = usePanelInfo(info => info.activePanelId)
  const hasEntryActions = useEntryActions(registered => registered)
  const newShortcut = useShortcuts(rows => rows.find(row => row.id === 'session.new'))
  // A page whose access snapshot excludes starting a Session offers no New Session affordance.
  const canStartSession = useRemoteAccess('session/create')
  const openNewSession = (): void => {
    trackEntryClick({ menu_name: 'new_session', position: 'sidebar' })
    startSession()
  }

  // Scrollbars in the column follow the pointer (.quietBars rebinds them
  // away): drawn while it is inside, and for SCROLLBAR_LINGER_MS after it
  // leaves. A pointer that returns within that window cancels the pending
  // hide rather than restarting from a hidden bar.
  const column = useRef<HTMLDivElement>(null)
  const [pointerInside, setPointerInside] = useState(false)
  const lingerTimer = useRef<number | undefined>(undefined)
  const armLinger = (): void => {
    if (lingerTimer.current !== undefined) return
    lingerTimer.current = window.setTimeout(() => {
      lingerTimer.current = undefined
      setPointerInside(false)
    }, SCROLLBAR_LINGER_MS)
  }
  const cancelLinger = (): void => {
    window.clearTimeout(lingerTimer.current)
    lingerTimer.current = undefined
  }
  // Leaving is decided by the column's BOX, not by DOM containment, and only
  // while the bars are drawn. ui-settings renders its full-viewport panel as a
  // fixed-position DESCENDANT of this column, so a pointer moved onto that
  // panel — or onto the conversation once it closes — fires no `pointerleave`
  // here, and the bars would stay drawn over a column nobody is pointing at.
  // The element's own leave stays as the one signal geometry cannot give: a
  // pointer that leaves the window emits no further moves.
  useEffect(() => {
    if (!pointerInside) return
    const onMove = (event: PointerEvent): void => {
      const rect = column.current?.getBoundingClientRect()
      /* v8 ignore next -- the listener only exists while the column is mounted and revealed. */
      if (rect === undefined) return
      const inside = event.clientX >= rect.left && event.clientX < rect.right
        && event.clientY >= rect.top && event.clientY < rect.bottom
      if (inside) cancelLinger()
      else armLinger()
    }
    document.addEventListener('pointermove', onMove)
    return () => {
      document.removeEventListener('pointermove', onMove)
      cancelLinger()
    }
  }, [pointerInside])

  const darwinDesktop = isDarwinDesktop()
  return (
    <div
      ref={column}
      className={clsx(css.root, !pointerInside && css.quietBars)}
      style={{ width }}
      onPointerEnter={() => {
        cancelLinger()
        setPointerInside(true)
      }}
      onPointerLeave={() => { armLinger() }}
    >
      {/* macOS hiddenInset titlebar: the strip clears the traffic lights and
          carries the column's own window-drag surface. */}
      {darwinDesktop && <div className={css.topStrip} data-window-drag />}
      <div className={css.logoRow} data-window-drag>
        {/* The identity is never the click target: on macOS this row is the
            window's drag band, and a button here would subtract itself from it.
            New Session is the round + at the row's trailing edge instead, so the
            drag band and the create action each keep their own place. Both
            occupants are slot fallbacks: Ondra presents the current persona
            here, and the persona plugin replaces them wholesale by registering
            the slots. */}
        <span className={css.brand}>
          {(() => {
            const persona = currentPersona()
            return (
              <span className={css.brandIdentity} aria-hidden="true">
                <span className={css.brandMark}>
                  {renderSlot('sidebar.brand.mark', { size: 24 }, {
                    fallback: <span className={css.personaAvatar}><FishLogo size={17} /></span>,
                  })}
                </span>
                <span className={css.brandName}>
                  {renderSlot('sidebar.brand.name', {}, {
                    fallback: (
                      <span className={css.persona}>
                        <span className={css.personaName}>{persona.name}</span>
                        <span className={css.personaPresence}>
                          <span className={css.presenceDot} />
                          {t('brand.online')}
                        </span>
                      </span>
                    ),
                  })}
                </span>
              </span>
            )
          })()}
        </span>
        {canStartSession && (
          <button
            type="button"
            className={css.newSessionIcon}
            aria-label={t('session.new.label')}
            title={t('session.new.label')}
            aria-keyshortcuts={newShortcut?.aria}
            onClick={openNewSession}
          >
            <IconPlusOutlineRegular size={15} />
          </button>
        )}
      </div>

      {/* The two-view switch: 「对话 / 日志」. It drives the middle column
          through the conversation's published selection, so the left list and
          the status column stay put while the centre swaps readings. */}
      <ViewSwitch chatLabel={t('view.chat')} logLabel={t('view.log')} selection={viewSelection} />

      {/* No New Session bar here. The column is a conversation list, not a
          launcher: the demo's left column goes identity → switch → sessions →
          settings, and a full-width create button between the switch and the
          list is the one element that makes the column read as a workspace
          tool instead of a chat list. Creating still has two entrances — the
          identity row (a button while `session/create` is allowed) and the
          ⌘N command — so this removes a button, not the capability. */}

      {panels.length > 0 && (
        <nav className={css.panelList} aria-label={t('panels.label')}>
          {panels.filter(({ id }) => id === FIXED_PANEL_ID || !unpinned.includes(id)).map(({ id, label }) => (
            <PanelRow
              key={id}
              id={id}
              label={label}
              usePanelInfo={usePanelInfo}
              selectPanel={selectPanel}
              trackEntryClick={trackEntryClick}
              renderSlot={renderSlot}
            />
          ))}
          {hasEntryActions && (
            <PanelMoreMenu
              label={t('panels.more')}
              entries={panels.filter(({ id }) => id !== FIXED_PANEL_ID)
                .map(({ id, label }) => ({ id, label, pinned: !unpinned.includes(id), active: id === activePanelId }))}
              onOpen={(id) => {
                const entry = officialEntry(id)
                if (entry !== undefined) trackEntryClick({ menu_name: entry, position: 'sidebar_more' })
                const panel = panels.find(candidate => candidate.id === id)
                if (panel !== undefined) selectPanel(panel.id)
              }}
              onPinnedChange={setPinned}
              trackEntryClick={trackEntryClick}
              renderSlot={renderSlot}
            />
          )}
        </nav>
      )}

      {/* The browsing region fills the column between the controls and the
          foot. */}
      <div className={css.regionArea}>
        {renderSlot('sidebar.workspaces', {})}
      </div>

      {/* Footer actions stack above Settings. */}
      <div className={css.footArea}>
        <div className={css.footerActions}>
          {renderSlot('sidebar.footer.action', {})}
        </div>
        <div className={css.settingsArea}>
          {renderSlot('sidebar.settings', {})}
        </div>
      </div>
    </div>
  )
}
