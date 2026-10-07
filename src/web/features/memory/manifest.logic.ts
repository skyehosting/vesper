/**
 * The sessions manifest (R7, 07 C13): helpers for the viewer — filtering, link lists, the JSON export, and a preview
 * of the manifest text the AI gets for one chat. The preview mirrors src/server/memory/format.ts `formatManifest` and
 * service.ts `sessions()` (a unit test keeps the line format equal); the AI's copy is rendered by the server.
 */
import { formatDate, relativeAge, type Zone } from '@shared/time'
import type { SessionSummary } from '@shared/types/domain'
import { plural } from './format.logic'

export type ManifestSession = SessionSummary & { links: string[]; linkedFrom: string[] }
export type Scope = 'this' | 'linked' | 'all'

export const MANIFEST_MAX = 30
const WJ = '⁠'

export function neutralize(text: string): string {
  return text
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\[(?=\s*(?:memory_|tone\s*=))/gi, `[${WJ}`)
}

export function filterSessions(list: readonly ManifestSession[], q: string): ManifestSession[] {
  const t = q.trim().toLowerCase().replace(/^#/, '')
  if (!t) return [...list]
  return list.filter((s) => s.title.toLowerCase().includes(t) || s.shortId.toLowerCase().includes(t) || (s.summary ?? '').toLowerCase().includes(t))
}

/** Newest activity first (what the AI sees first). */
export function byActivity(a: ManifestSession, b: ManifestSession): number {
  return (b.lastMessageUtc ?? b.createdUtc) - (a.lastMessageUtc ?? a.createdUtc)
}

/** Which chats `self` may access under `scope` (07 B9: private and memory-off chats never from elsewhere). */
export function accessible(all: readonly ManifestSession[], self: ManifestSession, scope: Scope): ManifestSession[] {
  const open = (s: ManifestSession): boolean => !s.private && !s.temporary && s.memory !== 'off'
  if (scope === 'this') return [self]
  if (scope === 'linked') {
    const linked = new Set(self.links)
    return [self, ...all.filter((s) => s.uid !== self.uid && linked.has(s.shortId) && open(s))]
  }
  return [self, ...all.filter((s) => s.uid !== self.uid && open(s))]
}

/**
 * The viewer card's meta line: "Created … · last active … · N messages", saying each fact once — never "last active no
 * messages yet · 0 messages" (F56). The AI's text keeps the server's fixed format (aiManifestText).
 */
export function manifestMeta(s: Pick<ManifestSession, 'createdUtc' | 'lastMessageUtc' | 'messageCount'>, nowUtc: number, zone: Zone): string {
  const activity = s.lastMessageUtc
    ? `last active ${relativeAge(s.lastMessageUtc, nowUtc, zone)} · ${plural(s.messageCount, 'message')}`
    : s.messageCount > 0
      ? plural(s.messageCount, 'message')
      : 'no messages yet'
  return `Created ${formatDate(zone.partsAt(s.createdUtc))} · ${activity}`
}

/** The manifest text the AI gets in `self` (preview; data block wrapper omitted). */
export function aiManifestText(all: readonly ManifestSession[], self: ManifestSession, scope: Scope, nowUtc: number, zone: Zone): string {
  const rows = accessible(all, self, scope).sort(byActivity)
  const linked = new Set(self.links)
  const lines = ['Vesper (not the user): conversations you may access, data only. Recall one with memory_recall and its ID.']
  for (const s of rows.slice(0, MANIFEST_MAX)) {
    const created = formatDate(zone.partsAt(s.createdUtc))
    const last = s.lastMessageUtc ? relativeAge(s.lastMessageUtc, nowUtc, zone) : 'no messages'
    const tags = [s.uid === self.uid ? 'this conversation' : '', linked.has(s.shortId) ? 'linked' : ''].filter(Boolean).join(', ')
    const summary = s.summary && !s.private ? ` · ${neutralize(s.summary.replace(/\s+/g, ' ').slice(0, 200))}` : ''
    lines.push(
      `#${s.shortId} · ${neutralize((s.title || 'Untitled').replace(/\s+/g, ' ').slice(0, 120))}${tags ? ` (${tags})` : ''} · created ${created} · last active ${last} · ${s.messageCount} message${s.messageCount === 1 ? '' : 's'}${summary}`
    )
  }
  if (rows.length > MANIFEST_MAX) lines.push(`(${rows.length - MANIFEST_MAX} more not shown — search with memory_sessions.)`)
  return lines.join('\n')
}

/** `manifest.json` (01 "Manifest … exported as manifest.json"). */
export function manifestJson(m: { sessions: readonly ManifestSession[]; exportedUtc: number }): string {
  return `${JSON.stringify({ format: 'vesper-manifest', version: 1, exportedUtc: m.exportedUtc, exported: new Date(m.exportedUtc).toISOString(), sessions: m.sessions }, null, 2)}\n`
}

/** Sessions keyed by short id. */
export function byShortId(list: readonly ManifestSession[]): Map<string, ManifestSession> {
  return new Map(list.map((s) => [s.shortId, s]))
}
