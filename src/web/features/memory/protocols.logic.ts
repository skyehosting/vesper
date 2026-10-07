/**
 * Protocols editor logic (R9, 07 C1), pure and unit-tested:
 *   - `validateProtocols` mirrors src/server/protocols/protocols.ts so warnings show while typing (the server's copy
 *     stays authoritative and its warnings are shown after saving; a test asserts both agree on fixtures);
 *   - `lineDiff` / `diffHunks`: a line diff against the shipped default (LCS) folded into hunks with context.
 */

export const PROTOCOL_PLACEHOLDERS = [
  'assistant_name',
  'user_name',
  'session_id',
  'tones',
  'tone_instruction',
  'native_function_docs',
  'text_function_docs'
] as const
export const PROTOCOL_BLOCKS = ['native_mode', 'text_mode'] as const
export const MAX_PROTOCOLS_CHARS = 200_000

/** What each placeholder becomes (shown in the editor's reference). */
export const PLACEHOLDER_HELP: { token: string; text: string }[] = [
  { token: '{{assistant_name}}', text: 'The assistant’s name from Settings (Vesper).' },
  { token: '{{user_name}}', text: 'Your name from Settings.' },
  { token: '{{session_id}}', text: 'This chat’s ID, like #K7Q2MX.' },
  { token: '{{tones}}', text: 'Suggested tone words (warm, calm, playful…). {{tone_instruction}} already lists them.' },
  {
    token: '{{tone_instruction}}',
    text: 'When the AI tags its voice tone ([tone=…]), from Settings → Voice out → Voice tones: only when the conversation’s mood shifts (default), every reply, or never — and “Do not write tone tags.” when the voice can’t use a tone. A change mid-chat reaches the AI as a note.'
  },
  { token: '{{native_function_docs}}', text: 'Generated docs of the memory tools (models with native tools).' },
  { token: '{{text_function_docs}}', text: 'Generated docs of [memory_search] and [memory_recall] (text mode).' }
]

export const BLOCK_HELP: { token: string; text: string }[] = [
  { token: '{{#native_mode}}…{{/native_mode}}', text: 'Kept only when the model calls tools natively.' },
  { token: '{{#text_mode}}…{{/text_mode}}', text: 'Kept only when the model writes bracket functions as text.' }
]

const isPlaceholder = (n: string): boolean => (PROTOCOL_PLACEHOLDERS as readonly string[]).includes(n)
const isBlock = (n: string): boolean => (PROTOCOL_BLOCKS as readonly string[]).includes(n)

export function validateProtocols(text: string): string[] {
  const warnings: string[] = []
  const add = (w: string): void => {
    if (!warnings.includes(w)) warnings.push(w)
  }
  const stack: string[] = []
  const docsIn = { native: false, text: false }
  const tokenRe = /\{\{([^{}]*)\}\}/g
  let m: RegExpExecArray | null
  while ((m = tokenRe.exec(text))) {
    const inner = m[1].trim()
    if (inner.startsWith('#') || inner.startsWith('/')) {
      const name = inner.slice(1).trim()
      if (!isBlock(name)) {
        add(`Unknown block {{${inner}}}: only {{#native_mode}}…{{/native_mode}} and {{#text_mode}}…{{/text_mode}} exist.`)
        continue
      }
      if (inner.startsWith('#')) {
        if (stack.length) add(`{{#${name}}} is inside {{#${stack[stack.length - 1]}}}; mode blocks can't be nested.`)
        stack.push(name)
      } else if (stack[stack.length - 1] === name) stack.pop()
      else add(`{{/${name}}} closes a block that isn't open.`)
      continue
    }
    if (!isPlaceholder(inner)) {
      add(`Unknown placeholder {{${inner}}}: it will be sent to the AI exactly as written.`)
      continue
    }
    if (inner === 'native_function_docs' && !stack.includes('text_mode')) docsIn.native = true
    if (inner === 'text_function_docs' && !stack.includes('native_mode')) docsIn.text = true
  }
  for (const open of stack) add(`{{#${open}}} is never closed with {{/${open}}}.`)

  const withoutTokens = text.replace(tokenRe, '')
  if (withoutTokens.includes('{{') || withoutTokens.includes('}}')) add('A {{ or }} has no partner, so a placeholder is broken.')
  const single = /(?<!\{)\{\s*(assistant_name|user_name|session_id|tones|tone_instruction|native_function_docs|text_function_docs)\s*\}(?!\})/.exec(
    withoutTokens
  )
  if (single) add(`{${single[1]}} needs double braces: {{${single[1]}}}.`)

  const mentions = /memory_search/.test(withoutTokens) && /memory_recall/.test(withoutTokens)
  if (!docsIn.text && !mentions)
    add('[memory_search] and [memory_recall] are not documented for text mode: add {{text_function_docs}} inside {{#text_mode}}…{{/text_mode}}.')
  if (!docsIn.native && !mentions)
    add('The memory tools are not described for native mode: add {{native_function_docs}} inside {{#native_mode}}…{{/native_mode}}.')
  if (!/\{\{\s*tone_instruction\s*\}\}/.test(text)) add('{{tone_instruction}} is missing, so the AI is not told how to tag its tone for the voice.')
  return warnings
}

