/**
 * Recalled copies of purged messages (07 B9, F16 second pass). Auto-recall, memory_search and memory_recall write the
 * records they found VERBATIM into the asking chat's wire transcript (a `memory_result` block of its user row, a
 * `tool_result` / text-mode `memory_result` of a tool row), and that transcript is replayed to the model for as long
 * as its epoch is current. When a message's content goes for good (a deleted message past its 30 days, or a chat
 * purged from the Trash), every such record of it is replaced by "(deleted)" — wherever it was recalled, without
 * relying on `memory_injections` (Forget removes those rows at once, and a temporary chat keeps its own).
 *
 * A record is what `memory/format.ts recordLine` renders: `[<when> · <age> · user response] <neutralised body>`, the
 * body clipped at 1200 characters ("…"), optionally followed on the next line by the `[Attached file "x": …]` line of
 * a file hit (rounds.ts). The record's prefix (time, who) stays; its body — and the attachment line — become
 * "(deleted)". A record is matched by the message's exact rendered body, so a different message that merely starts
 * the same way is left alone (two messages with identical text are both redacted).
 */
import type { WireBlock } from '@shared/types/wire'
import { neutralize } from '../format'

/** What a record's body becomes. Same text as a purged message's own wire turns. */
const DELETED = '(deleted)'
/** `clip()` in format.ts keeps 1199 characters + "…" past this length. */
const CLIP = 1199
const MAX = 1200
const ATTACHED = '[Attached file "'
/** The start of a record line as formatHits writes it (non-greedy: the body can't move the prefix's end). */
const RECORD_START = /^\[[^\n]*? · (?:user response|ai response \(you\))\] /gm
/** Records are looked up by this many leading characters of their body. */
const K = 24

/** One way a purged message can appear as a record body. */
export interface RecordKey {
  /** The neutralised body as rendered (the whole body when it fits, else its first 1199 characters). */
  full: string
  /** The rendered prefix every rendering of it starts with (equal to `full` unless the body is clipped). */
  prefix: string
  /** The record is the `[Attached file "…": …]` line alone (a message with files and no text). */
  attachmentOnly: boolean
}

function attachmentNames(json: string): string[] {
  try {
    const a = JSON.parse(json) as { name?: unknown }[]
    return Array.isArray(a) ? a.map((x) => (typeof x?.name === 'string' ? x.name : '')).filter(Boolean) : []
  } catch {
    return []
  }
}

/** The record keys of a message about to lose its content. */
export function recordKeys(body: string, attachmentsJson: string): RecordKey[] {
  const t = body.trim()
  if (t) {
    const prefix = neutralize(t.slice(0, CLIP))
    return [{ full: t.length <= MAX ? neutralize(t) : prefix, prefix, attachmentOnly: false }]
  }
  return attachmentNames(attachmentsJson).map((name) => {
    const k = neutralize(`${ATTACHED}${name.replace(/["\r\n]+/g, ' ')}": `)
    return { full: k, prefix: k, attachmentOnly: true }
  })
}

/** Finds record keys by the first characters of a record body. */
export class RecordIndex {
  private long = new Map<string, RecordKey[]>()
  private short = new Map<string, RecordKey[]>()
  private shortLengths = new Set<number>()
  size = 0

  add(k: RecordKey): void {
    if (!k.prefix) return
    this.size++
    if (k.prefix.length >= K) push(this.long, k.prefix.slice(0, K), k)
    else {
      push(this.short, k.prefix, k)
      this.shortLengths.add(k.prefix.length)
    }
  }

  candidates(text: string, at: number): RecordKey[] {
    const out = this.long.get(text.substr(at, K)) ?? []
    if (!this.shortLengths.size) return out
    const more: RecordKey[] = []
    for (const n of this.shortLengths) more.push(...(this.short.get(text.substr(at, n)) ?? []))
    return more.length ? [...out, ...more] : out
  }
}

function push(m: Map<string, RecordKey[]>, k: string, v: RecordKey): void {
  const a = m.get(k)
  if (a) a.push(v)
  else m.set(k, [v])
}

/** Where the record of `k` whose body starts at `at` ends, or -1 when the record there is not this message's. */
function recordEnd(text: string, at: number, k: RecordKey): number {
  if (k.attachmentOnly) {
    if (!text.startsWith(k.prefix, at)) return -1
    const nl = text.indexOf('\n', at)
    return nl < 0 ? text.length : nl
  }
  let j: number
  if (text.startsWith(k.full, at)) j = at + k.full.length
  else if (text.startsWith(k.prefix, at)) j = at + k.prefix.length
  else return -1
  if (text[j] === '…') return j + 1
  if (j === text.length) return j
  if (text[j] !== '\n') return -1
  // The file line of an attachment hit belongs to the record (its snippet quotes the file).
  if (text.startsWith(ATTACHED, j + 1)) {
    const nl = text.indexOf('\n', j + 1)
    return nl < 0 ? text.length : nl
  }
  // The record ends here only if what follows is the next record, the next conversation's header or the block's end
  // (else this is another message whose text merely starts with this one's).
  return text.startsWith('[', j + 1) || text.startsWith('— #', j + 1) || text.startsWith('</', j + 1) ? j : -1
}

/** `text` with every record of an indexed message reduced to its prefix + "(deleted)"; null when nothing matched. */
export function redactRecordsIn(text: string, index: RecordIndex): string | null {
  if (!index.size || !text.includes('] ')) return null
  const cuts: [number, number][] = []
  RECORD_START.lastIndex = 0
  for (let m = RECORD_START.exec(text); m; m = RECORD_START.exec(text)) {
    const at = m.index + m[0].length
    if (cuts.length && at < cuts[cuts.length - 1][1]) continue
    for (const k of index.candidates(text, at)) {
      const end = recordEnd(text, at, k)
      if (end >= 0) {
        cuts.push([at, end])
        break
      }
    }
  }
  if (!cuts.length) return null
  let out = ''
  let from = 0
  for (const [a, b] of cuts) {
    out += text.slice(from, a) + DELETED
    from = b
  }
  return out + text.slice(from)
}

/** The blocks with recalled records of indexed messages redacted; null when nothing changed. */
export function redactRecalledBlocks(blocks: WireBlock[], index: RecordIndex): WireBlock[] | null {
  let changed = false
  const out = blocks.map((b): WireBlock => {
    if (b.t !== 'memory_result' && b.t !== 'tool_result') return b
    const text = redactRecordsIn(b.text, index)
    if (text === null) return b
    changed = true
    return { ...b, text }
  })
  return changed ? out : null
}
