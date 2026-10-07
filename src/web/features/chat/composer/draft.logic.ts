/**
 * Composer drafts per session, per device (pure storage rules; draft.ts wires them to the app's events).
 *
 * Ordinary chats keep their draft in localStorage (failures are ignored — private mode, quota). A temporary chat's
 * draft lives in memory only, for this tab, and is never written anywhere (07 B9: temporary = in-memory only; the UI
 * says "Kept in memory only — never saved"); while a chat's kind is not known yet the draft also stays in memory.
 * A draft is removed when its chat is deleted or ends (`session.deleted`/`session.ended`, wherever that happened),
 * and drafts of chats that no longer exist are swept once per start (F09/F17). Signing out (or the device being
 * revoked or expiring) removes every draft on this device.
 *
 * A clear must win over the save that follows it: when the chat is open, `session.deleted` clears its draft first and
 * the Composer unmounts afterwards and saves what it still holds. So a cleared chat is marked, and saves for it are
 * ignored until a composer opens it again (`loadDraft`: e.g. restored from Trash). `clearAllDrafts` marks every chat a
 * composer opened on this page the same way, so the composers still on screen when signing out save nothing.
 */
const PREFIX = 'vesper.draft.'
const MAX_CHARS = 100_000

/** In-memory drafts: temporary chats, and chats whose kind is still unknown. */
const memory = new Map<string, string>()

/** Chats whose draft was cleared (deleted/ended): their saves are ignored until a composer loads them again. */
const cleared = new Set<string>()
/** Chats a composer opened on this page (what `clearAllDrafts` must mark). */
const opened = new Set<string>()

/** `true` = temporary (memory only), `false` = ordinary (localStorage), `null` = not known yet (memory for now). */
export type DraftKind = boolean | null

/** The browser's localStorage (typed minimally: this module is also unit-tested in node). */
interface KeyStore {
  readonly length: number
  key(i: number): string | null
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
}

/** Throws when storage is unavailable (private mode, blocked site data): every caller catches. */
function store(): KeyStore {
  const ls = (globalThis as { localStorage?: KeyStore }).localStorage
  if (!ls) throw new Error('no localStorage')
  return ls
}

function removeStored(sessionUid: string): void {
  try {
    store().removeItem(PREFIX + sessionUid)
  } catch {
    // storage unavailable
  }
}

export function loadDraft(sessionUid: string, temporary: DraftKind = false): string {
  // A composer opening this chat starts a new life for its draft.
  cleared.delete(sessionUid)
  opened.add(sessionUid)
  const held = memory.get(sessionUid)
  if (held !== undefined || temporary === true) return held ?? ''
  try {
    return store().getItem(PREFIX + sessionUid) ?? ''
  } catch {
    return ''
  }
}

export function saveDraft(sessionUid: string, text: string, temporary: DraftKind = false): void {
  if (cleared.has(sessionUid)) return
  const keep = text.trim() ? text.slice(0, MAX_CHARS) : ''
  if (temporary !== false) {
    if (keep) memory.set(sessionUid, keep)
    else memory.delete(sessionUid)
    // A temporary chat never has a stored draft (one left by an older version is removed here).
    if (temporary === true) removeStored(sessionUid)
    return
  }
  memory.delete(sessionUid)
  try {
    if (keep) store().setItem(PREFIX + sessionUid, keep)
    else store().removeItem(PREFIX + sessionUid)
  } catch {
    // storage unavailable: the draft lives only while the page is open
  }
}

/** Forget a chat's draft everywhere (the chat was deleted or ended). */
export function clearDraft(sessionUid: string): void {
  cleared.add(sessionUid)
  memory.delete(sessionUid)
  removeStored(sessionUid)
}

/** Forget every draft on this device (signed out, or the device was revoked or expired): storage and memory. */
export function clearAllDrafts(): void {
  for (const uid of [...opened, ...memory.keys(), ...storedDraftUids()]) clearDraft(uid)
  opened.clear()
}

/** Session uids that have a stored draft on this device. */
export function storedDraftUids(): string[] {
  try {
    const out: string[] = []
    const ls = store()
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i)
      if (k?.startsWith(PREFIX)) out.push(k.slice(PREFIX.length))
    }
    return out
  } catch {
    return []
  }
}

/**
 * Remove stored drafts whose chat is gone (deleted or purged while this device was away) or temporary (a draft an
 * older version wrote). `listChats` returns every stored chat of the list (uid → temporary), or null when it could not
 * (network trouble, too many to page through): then nothing is removed.
 */
export async function sweepDrafts(listChats: () => Promise<Map<string, boolean> | null>): Promise<number> {
  const stored = storedDraftUids()
  if (stored.length === 0) return 0
  const chats = await listChats()
  if (!chats) return 0
  let removed = 0
  for (const uid of stored) {
    if (chats.get(uid) === false) continue
    removeStored(uid)
    removed++
  }
  return removed
}
