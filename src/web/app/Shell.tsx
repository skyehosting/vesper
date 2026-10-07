/**
 * The app shell (01 "Layout"; sessions-ui): sessions sidebar · main (top bar + page) · session panel.
 *
 * - Desktop: the sidebar collapses (remembered per device); the session panel is a column that opens per chat.
 *   The top bar is the window's drag region and leaves room for the native caption buttons (titleBarOverlay,
 *   `html.is-desktop` sets --caption-w).
 * - Phones (< 720 px, 07 D8): the sidebar and the panel become edge sheets (swipe/scrim/Esc to close, safe areas,
 *   44 px targets); the top bar keeps the title, voice and panel buttons.
 * - On a chat route (/s/:uid) the shell owns the top bar content (SessionHeader: Star stage, title, ID, chips); other
 *   pages put theirs in the slot with <TopBarContent>, and any page may add buttons with <TopBarActions>.
 * - On a chat route the avatar lives behind the messages (presence <ChatBackdrop>, rendered by the chat page; v11) and
 *   the top bar has a Talk mode button and the presence group: state words, pause, show/hide (R15, 07 D9).
 * - The desktop app's top bar shows "Update ready — Restart" once a new version is downloaded (H-v12-updates;
 *   dismissible, once per version; Talk mode has no top bar, so never there).
 * - Overlays: the Ctrl+K palette and the shortcuts sheet are code-split and mount only while open.
 */
