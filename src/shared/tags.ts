/**
 * Control tags the AI may write in its text (protocols.md): `[tone=warm]`, `[memory_search query="…"]`,
 * `[memory_recall session="#K7Q2MX" last="20"]`, `[memory_sessions query="…"]`. They are removed from streamed text before it is shown, spoken,
 * stored in the UI timeline or embedded (R9, R13). The raw text, tags included, is kept only in the wire transcript.
 *
 * TagFilter is incremental: visible text is released as soon as it provably cannot be part of a tag; a possible tag
 * prefix is held back (at most MAX_TAG characters) until it closes with `]` or stops matching. Each tag reports `at`,
 * the number of visible characters released before it, so a mid-reply tone change applies from the right sentence.
 * Ported from the research prototype (10,000/10,000 random chunk splits, research 01 §2.5).
 */

import { MEMORY_FUNCTIONS } from './memoryFunctions'
import type { MemoryFunctionName } from './types/wire'

export type ControlTagName = 'tone' | MemoryFunctionName
/** `tone` + every memory function documented to text-mode models (F38: derived, so the two cannot drift). */
export const CONTROL_TAGS: readonly ControlTagName[] = ['tone', ...MEMORY_FUNCTIONS.map((f) => f.name)]

export interface ControlTag {
  name: ControlTagName
  /** `[tone=warm]` → { value: 'warm' }; `[memory_search query="x"]` → { query: 'x' } */
  attrs: Record<string, string>
  raw: string
  /** Visible characters released before this tag (over the whole stream). */
  at: number
}

const MAX_TAG = 600

/*
 * Tolerance (F22/F42, R13): models drift from the documented `[tone=warm]`. A tag is recognised whatever its casing
 * (`[Tone=happy]`, `[TONE=warm]`), with spaces or tabs inside the brackets (`[ tone=calm ]`), `-` for `_` in a function
 * name, and `=` or `:` as the separator (`[tone: warm]`, `[memory_search query: "x"]`). The name must still be a whole
 * control-tag name and a tone still needs a value: `[tone]`, `[toner=x]`, `[note: …]` stay visible text.
 */
const LEAD_RE = /^[ \t]*/
const normName = (s: string): string => s.toLowerCase().replace(/-/g, '_')

function couldBeTagPrefix(s: string): boolean {
  const lead = s.slice(1).replace(LEAD_RE, '')
  const norm = normName(lead)
  for (const n of CONTROL_TAGS) {
    if (n.startsWith(norm)) return true
    if (norm.startsWith(n)) {
      const next = lead[n.length]
      if (next === undefined || next === '=' || next === ':' || next === ']' || next === ' ' || next === '\t') return true
    }
  }
  return false
}

/**
 * An unterminated tag that is certainly a tag (used only at end of stream): `[` + a whole control-tag name + its
 * separator (`=`/`:` for tone, which needs a value; `=`/`:`/space/tab for a memory function, whose attributes follow).
 */
function isTagInProgress(s: string): boolean {
  if (s[0] !== '[') return false
  const lead = s.slice(1).replace(LEAD_RE, '')
  const m = /^[A-Za-z][A-Za-z_-]*/.exec(lead)
  if (!m) return false
  const name = normName(m[0])
  if (!(CONTROL_TAGS as readonly string[]).includes(name)) return false
  const after = lead.slice(m[0].length)
  return name === 'tone' ? /^[ \t]*[=:]/.test(after) : /^[ \t=:]/.test(after)
}

const ATTR_RE = /([A-Za-z_]+)\s*[=:]\s*(?:"([^"]*)"|'([^']*)'|([^\s\]"']+))/g
const ATTRS_ONLY_RE = /^(?:\s*[A-Za-z_]+\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s\]"']+))*\s*$/

/** `key="v" other=w` (keys lowercased); null when the text is not only attributes. */
function parseAttrs(s: string): Record<string, string> | null {
  if (!ATTRS_ONLY_RE.test(s)) return null
  const attrs: Record<string, string> = {}
  for (const a of s.matchAll(ATTR_RE)) attrs[a[1].toLowerCase()] = (a[2] ?? a[3] ?? a[4] ?? '').trim()
  return attrs
}

