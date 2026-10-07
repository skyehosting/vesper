/**
 * Scope clamp (07 B7/B9, research 02 §5.3 step 1). Whatever a tool call or the UI asks for, the sessions searched are
 * clamped in code to what the session may access:
 *   max scope = the session's memory_scope (inherit → settings.memory.scopeDefault); requested ≤ max;
 *   this   → the session itself;
 *   linked → itself + its outgoing links (not transitive, 07 C18);
 *   all    → every session that is not private, deleted or memory-off.
 * A private session searches only itself and never reaches Voyage; a temporary session (not in SQLite) never has
 * itself in scope and never reaches Voyage; memory off for the session refuses. The global switch
 * (`settings.memory.enabled`) is the Voyage switch: without it everything still works by keywords on this PC (F37);
 * it only decides `voyage`.
 */
import type { MemoryScope } from '@shared/types/domain'
import { isValidZoneName, zoneOf, type Zone } from '@shared/time'
import type { SessionRow } from '../db/repos'
import { id as bindId } from '../db/sqlite'
import type { ScopeCtx, ServerContext } from '../services'

const ORDER: Record<MemoryScope, number> = { this: 0, linked: 1, all: 2 }

export interface ResolvedScope {
  /** null = a temporary (in-memory) session or one we don't know. */
  session: SessionRow | null
  scope: MemoryScope
  /** Session ids that may be searched (numbers for the worker). */
  sessionIds: number[]
  /** May query/rerank text go to Voyage (07 B9)? */
  voyage: boolean
  /** Fixed refusal text when memory can't be used at all. */
  refused?: string
}

export const REFUSALS = {
  disabled: 'Memory is turned off.',
  sessionOff: 'Memory is turned off for this conversation.',
  unknownSession: (s: string) => `There is no conversation #${s}.`,
  notLinked: (s: string) => `Conversation #${s} is not linked to this one. Ask the user to link it with /link #${s}.`,
  privateSession: (s: string) => `Conversation #${s} is private and can't be recalled from here.`,
  /** The target is linked (or open) but its own memory switch is off: linking again would change nothing. */
  targetOff: (s: string) => `Memory is turned off for conversation #${s}, so it can't be recalled.`,
  /** The asking chat's scope is 'this' (narrowed, or private): links don't reach past it. */
  scopeThis: (s: string) => `This conversation's memory is limited to itself, so it can't recall #${s}. The user can widen it in this chat's memory settings.`,
  /** A temporary chat has no links; it reaches other chats only when the memory scope default is 'all'. */
  temporaryScope: (s: string) => `This temporary chat can't recall #${s}: its memory doesn't reach other conversations.`
} as const

export function minScope(a: MemoryScope, b: MemoryScope): MemoryScope {
  return ORDER[a] <= ORDER[b] ? a : b
}

/** The session's own ceiling. */
export function maxScopeOf(s: SessionRow | null, ctx: ServerContext): MemoryScope {
  const def = ctx.settings.get().memory.scopeDefault
  if (!s) return def
  if (s.private) return 'this'
  return s.memoryScope === 'inherit' ? def : s.memoryScope
}

/** Every session another session may recall when the scope is 'all'. */
function openSessionIds(ctx: ServerContext): number[] {
  return (ctx.db.prepare("SELECT id FROM sessions WHERE deleted_utc IS NULL AND private = 0 AND memory <> 'off'").all() as { id: number | bigint }[]).map((r) => Number(r.id))
}

export function resolveScope(ctx: ServerContext, sc: ScopeCtx, o: { hasKey: boolean }): ResolvedScope {
  const settings = ctx.settings.get().memory
  const s = ctx.repos.sessions.byUid(sc.sessionUid)
  const session = s && s.deletedUtc === null ? s : null
  const max = maxScopeOf(session, ctx)
  const scope = sc.requested ? minScope(sc.requested, max) : max
  const base: ResolvedScope = { session, scope, sessionIds: [], voyage: false }
  if (session && session.memory === 'off') return { ...base, refused: REFUSALS.sessionOff }
  let ids: number[]
  if (!session) {
    // Temporary chat: never itself (it is not stored), never linked (it has no links).
    ids = scope === 'all' ? openSessionIds(ctx) : []
  } else if (scope === 'this') {
    ids = [Number(session.id)]
  } else if (scope === 'linked') {
    ids = [Number(session.id), ...ctx.repos.sessions.links(session.id).filter((l) => !l.private && l.memory !== 'off').map((l) => Number(l.id))]
  } else {
    ids = openSessionIds(ctx)
    if (!ids.includes(Number(session.id))) ids.push(Number(session.id))
  }
  const voyage = !!session && !session.private && settings.enabled && o.hasKey
  return { ...base, sessionIds: [...new Set(ids)], voyage }
}

/**
 * The zone a session's dates are read in: its newest message's sender zone (07 C2), else the profile's zone, else UTC.
 */
export function zoneForSession(ctx: ServerContext, s: SessionRow | null): Zone {
  if (s) {
    const r = ctx.db.prepare('SELECT tz_name, tz_offset_min FROM messages WHERE session_id = ? AND on_path = 1 ORDER BY seq DESC LIMIT 1').get(bindId(s.id)) as
      | { tz_name: string | null; tz_offset_min: number }
      | undefined
    if (r) return zoneOf(r.tz_name, Number(r.tz_offset_min))
  }
  const pref = ctx.settings.get().profile.timeZone
  return isValidZoneName(pref) ? zoneOf(pref, 0) : zoneOf('UTC', 0)
}

/** UTC ms of local midnight starting `y-m-d` in `zone` (DST-safe: re-check the offset at the guess). */
export function localMidnightUtc(y: number, m: number, d: number, zone: Zone): number {
  const naive = Date.UTC(y, m - 1, d)
  let t = naive - zone.partsAt(naive).offsetMin * 60_000
  t = naive - zone.partsAt(t).offsetMin * 60_000
  return t
}

/**
 * `after` / `before` from a tool call: "YYYY-MM-DD" (a local calendar day in `zone`; after = from its start, before =
 * until its start) or a full ISO timestamp. Unparseable values are ignored.
 */
export function parseBound(v: string | undefined, zone: Zone): number | null {
  if (!v) return null
  const s = v.trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (m) return localMidnightUtc(Number(m[1]), Number(m[2]), Number(m[3]), zone)
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const t = Date.parse(s)
    return Number.isFinite(t) ? t : null
  }
  return null
}
