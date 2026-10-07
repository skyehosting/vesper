/**
 * The untrusted-content renderer for what the engine itself wraps — attachment text and recaps (07 B7). Memory results
 * are rendered by MemoryService.formatResult with the same rules. Escapes `<`/`>`, neutralises `[memory_` / `[tone=`
 * with a word-joiner so quoted text can never become a control tag, and wraps the text in a boundary the author of the
 * text cannot predict.
 */
import { createHmac, randomBytes } from 'node:crypto'

import { neutralizeControlTags } from '@shared/tags'

/** Escapes `<`/`>` and neutralises every form of control tag the TagFilter accepts (F22: any casing, `=`/`:`). */
export function neutralize(text: string): string {
  return neutralizeControlTags(text.replace(/</g, '&lt;').replace(/>/g, '&gt;'))
}

export function untrusted(kind: 'file' | 'recap' | 'memory_result', boundary: string, text: string, attrs: Record<string, string> = {}): string {
  const extra = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${v.replace(/["<>\n]/g, ' ')}"`)
    .join('')
  return `<${kind} id="${boundary}"${extra}>\n${neutralize(text)}\n</${kind} id="${boundary}">`
}

/** A fresh random boundary (persisted inside the block that uses it). */
export function newBoundary(): string {
  return `r_${randomBytes(4).toString('hex')}`
}

/**
 * Deterministic boundary for content referenced (not copied) by a block, e.g. attachment text: an HMAC of the
 * reference under a per-install secret, so replays render the same bytes and a document's author cannot guess it.
 */
export function derivedBoundary(secret: string, ref: string): string {
  return `r_${createHmac('sha256', secret).update(ref).digest('hex').slice(0, 8)}`
}
