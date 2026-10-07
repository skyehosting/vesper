/**
 * Keyboard shortcut display: "Mod+Shift+K" → ["Ctrl", "Shift", "K"] on Windows/Linux, ["⌘", "⇧", "K"] on Apple
 * platforms (phones/tablets reaching Vesper from Safari). `Mod` is the platform's command modifier.
 */

export type KeyPlatform = 'mac' | 'other'

const NAMES: Record<string, { mac: string; other: string }> = {
  mod: { mac: '⌘', other: 'Ctrl' },
  ctrl: { mac: '⌃', other: 'Ctrl' },
  control: { mac: '⌃', other: 'Ctrl' },
  cmd: { mac: '⌘', other: 'Win' },
  meta: { mac: '⌘', other: 'Win' },
  alt: { mac: '⌥', other: 'Alt' },
  option: { mac: '⌥', other: 'Alt' },
  shift: { mac: '⇧', other: 'Shift' },
  enter: { mac: '↩', other: 'Enter' },
  return: { mac: '↩', other: 'Enter' },
  escape: { mac: 'Esc', other: 'Esc' },
  esc: { mac: 'Esc', other: 'Esc' },
  space: { mac: 'Space', other: 'Space' },
  tab: { mac: '⇥', other: 'Tab' },
  backspace: { mac: '⌫', other: 'Backspace' },
  delete: { mac: '⌦', other: 'Del' },
  arrowup: { mac: '↑', other: '↑' },
  arrowdown: { mac: '↓', other: '↓' },
  arrowleft: { mac: '←', other: '←' },
  arrowright: { mac: '→', other: '→' },
  up: { mac: '↑', other: '↑' },
  down: { mac: '↓', other: '↓' },
  left: { mac: '←', other: '←' },
  right: { mac: '→', other: '→' },
  pageup: { mac: 'PgUp', other: 'PgUp' },
  pagedown: { mac: 'PgDn', other: 'PgDn' }
}

/** Readable names for screen readers ("Control Shift K"), since "⌘" or "↑" read poorly. */
const SPOKEN: Record<string, string> = { '⌘': 'Command', '⇧': 'Shift', '⌥': 'Option', '⌃': 'Control', '↩': 'Return', '↑': 'Up', '↓': 'Down', '←': 'Left', '→': 'Right', '⇥': 'Tab', '⌫': 'Delete', '⌦': 'Forward delete', Ctrl: 'Control', Del: 'Delete', PgUp: 'Page up', PgDn: 'Page down' }

export function detectPlatform(nav: { platform?: string; userAgent?: string } | undefined = globalThis.navigator): KeyPlatform {
  const s = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`
  return /Mac|iPhone|iPad|iPod/i.test(s) ? 'mac' : 'other'
}

export function parseShortcut(shortcut: string, platform: KeyPlatform): string[] {
  // "+" alone (or a trailing "++") is the plus key.
  const parts = shortcut.split(/\+(?!$)/).map((p) => p.trim()).filter(Boolean)
  return parts.map((p) => {
    const named = NAMES[p.toLowerCase()]
    if (named) return named[platform]
    return p.length === 1 ? p.toUpperCase() : p
  })
}

export function spokenShortcut(keys: readonly string[]): string {
  return keys.map((k) => SPOKEN[k] ?? k).join(' ')
}
