/**
 * App-wide keyboard shortcuts (research 07 §4.2 "Ctrl+K palette and the standard shortcuts") and the list the "?"
 * sheet shows. Other features add theirs with `registerShortcut` (with `run`, it also fires; without, it is
 * display-only — e.g. chat-ui documents Ctrl+F there while handling it in its own page). One window listener, owned by
 * the shell (`installShortcuts` returns its remover).
 */
import { detectPlatform } from '../../components/internal/kbd.logic'
import { track } from '../../components/internal/stats'
import { hasCommandModifier, isTypingTarget, matchesSpec, parseSpec, type ParsedSpec } from './shortcuts.logic'

export type ShortcutGroup = 'General' | 'Chats' | 'In a chat' | 'Chat list'

export interface Shortcut {
  id: string
  /** Kbd notation, e.g. "Mod+Shift+O". */
  keys: string
  /** Extra notations shown and matched too ("?" for the help sheet). */
  alt?: string[]
  label: string
  group: ShortcutGroup
  run?: () => void
  /** Only when this returns true (e.g. a chat is open). */
  when?: () => boolean
}

interface Entry extends Shortcut {
  specs: ParsedSpec[]
}

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
const platform = typeof navigator === 'undefined' ? 'other' : detectPlatform()

export function registerShortcut(s: Shortcut): () => void {
  const entry: Entry = { ...s, specs: [s.keys, ...(s.alt ?? [])].map(parseSpec) }
  entries.set(s.id, entry)
  for (const l of [...listeners]) l()
  return () => {
    if (entries.get(s.id) === entry) entries.delete(s.id)
    for (const l of [...listeners]) l()
  }
}

export function listShortcuts(): Shortcut[] {
  return [...entries.values()]
}

export function onShortcutsChanged(cb: () => void): () => void {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

/** The display keys of a registered shortcut (palette hints), or undefined. */
export function shortcutKeys(id: string): string | undefined {
  return entries.get(id)?.keys
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.isComposing || e.repeat) return
  const typing = isTypingTarget(e.target as HTMLElement | null)
  for (const s of entries.values()) {
    if (!s.run) continue
    for (const spec of s.specs) {
      if (!matchesSpec(spec, e, platform)) continue
      if (typing && !hasCommandModifier(spec)) continue
      if (s.when && !s.when()) continue
      // A modal (dialog, sheet) owns the keyboard: only the palette/help toggles pass through it.
      const root = document.getElementById('root')
      if (root?.inert && !s.id.startsWith('app.')) continue
      e.preventDefault()
      s.run()
      return
    }
  }
}

let installed = 0

/** The single window listener; the shell installs it on mount and removes it on unmount. */
export function installShortcuts(): () => void {
  window.addEventListener('keydown', onKeyDown)
  installed++
  track('nav.windowListeners', 1)
  let done = false
  return () => {
    if (done) return
    done = true
    window.removeEventListener('keydown', onKeyDown)
    installed--
    track('nav.windowListeners', -1)
  }
}

export function shortcutStats(): { registered: number; installed: number } {
  return { registered: entries.size, installed }
}

/** Which tab the help sheet opens on next (set by `actions.openHelp`; the sheet resets it when it closes). */
let helpTab: 'keys' | 'commands' = 'keys'

export function setHelpTab(tab: 'keys' | 'commands'): void {
  helpTab = tab
}

export function helpTabNow(): 'keys' | 'commands' {
  return helpTab
}