const unquote = (v: string): string => v.trim().replace(/^(["'])(.*)\1$/, '$2').trim()

/** The parameter a bare value fills: `[memory_search: lisbon]` → query, `[memory_recall=#K7Q2MX]` → session. */
function mainParam(name: string): string {
  const def = MEMORY_FUNCTIONS.find((f) => f.name === name)
  return def?.params.find((p) => p.required)?.name ?? def?.params[0]?.name ?? 'value'
}

/** Parse one complete `[…]` candidate; null when it is not a control tag (it then stays visible text). */
export function parseControlTag(raw: string): Omit<ControlTag, 'at'> | null {
  const m = /^\[[ \t]*([A-Za-z][A-Za-z_-]*)([^\]]*)\]$/.exec(raw)
  if (!m) return null
  const name = normName(m[1]) as ControlTagName
  if (!(CONTROL_TAGS as readonly string[]).includes(name)) return null
  const rest = m[2]
  let attrs: Record<string, string> = {}
  const sep = /^\s*[=:]\s*/.exec(rest)
  if (sep) {
    const v = rest.slice(sep[0].length)
    if (name === 'tone') {
      // `[tone=warm, playful]` — a bare value (strip optional quotes)
      const value = unquote(v)
      if (!value) return null
      attrs.value = value
    } else {
      // `[memory_search: query="x"]` (attributes after a separator) or `[memory_search: x]` (the main parameter).
      const parsed = parseAttrs(v)
      if (parsed) attrs = parsed
      else {
        const value = unquote(v)
        if (value) attrs[mainParam(name)] = value
      }
    }
  } else {
    if (rest && !/^\s/.test(rest)) return null
    const parsed = parseAttrs(rest)
    if (!parsed) return null
    attrs = parsed
    // "[tone]" stays visible; "[memory_search]" with no arguments is still a call (the engine answers it).
    if (name === 'tone') return null
  }
  return { name, attrs, raw }
}

/**
 * Where a control tag could open, in every form parseControlTag accepts (any casing, inner spaces, `-`/`_`, `=`/`:`).
 * Used to neutralise untrusted text (07 B7): quoted, recalled or attached text can never become a tag.
 */
export const CONTROL_TAG_OPEN_RE = /\[(?=[ \t]*(?:memory[_-]|tone\s*[=:]))/gi
const WORD_JOINER = '⁠'

/** Put a word joiner after every `[` that could open a control tag (it then stays plain text). */
export function neutralizeControlTags(text: string): string {
  return text.replace(CONTROL_TAG_OPEN_RE, `[${WORD_JOINER}`)
}

export class TagFilter {
  private buf = ''
  private released = 0

  /** Feed a streamed chunk; returns the visible text it releases and any complete tags. */
  push(chunk: string): { text: string; tags: ControlTag[] } {
    this.buf += chunk
    let out = ''
    const tags: ControlTag[] = []
    while (this.buf.length) {
      const i = this.buf.indexOf('[')
      if (i === -1) {
        out += this.buf
        this.buf = ''
        break
      }
      out += this.buf.slice(0, i)
      this.buf = this.buf.slice(i)
      const close = this.buf.indexOf(']')
      if (close === -1) {
        if (couldBeTagPrefix(this.buf) && this.buf.length < MAX_TAG) break // wait for more
        out += this.buf[0]
        this.buf = this.buf.slice(1)
        continue
      }
      const candidate = this.buf.slice(0, close + 1)
      const tag = couldBeTagPrefix(candidate) ? parseControlTag(candidate) : null
      if (tag) {
        tags.push({ ...tag, at: this.released + out.length })
        this.buf = this.buf.slice(close + 1)
      } else {
        out += this.buf[0]
        this.buf = this.buf.slice(1)
      }
    }
    this.released += out.length
    return { text: out, tags }
  }

  /**
   * Flush at end of stream. A held `[` that is provably a tag in progress (a whole control-tag name followed by its
   * separator, e.g. a reply cut off at `Sure. [tone=warm`) is swallowed up to the end of its line, as research 04
   * §7.3 specifies; anything else held (`[`, `[to`, `[tone of voice`) is plain text and released.
   */
  end(): { text: string; tags: ControlTag[] } {
    let buf = this.buf
    let text = ''
    while (buf.length) {
      if (isTagInProgress(buf)) {
        const nl = buf.indexOf('\n')
        if (nl === -1) break
        buf = buf.slice(nl)
      }
      const i = buf.indexOf('[', 1)
      if (i === -1) {
        text += buf
        break
      }
      text += buf.slice(0, i)
      buf = buf.slice(i)
    }
    this.buf = ''
    this.released += text.length
    return { text, tags: [] }
  }

  /** Is text currently being held back (a possible tag in progress)? */
  get holding(): boolean {
    return this.buf.length > 0
  }
}

/** Whole-string convenience: visible text + tags. */
export function stripControlTags(text: string): { text: string; tags: ControlTag[] } {
  const f = new TagFilter()
  const a = f.push(text)
  const b = f.end()
  return { text: a.text + b.text, tags: a.tags }
}

/**
 * Tidy whitespace left where tags were removed: a tag alone on its own line leaves an empty line; a leading
 * `[tone=…] Hello` leaves a leading space. Applied to the final stored text only (streamed deltas are tidied by the
 * renderer the same way).
 */
export function tidyAfterTags(text: string): string {
  return text
    .replace(/^[ \t]+/, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}