// ── diff ──────────────────────────────────────────────────────────────────────────────────────
export type DiffOp = { t: 'same' | 'del' | 'add'; text: string; a?: number; b?: number }

/** Above this many cells the LCS table is skipped (the texts are too far apart to diff usefully). */
const MAX_CELLS = 4_000_000

export function splitLines(s: string): string[] {
  const t = s.replace(/\r\n/g, '\n')
  return t === '' ? [] : t.split('\n')
}

/** Line diff of `a` → `b` (LCS). Returns null when the inputs are too large to diff. Line numbers are 1-based. */
export function lineDiff(a: string, b: string): DiffOp[] | null {
  const A = splitLines(a)
  const B = splitLines(b)
  // Trim the common head and tail first: edits are usually local.
  let head = 0
  while (head < A.length && head < B.length && A[head] === B[head]) head++
  let tail = 0
  while (tail < A.length - head && tail < B.length - head && A[A.length - 1 - tail] === B[B.length - 1 - tail]) tail++
  const a2 = A.slice(head, A.length - tail)
  const b2 = B.slice(head, B.length - tail)
  const n = a2.length
  const m = b2.length
  if ((n + 1) * (m + 1) > MAX_CELLS) return null
  const w = m + 1
  const L = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) L[i * w + j] = a2[i] === b2[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1])
  const ops: DiffOp[] = []
  for (let k = 0; k < head; k++) ops.push({ t: 'same', text: A[k], a: k + 1, b: k + 1 })
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a2[i] === b2[j]) {
      ops.push({ t: 'same', text: a2[i], a: head + i + 1, b: head + j + 1 })
      i++
      j++
    } else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) {
      ops.push({ t: 'del', text: a2[i], a: head + i + 1 })
      i++
    } else {
      ops.push({ t: 'add', text: b2[j], b: head + j + 1 })
      j++
    }
  }
  for (; i < n; i++) ops.push({ t: 'del', text: a2[i], a: head + i + 1 })
  for (; j < m; j++) ops.push({ t: 'add', text: b2[j], b: head + j + 1 })
  for (let k = 0; k < tail; k++) ops.push({ t: 'same', text: A[A.length - tail + k], a: A.length - tail + k + 1, b: B.length - tail + k + 1 })
  return ops
}

export interface Hunk {
  ops: DiffOp[]
  /** Unchanged lines skipped before this hunk. */
  skippedBefore: number
}

/** Changes with `context` unchanged lines around them; long unchanged runs fold into "N unchanged lines". */
export function diffHunks(ops: DiffOp[], context = 3): { hunks: Hunk[]; skippedAfter: number; added: number; removed: number } {
  const keep = new Array<boolean>(ops.length).fill(false)
  let added = 0
  let removed = 0
  ops.forEach((o, i) => {
    if (o.t === 'same') return
    if (o.t === 'add') added++
    else removed++
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true
  })
  const hunks: Hunk[] = []
  let skipped = 0
  let cur: Hunk | null = null
  ops.forEach((o, i) => {
    if (!keep[i]) {
      if (cur) {
        hunks.push(cur)
        cur = null
      }
      skipped++
      return
    }
    if (!cur) {
      cur = { ops: [], skippedBefore: skipped }
      skipped = 0
    }
    cur.ops.push(o)
  })
  if (cur) hunks.push(cur)
  return { hunks, skippedAfter: skipped, added, removed }
}

/** Insert `token` at the selection of a textarea's value; returns the new value and caret. */
export function insertAt(value: string, start: number, end: number, token: string): { value: string; caret: number } {
  const s = Math.max(0, Math.min(start, value.length))
  const e = Math.max(s, Math.min(end, value.length))
  return { value: value.slice(0, s) + token + value.slice(e), caret: s + token.length }
}

export function lineCount(text: string): number {
  let n = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}
