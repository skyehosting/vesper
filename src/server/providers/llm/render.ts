/**
 * Rendering rules both adapters share (07 C7/C8): how a system_note, an attachment without native support, and a tool
 * call in text mode look on the wire. Every function is pure, so the same canonical blocks always give the same bytes.
 */
import { createHash } from 'node:crypto'
import { MEMORY_FUNCTIONS } from '@shared/memoryFunctions'
import type { WireBlock } from '@shared/types/wire'
import { untrusted } from '../../chat/untrusted'
import type { AttachmentSource } from './types'

/** A system_note rendered as user-turn text (providers/models without mid-conversation system messages). */
export function noteAsText(text: string): string {
  return `(Note from Vesper, not from the user: ${text})`
}

/** `[memory_search query="…" scope="all"]` — declared parameter order first, then anything else sorted. */
export function bracketCall(name: string, input: Record<string, unknown>): string {
  const def = MEMORY_FUNCTIONS.find((f) => f.name === name)
  const order = def ? def.params.map((p) => p.name) : []
  const keys = [...order.filter((k) => input[k] !== undefined), ...Object.keys(input).filter((k) => !order.includes(k)).sort()]
  const attrs = keys.map((k) => ` ${k}="${String(input[k]).replace(/"/g, "'").replace(/\]/g, ')')}"`).join('')
  return `[${name}${attrs}]`
}

export function imagePlaceholder(b: Extract<WireBlock, { t: 'image' }>): string {
  return `[image: ${b.name}, ${b.width}×${b.height}]`
}

/** Attachment text as untrusted, quoted material (07 B7/C8). */
export function fileText(b: Extract<WireBlock, { t: 'file_text' }>, att: AttachmentSource): string {
  const text = att.text(b.sha)
  if (text === null) return `[file: ${b.name} — its text is not available]`
  return untrusted('file', att.boundary(b.sha), text, { name: b.name })
}

/** Mistral accepts only 9-character [a-zA-Z0-9] tool ids (research 01 §2.4): a stable remap. */
export function mistralId(id: string): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  let n = BigInt(`0x${createHash('sha256').update(id).digest('hex')}`)
  let out = ''
  while (out.length < 9) {
    out += alphabet[Number(n % 62n)]
    n /= 62n
  }
  return out
}

/** Anthropic models that accept `{role:'system'}` mid-conversation (research 01 §2.2; not Sonnet 5). */
export function anthropicSystemRole(model: string): boolean {
  return /^claude-(opus-5|opus-4-8|fable-5|mythos-5|sonnet-5-5)/.test(model)
}

/** Anthropic models with adaptive thinking + effort (thinking cannot be disabled on Opus 5.5, research 01 §2.2). */
export function anthropicAdaptive(model: string): boolean {
  return /^claude-(opus|sonnet|fable|mythos)-(5|4-[6-9])/.test(model)
}

export function sha16(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}