import { lazy, Suspense, useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { AudioLines, Gamepad2, Menu as MenuIcon, PanelLeft, PanelRight, Search, Sparkles, Volume2, VolumeX, X } from 'lucide-react'
import { readyNoticeVersion } from '@shared/updater.logic'
import { IconButton } from '../components/IconButton'
import { toast } from '../components/Toast'
import { Tooltip } from '../components/Tooltip'
import { registerDefaultShortcuts, actions } from '../features/palette/actions'
import { installShortcuts } from '../features/palette/shortcuts'
import { PresenceControls } from '../features/presence'
import { EdgeSheet } from '../features/sessions/EdgeSheet'
import { installLive, useActiveSessionSync } from '../features/sessions/live'
import { SessionHeader } from '../features/sessions/SessionHeader'
import { Sidebar } from '../features/sessions/Sidebar'
import { useSpeakReplies } from '../features/sessions/speakReplies'
import { api } from '../lib/api'
import { toApiError } from '../lib/errors.logic'
import { useLocation } from '../lib/router'
import { matchPattern } from '../lib/router.logic'
import { useStore } from '../lib/store'
import { useIsPhone } from '../lib/useMediaQuery'
import { ConnectionBanner } from './ConnectionBanner'
import { TopBarActionsContext, TopBarSlotContext } from './topBar'
import '../features/sessions/testHooks'
import './shell.css'

const SessionPanel = lazy(() => import('../features/panel/SessionPanel'))
const loadPalette = (): Promise<typeof import('../features/palette/Palette')> => import('../features/palette/Palette')
const Palette = lazy(loadPalette)
const ShortcutsDialog = lazy(() => import('../features/palette/ShortcutsDialog'))

/** The open chat of a route: /s/:uid (and Talk mode's /talk/:uid, so the panel and commands know the session). */
export function sessionUidOf(pathname: string): { uid: string; chat: boolean } | null {
  const s = matchPattern('/s/:uid', pathname)
  if (s?.uid) return { uid: s.uid, chat: true }
  const t = matchPattern('/talk/:uid', pathname)
  if (t?.uid) return { uid: t.uid, chat: false }
  return null
}

// App-lifetime wiring (idempotent): realtime indicators and the standard shortcuts.
installLive()
registerDefaultShortcuts()

export function Shell({ children }: { children: ReactNode }): ReactNode {
  const phone = useIsPhone()
  const { pathname, path } = useLocation()
  const route = sessionUidOf(pathname)
  const chat = route?.chat === true
  useActiveSessionSync(route?.uid ?? null)

  const { sidebarOpen, sidebarCollapsed, panelOpen: panelWanted, paletteOpen, shortcutsOpen } = useStore((s) => s.ui)
  const setSidebarOpen = useStore((s) => s.setSidebarOpen)
  const setSidebarCollapsed = useStore((s) => s.setSidebarCollapsed)
  const setPanelOpen = useStore((s) => s.setPanelOpen)
  // The session panel belongs to an open chat; other pages (settings, search, constellation) don't show it.
  const panelOpen = panelWanted && chat
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null)

  useEffect(() => installShortcuts(), [])
  // Fetch the palette's chunk once the app is idle, so Ctrl+K opens instantly and no keystroke typed right after it
  // lands in the composer while the code loads.
  useEffect(() => {
    const ric = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500))
    const cancel = window.cancelIdleCallback ?? window.clearTimeout
    const h = ric(() => void loadPalette().catch(() => undefined))
    return () => cancel(h)
  }, [])

  // Phones: navigating closes the sheets (a chat picked from the list, a link in the panel).
  useLayoutEffect(() => {
    if (!phone) return
    const st = useStore.getState()
    st.setSidebarOpen(false)
    if (st.ui.panelOpen) st.setPanelOpen(false)
  }, [path, phone])

  const sidebarVisible = !phone && !sidebarCollapsed
  const cls = ['shell', phone ? 'shell--phone' : 'shell--wide', sidebarVisible && 'has-sidebar', !phone && panelOpen && 'has-panel'].filter(Boolean).join(' ')

  const sidebar = <Sidebar onCollapse={phone ? () => setSidebarOpen(false) : () => setSidebarCollapsed(true)} phone={phone} />
  const panel = (
    <Suspense fallback={<div className="shell__panel-fallback" />}>
      <SessionPanel onClose={() => setPanelOpen(false)} phone={phone} />
    </Suspense>
  )

  return (
    <div className={cls}>
      {phone ? (
        <EdgeSheet open={sidebarOpen} onClose={() => setSidebarOpen(false)} side="start" label="Chats" className="shell__sheet shell__sheet--sidebar">
          {sidebar}
        </EdgeSheet>
      ) : (
        <aside className="shell__sidebar" aria-label="Chats" inert={!sidebarVisible} data-open={sidebarVisible || undefined}>
          {sidebar}
        </aside>
      )}

      <main className="shell__main">
        <header className="shell__topbar app-drag" data-chat={chat || undefined}>
          {phone ? (
            <IconButton label="Chats" icon={<MenuIcon />} className="no-drag" onClick={() => setSidebarOpen(true)} tooltip={false} />
          ) : sidebarCollapsed ? (
            <IconButton label="Show sidebar" icon={<PanelLeft />} className="no-drag" onClick={() => setSidebarCollapsed(false)} tooltipSide="bottom" />
          ) : null}
          {chat && route ? <SessionHeader uid={route.uid} phone={phone} /> : <div className="shell__slot" ref={setSlot} />}
          <div className="shell__actions" ref={setActionsSlot} />
          <GameModePill compact={phone} />
          <UpdatePill talk={pathname.startsWith('/talk/')} />
          {chat ? <IconButton label="Talk mode" icon={<AudioLines />} className="no-drag shell__talk" onClick={actions.openTalk} tooltipSide="bottom" /> : null}
          {chat ? <PresenceControls /> : null}
          {chat ? <VoiceToggle /> : null}
          {phone || pathname === '/search' ? null : (
            <IconButton label="Search messages" icon={<Search />} className="no-drag" onClick={() => actions.searchMessages()} tooltipSide="bottom" />
          )}
          {chat ? (
            <IconButton
              label={panelOpen ? 'Hide chat panel' : 'Show chat panel'}
              icon={<PanelRight />}
              pressed={panelOpen}
              className="no-drag"
              onClick={() => setPanelOpen(!panelOpen)}
              tooltipSide="bottom"
            />
          ) : null}
        </header>
        {/* fix-ux F57: the offline/reconnecting strip sits in flow under the top bar instead of floating over the page. */}
        <ConnectionBanner inline />
        <TopBarSlotContext.Provider value={chat ? null : slot}>
          <TopBarActionsContext.Provider value={actionsSlot}>
            <div className="shell__content">{children}</div>
          </TopBarActionsContext.Provider>
        </TopBarSlotContext.Provider>
      </main>

      {phone ? (
        <EdgeSheet open={panelOpen} onClose={() => setPanelOpen(false)} side="end" label="Chat panel" className="shell__sheet shell__sheet--panel">
          {panel}
        </EdgeSheet>
      ) : (
        <aside className="shell__panel" aria-label="Chat panel" data-open={panelOpen || undefined}>
          {panelOpen ? panel : null}
        </aside>
      )}

      {paletteOpen ? (
        <Suspense fallback={null}>
          <Palette />
        </Suspense>
      ) : null}
      {shortcutsOpen ? (
        <Suspense fallback={null}>
          <ShortcutsDialog />
        </Suspense>
      ) : null}
    </div>
  )
}

