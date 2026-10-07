/**
 * Keyboard shortcut matching, pure (unit-tested). Specs use the Kbd notation: "Mod+Shift+O", "Alt+Shift+ArrowDown",
 * "?", "F2". `Mod` is Ctrl on Windows/Linux and ⌘ on Apple devices. Letters match case-insensitively; a printable
 * symbol like "?" or "/" matches `event.key` whatever Shift state produced it (keyboard layouts differ).
 */

export interface KeyEventLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export interface ParsedSpec {
  mod: boolean
  ctrl: boolean
  shift: boolean
  alt: boolean
  key: string
}

const ALIASES: Record<string, string> = {
  esc: 'escape',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  del: 'delete',
  space: ' ',
  comma: ',',
  period: '.',
  slash: '/'
}

export function parseSpec(spec: string): ParsedSpec {
  const parts = spec.split(/\+(?!$)/).map((p) => p.trim())
  const out: ParsedSpec = { mod: false, ctrl: false, shift: false, alt: false, key: '' }
  for (const p of parts) {
    const l = p.toLowerCase()
    if (l === 'mod') out.mod = true
    else if (l === 'ctrl' || l === 'control') out.ctrl = true
    else if (l === 'shift') out.shift = true
    else if (l === 'alt' || l === 'option') out.alt = true
    else out.key = ALIASES[l] ?? l
  }
  return out
}

/** A one-character key that is not a letter or digit ("?", "/", ".", ","): Shift is part of producing it. */
function isSymbol(key: string): boolean {
  return key.length === 1 && !/[a-z0-9 ]/i.test(key)
}

export function matchesSpec(spec: ParsedSpec, e: KeyEventLike, platform: 'mac' | 'other'): boolean {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase()
  if (key !== spec.key) return false
  const wantMeta = spec.mod && platform === 'mac'
  const wantCtrl = spec.ctrl || (spec.mod && platform !== 'mac')
  if (e.metaKey !== wantMeta || e.ctrlKey !== wantCtrl || e.altKey !== spec.alt) return false
  // "?" is Shift+/ on US layouts but a plain key on others: ignore Shift for symbols unless the spec names it.
  if (isSymbol(spec.key) && !spec.shift) return true
  return e.shiftKey === spec.shift
}

/** Typing in a field: single-key shortcuts ("?", "F2") must not fire there. */
export function isTypingTarget(t: { tagName?: string; isContentEditable?: boolean; type?: string } | null): boolean {
  if (!t || !t.tagName) return false
  if (t.isContentEditable) return true
  const tag = t.tagName.toLowerCase()
  if (tag === 'textarea' || tag === 'select') return true
  if (tag !== 'input') return false
  const type = (t.type ?? 'text').toLowerCase()
  return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(type)
}

/** Shortcuts with a modifier other than Shift are safe inside text fields; bare keys are not. */
export function hasCommandModifier(spec: ParsedSpec): boolean {
  return spec.mod || spec.ctrl || spec.alt || /^f\d{1,2}$/.test(spec.key)
}
