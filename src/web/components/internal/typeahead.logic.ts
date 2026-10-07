/**
 * Typeahead for menus and listboxes (APG): typing characters moves to the next item whose label starts with them.
 * Keys typed within `timeoutMs` of each other form one search string; repeating a single character cycles through
 * the items that start with it ("r", "r" → Rose, then Rust). Case- and accent-insensitive.
 */

export interface TypeaheadState {
  buffer: string
  lastAt: number
}

export const TYPEAHEAD_TIMEOUT_MS = 500

export const emptyTypeahead = (): TypeaheadState => ({ buffer: '', lastAt: 0 })

/** Lower-case, strip diacritics, collapse leading whitespace — the form labels are compared in. */
export function foldLabel(s: string): string {
  return s.normalize('NFD').replace(/\p{Mn}+/gu, '').toLowerCase().trimStart()
}

/** Is `key` (KeyboardEvent.key) a printable character that should feed typeahead? */
export function isTypeaheadKey(key: string, mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}): boolean {
  return key.length === 1 && !mods.ctrlKey && !mods.metaKey && !mods.altKey && key !== ' '
}

/**
 * Feed one key. Returns the new state and the matched index (null when nothing matches; the caller keeps the current
 * item). `current` is the active index (-1 for none).
 */
export function typeahead(
  state: TypeaheadState,
  key: string,
  now: number,
  labels: readonly string[],
  current: number,
  isDisabled?: (i: number) => boolean,
  timeoutMs = TYPEAHEAD_TIMEOUT_MS
): { state: TypeaheadState; index: number | null } {
  const ch = foldLabel(key)
  const buffer = (now - state.lastAt > timeoutMs ? '' : state.buffer) + ch
  const next: TypeaheadState = { buffer, lastAt: now }
  const n = labels.length
  if (n === 0 || ch === '') return { state: next, index: null }

  const folded = labels.map(foldLabel)
  const repeated = buffer.length > 1 && [...buffer].every((c) => c === ch)
  // A single (or repeated) character searches from the item after the current one, so pressing it again cycles;
  // a longer string searches from the current item, so "ro" keeps "Rose" while extending "r".
  const search = repeated ? ch : buffer
  const start = repeated || buffer.length === 1 ? current + 1 : Math.max(current, 0)
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n
    if (!isDisabled?.(i) && folded[i].startsWith(search)) return { state: next, index: i }
  }
  return { state: next, index: null }
}