/** "Game mode" (07 D3): shown while a fullscreen game has the PC; the Star is static and background work waits. */
function GameModePill({ compact }: { compact: boolean }): ReactNode {
  const game = useStore((s) => s.ui.gameMode)
  if (!game.active) return null
  const why = game.reason === 'forced' ? 'Game mode is on (Settings → Performance).' : 'A fullscreen app is in front, so Vesper is resting: the Star is still and background work waits.'
  return (
    <Tooltip content={why} side="bottom" describe={false}>
      <span className="shell__game no-drag" role="status" tabIndex={0} aria-label={`Game mode. ${why}`}>
        <Gamepad2 aria-hidden="true" />
        {compact ? null : <span>Game mode</span>}
      </span>
    </Tooltip>
  )
}

const UPDATE_DISMISSED_KEY = 'vesper.updateDismissed'

function readDismissed(): string | null {
  try {
    return localStorage.getItem(UPDATE_DISMISSED_KEY)
  } catch {
    return null
  }
}

/** "Update ready — Restart" (H-v12-updates): the desktop app, a downloaded version, not dismissed for that version. */
function UpdatePill({ talk }: { talk: boolean }): ReactNode {
  const status = useStore((s) => s.ui.update)
  const desktop = useStore((s) => s.bootstrap?.desktop ?? false)
  const [dismissed, setDismissed] = useState(readDismissed)
  const [restarting, setRestarting] = useState(false)
  const version = readyNoticeVersion({ status, desktop, talk, dismissed })
  if (!version) return null
  const dismiss = (): void => {
    try {
      localStorage.setItem(UPDATE_DISMISSED_KEY, version)
    } catch {
      /* storage unavailable: dismissed for this page only */
    }
    setDismissed(version)
  }
  const restart = (): void => {
    setRestarting(true)
    api('POST /api/system/update/restart').catch((e: unknown) => {
      setRestarting(false)
      toast.error(toApiError(e).message)
    })
  }
  return (
    <span className="shell__update no-drag" data-testid="update-pill">
      <Sparkles aria-hidden="true" />
      <span>Update ready</span>
      <span aria-hidden="true">—</span>
      <button type="button" className="shell__update-go" onClick={restart} disabled={restarting} aria-label={`Restart to update to version ${version}`}>
        Restart
      </button>
      <button type="button" className="shell__update-x" onClick={dismiss} aria-label="Dismiss the update notice">
        <X aria-hidden="true" />
      </button>
    </span>
  )
}

/** Speak replies on this device (07 D8 per-device autoSpeak). Off and explained when no voice is set up. */
function VoiceToggle(): ReactNode {
  const { available, on } = useSpeakReplies()
  return (
    <IconButton
      label={!available ? 'Voice replies (set up a voice first)' : on ? 'Voice replies on' : 'Voice replies off'}
      icon={on ? <Volume2 /> : <VolumeX />}
      pressed={available ? on : undefined}
      className={`no-drag shell__voice${on ? ' is-on' : ''}`}
      onClick={actions.toggleVoice}
      tooltipSide="bottom"
    />
  )
}
