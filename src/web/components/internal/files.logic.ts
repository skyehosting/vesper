/**
 * File intake rules for FileDrop and paste targets (R18, 07 B6/C8): match `accept` the way <input accept> does
 * (MIME types, `type/*` wildcards, `.ext` suffixes), enforce count and size caps, and say why a file was refused so the
 * UI can tell the user. The server re-validates everything; this is for immediate feedback.
 */

export interface FileLike {
  name: string
  type: string
  size: number
}

export type RejectReason = 'type' | 'size' | 'count' | 'empty'

export interface Rejected<F extends FileLike = FileLike> {
  file: F
  reason: RejectReason
}

export interface IntakeRules {
  /** Same syntax as <input accept>; empty/undefined accepts everything. */
  accept?: string
  /** Per-file byte cap. */
  maxBytes?: number
  /** Max files per drop/paste (07 B6: ≤ 10 per message). */
  maxFiles?: number
  /** Reject 0-byte files (folders dragged from Explorer arrive as empty entries). */
  rejectEmpty?: boolean
}

export function matchesAccept(file: Pick<FileLike, 'name' | 'type'>, accept: string | undefined): boolean {
  if (!accept || !accept.trim()) return true
  const name = file.name.toLowerCase()
  const type = (file.type || '').toLowerCase()
  return accept
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) => {
      if (rule.startsWith('.')) return name.endsWith(rule)
      if (rule.endsWith('/*')) return type.startsWith(rule.slice(0, -1))
      return type === rule
    })
}

export function partitionFiles<F extends FileLike>(files: readonly F[], rules: IntakeRules): { accepted: F[]; rejected: Rejected<F>[] } {
  const accepted: F[] = []
  const rejected: Rejected<F>[] = []
  for (const file of files) {
    if (rules.rejectEmpty !== false && file.size === 0 && !file.type) rejected.push({ file, reason: 'empty' })
    else if (!matchesAccept(file, rules.accept)) rejected.push({ file, reason: 'type' })
    else if (rules.maxBytes !== undefined && file.size > rules.maxBytes) rejected.push({ file, reason: 'size' })
    else if (rules.maxFiles !== undefined && accepted.length >= rules.maxFiles) rejected.push({ file, reason: 'count' })
    else accepted.push(file)
  }
  return { accepted, rejected }
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** "980 B", "1.2 KB", "25 MB", "1.07 GB" — decimal (SI) units, the way providers and model catalogues state sizes. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1000) return `${Math.round(n)} B`
  let u = 0
  let v = n
  while (v >= 1000 && u < UNITS.length - 1) {
    v /= 1000
    u++
  }
  const places = v >= 100 ? 0 : v >= 10 ? 1 : u >= 3 ? 2 : 1
  return `${Number(v.toFixed(places))} ${UNITS[u]}`
}

export function rejectMessage(r: Rejected, rules: IntakeRules): string {
  switch (r.reason) {
    case 'type':
      return `${r.file.name}: this file type isn't supported.`
    case 'size':
      return `${r.file.name} is larger than ${formatBytes(rules.maxBytes ?? 0)}.`
    case 'count':
      return `Only ${rules.maxFiles} files can be attached at once.`
    case 'empty':
      return `${r.file.name || 'That item'} is empty or a folder.`
  }
}
