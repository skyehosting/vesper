/**
 * Shell layout state (sessions-ui): sidebar/panel visibility, which sidebar view is showing, the Ctrl+K palette and the
 * shortcuts sheet, plus app-wide indicators the top bar shows (game mode 07 D3, memory status 07 D13, the updater's
 * state H-v12-updates). The desktop
 * sidebar collapse and the panel's open state are remembered per device (localStorage, best effort).
 */
import type { UpdateStatus } from '@shared/api'
import type { MemoryStatus } from '@shared/types/domain'
import type { GameModeReason } from '@shared/ws'
import type { SliceCreator } from './types'

const COLLAPSE_KEY = 'vesper.sidebarCollapsed'
const PANEL_KEY = 'vesper.panelOpen'

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    // storage unavailable (private mode): remember it for this page only
  }
}

/** Sections of the session panel a command or chip can jump to. */
export type PanelSection = 'prompt' | 'memory' | 'links' | 'voice' | 'info'
export type SidebarView = 'chats' | 'archived' | 'trash'

export interface UiSlice {
  ui: {
    /** Phone: the sessions sheet is open. */
    sidebarOpen: boolean
    /** Desktop: the sidebar is collapsed to give the chat the full width. */
    sidebarCollapsed: boolean
    /** The right session panel (hidden by default). */
    panelOpen: boolean
    /** Section to bring into view when the panel shows (consumed by the panel). */
    panelFocus: PanelSection | null
    sidebarView: SidebarView
    /** Ctrl+K palette; `paletteSeed` is the text it opens with ('' or '/'). */
    paletteOpen: boolean
    paletteSeed: string
    /** The keyboard shortcuts / commands sheet ("?"). */
    shortcutsOpen: boolean
    /** Game mode (07 D3): Bootstrap.gameMode, then `gamemode.changed`. */
    gameMode: { active: boolean; reason: GameModeReason }
    /** Memory index status: Bootstrap.memory, then `memory.progress`. */
    memoryStatus: MemoryStatus | null
    /** The updater (H-v12-updates): GET /api/system/update on every connect, then `update.state`. */
    update: UpdateStatus | null
  }
  setSidebarOpen(open: boolean): void
  setSidebarCollapsed(collapsed: boolean): void
  setPanelOpen(open: boolean, focus?: PanelSection | null): void
  clearPanelFocus(): void
  setSidebarView(view: SidebarView): void
  openPalette(seed?: string): void
  closePalette(): void
  setShortcutsOpen(open: boolean): void
  setGameMode(g: { active: boolean; reason: GameModeReason }): void
  setMemoryStatus(m: MemoryStatus | null): void
  setUpdate(u: UpdateStatus | null): void
}

export const createUiSlice: SliceCreator<UiSlice> = (set) => ({
  ui: {
    sidebarOpen: false,
    sidebarCollapsed: readFlag(COLLAPSE_KEY),
    panelOpen: readFlag(PANEL_KEY),
    panelFocus: null,
    sidebarView: 'chats',
    paletteOpen: false,
    paletteSeed: '',
    shortcutsOpen: false,
    gameMode: { active: false, reason: 'off' },
    memoryStatus: null,
    update: null
  },
  setSidebarOpen: (sidebarOpen) => set((s) => (s.ui.sidebarOpen === sidebarOpen ? {} : { ui: { ...s.ui, sidebarOpen } })),
  setSidebarCollapsed: (sidebarCollapsed) => {
    writeFlag(COLLAPSE_KEY, sidebarCollapsed)
    set((s) => ({ ui: { ...s.ui, sidebarCollapsed } }))
  },
  setPanelOpen: (panelOpen, focus = null) => {
    writeFlag(PANEL_KEY, panelOpen)
    set((s) => ({ ui: { ...s.ui, panelOpen, panelFocus: panelOpen ? focus : null } }))
  },
  clearPanelFocus: () => set((s) => (s.ui.panelFocus === null ? {} : { ui: { ...s.ui, panelFocus: null } })),
  setSidebarView: (sidebarView) => set((s) => (s.ui.sidebarView === sidebarView ? {} : { ui: { ...s.ui, sidebarView } })),
  openPalette: (seed = '') => set((s) => ({ ui: { ...s.ui, paletteOpen: true, paletteSeed: seed, shortcutsOpen: false } })),
  closePalette: () => set((s) => (s.ui.paletteOpen ? { ui: { ...s.ui, paletteOpen: false, paletteSeed: '' } } : {})),
  setShortcutsOpen: (shortcutsOpen) => set((s) => ({ ui: { ...s.ui, shortcutsOpen, paletteOpen: shortcutsOpen ? false : s.ui.paletteOpen } })),
  setGameMode: (gameMode) =>
    set((s) => (s.ui.gameMode.active === gameMode.active && s.ui.gameMode.reason === gameMode.reason ? {} : { ui: { ...s.ui, gameMode } })),
  setMemoryStatus: (memoryStatus) => set((s) => ({ ui: { ...s.ui, memoryStatus } })),
  setUpdate: (update) => set((s) => ({ ui: { ...s.ui, update } }))
})
