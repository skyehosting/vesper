/**
 * Pure helpers behind the settings store and Settings' instant save (07 D12): dotted paths into the settings object,
 * the optimistic overlay (what the user changed but the server has not confirmed yet), PATCH bodies, field-error
 * mapping. No DOM, no React, no zod (the store is in the initial bundle): unit-tested directly.
 */
import type { Settings } from '@shared/settings'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

// ── typed paths ───────────────────────────────────────────────────────────────────────────────
type Primitive = string | number | boolean | null | undefined
/** Leaves: primitives, arrays and records (an index signature) — they are replaced as a whole. */
type IsLeaf<T> = [T] extends [Primitive] ? true : T extends readonly unknown[] ? true : string extends keyof T ? true : false
type Join<K, P> = K extends string ? (P extends string ? `${K}.${P}` : never) : never
/** Dotted paths of every object node and leaf. */
export type PathsOf<T> =
  IsLeaf<T> extends true
    ? never
    : T extends object
      ? { [K in keyof T & string]: IsLeaf<NonNullable<T[K]>> extends true ? K : K | Join<K, PathsOf<NonNullable<T[K]>>> }[keyof T & string]
      : never
export type ValueAt<T, P extends string> = P extends `${infer K}.${infer R}`
  ? K extends keyof T
    ? ValueAt<NonNullable<T[K]>, R> | (undefined extends T[K] ? undefined : never)
    : never
  : P extends keyof T
    ? T[P]
    : never

export type SettingPath = PathsOf<Settings>
/** Optimistic changes not yet confirmed by the server: dotted path → value. */
export type Overlay = Readonly<Record<string, unknown>>

// ── reading and writing paths ─────────────────────────────────────────────────────────────────
export function getAt(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const k of path.split('.')) {
    if (Array.isArray(cur) && /^\d+$/.test(k)) cur = cur[Number(k)]
    else if (isObj(cur)) cur = cur[k]
    else return undefined
  }
  return cur
}

/** A copy of `obj` with `value` at `path` (only the containers on the path are copied). */
export function setAt<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split('.')
  const rec = (cur: unknown, i: number): unknown => {
    if (i === keys.length) return value
    const k = keys[i]
    if (Array.isArray(cur) && /^\d+$/.test(k)) {
      const copy = cur.slice()
      copy[Number(k)] = rec(cur[Number(k)], i + 1)
      return copy
    }
    const base: Obj = isObj(cur) ? cur : {}
    return { ...base, [k]: rec(base[k], i + 1) }
  }
  return rec(obj, 0) as T
}

/** Server truth with the optimistic overlay applied on top (later paths win). */
export function applyOverlay<T>(server: T, overlay: Overlay): T {
  let out = server
  for (const [p, v] of Object.entries(overlay)) out = setAt(out, p, v)
  return out
}

/** Nested PATCH body from dotted paths: {'chat.pageSize': 120} → {chat: {pageSize: 120}}. */
export function toPatch(changes: Overlay): Obj {
  let body: Obj = {}
  for (const [p, v] of Object.entries(changes)) body = setAt(body, p, v)
  return body
}

/** Drop overlay entries that the server has now confirmed (same path, value unchanged since it was sent). */
export function settleOverlay(overlay: Overlay, sent: Overlay): Obj {
  const out: Obj = {}
  for (const [p, v] of Object.entries(overlay)) if (!(p in sent) || sent[p] !== v) out[p] = v
  return out
}

/**
 * Field errors for the paths of a failed PATCH. The server names fields by their dotted path, sometimes deeper than
 * the path we sent ('llm.profiles.0.baseUrl' for a 'llm.profiles' change); those keep their own key. A path with no
 * field error of its own gets the general message, so every reverted control says why.
 */
export function fieldErrorsFor(sent: readonly string[], message: string, fields: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  const f = fields ?? {}
  for (const p of sent) {
    let matched = false
    for (const [k, v] of Object.entries(f)) {
      if (k === p || k.startsWith(`${p}.`) || p.startsWith(`${k}.`)) {
        out[k] = friendlyFieldError(v)
        matched = true
      }
    }
    if (!matched) out[p] = message
  }
  return out
}

function friendlyFieldError(v: string): string {
  return v === 'desktop only' ? 'Change this in the Vesper app on your PC.' : v
}

/** Settings paths whose change restyles the page at once (theme, accent, motion, message size). */
export function isAppearancePath(path: string): boolean {
  return path === 'appearance' || path.startsWith('appearance.') || path === 'chat.fontSize' || path === 'chat'
}

/** Paths whose change may move a provider key to another origin (07 B1): the saved-key list must be re-read. */
export function movesKeys(path: string): boolean {
  return path === 'llm' || path === 'llm.profiles' || path.startsWith('memory.voyage') || path === 'voice.tts.baseUrl' || path === 'memory' || path === 'voice' || path === 'voice.tts'
}

/**
 * Whether a bootstrap in the store is one the server just sent (sign-in, reconnect, re-login) — the only time the live
 * memory/game-mode status is seeded from it (P01/P16). The store also holds local spread copies of the same bootstrap
 * (a settings answer, a saved secret, a health change); they keep the fetched `memory` object, whose value is the one
 * at fetch time and is stale once `memory.progress` moved on. A fetched bootstrap is parsed from JSON, so its `memory`
 * (a required field) is always a new object.
 */
export function isFreshBootstrap(seenMemory: object | null, b: { memory: object }): boolean {
  return b.memory !== seenMemory
}
