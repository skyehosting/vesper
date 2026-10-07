/**
 * The visible-text pipeline over the model's raw text stream (R9, R13, 07 C2): `<think>…</think>` at the very start
 * goes to reasoning (servers that inline it), control tags are removed by the TagFilter (tone → speech, memory tags →
 * text-mode calls), and a leading imitated `[Now: …]` stamp plus leading whitespace is dropped. What comes out is what
 * the user sees, the speech pipeline speaks and memory indexes; the raw text stays only in the transcript.
 */
import { TagFilter, type ControlTag } from '@shared/tags'
import { stripImitatedStamp } from '@shared/time'

const OPEN = '<think>'
const CLOSE = '</think>'

/** Routes a leading `<think>…</think>` to reasoning; everything else passes. */
export class ThinkFilter {
  private state: 'start' | 'inside' | 'pass' = 'start'
  private buf = ''

  push(chunk: string): { content: string; reasoning: string } {
    if (this.state === 'pass') return { content: chunk, reasoning: '' }
    this.buf += chunk
    if (this.state === 'start') {
      const t = this.buf.replace(/^\s+/, '')
      if (!t) return { content: '', reasoning: '' }
      if (t.length < OPEN.length && OPEN.startsWith(t)) return { content: '', reasoning: '' }
      if (!t.startsWith(OPEN)) {
        this.state = 'pass'
        const out = this.buf
        this.buf = ''
        return { content: out, reasoning: '' }
      }
      this.state = 'inside'
      this.buf = t.slice(OPEN.length)
    }
    // inside
    const end = this.buf.indexOf(CLOSE)
    if (end === -1) {
      // Keep a possible partial "</think" at the end.
      let keep = 0
      for (let k = Math.min(CLOSE.length - 1, this.buf.length); k > 0; k--) {
        if (CLOSE.startsWith(this.buf.slice(-k))) {
          keep = k
          break
        }
      }
      const reasoning = this.buf.slice(0, this.buf.length - keep)
      this.buf = this.buf.slice(this.buf.length - keep)
      return { content: '', reasoning }
    }
    const reasoning = this.buf.slice(0, end)
    const content = this.buf.slice(end + CLOSE.length)
    this.buf = ''
    this.state = 'pass'
    return { content, reasoning }
  }

  end(): { content: string; reasoning: string } {
    const b = this.buf
    this.buf = ''
    if (this.state === 'inside') return { content: '', reasoning: b }
    return { content: b, reasoning: '' }
  }
}

/** Drops leading whitespace and a leading imitated stamp (07 C2); holds at most ~200 chars to decide. */
export class StampFilter {
  private state: 'start' | 'pass' = 'start'
  private buf = ''
  /** Nothing visible has been released yet (whitespace after a removed stamp is still leading whitespace). */
  private empty = true
  /** Characters removed at the start (to shift tag offsets). */
  removed = 0

  push(text: string): string {
    if (this.state === 'pass') return this.trim(text)
    this.buf += text
    const t = this.buf.replace(/^\s+/, '')
    if (!t) return ''
    if (t[0] !== '[' || t.includes(']') || t.includes('\n') || t.length > 200) return this.release()
    return ''
  }

  end(): string {
    return this.state === 'pass' ? '' : this.release()
  }

  get decided(): boolean {
    return this.state === 'pass'
  }

  private trim(text: string): string {
    if (!this.empty) return text
    const out = text.replace(/^\s+/, '')
    this.removed += text.length - out.length
    if (out) this.empty = false
    return out
  }

  private release(): string {
    const all = this.buf
    this.buf = ''
    this.state = 'pass'
    const out = stripImitatedStamp(all)
    this.removed = all.length - out.length
    return this.trim(out)
  }
}

export interface VisibleChunk {
  text: string
  reasoning: string
  /** Tags with `at` in final visible coordinates (characters released before them over the whole reply). */
  tags: ControlTag[]
}

export class VisiblePipeline {
  private think = new ThinkFilter()
  private tags = new TagFilter()
  private stamp = new StampFilter()
  private queued: ControlTag[] = []
  /** Visible characters released so far. */
  length = 0

  push(raw: string): VisibleChunk {
    const t = this.think.push(raw)
    const f = this.tags.push(t.content)
    return this.after(this.stamp.push(f.text), t.reasoning, f.tags)
  }

  end(): VisibleChunk {
    const t = this.think.end()
    const f1 = this.tags.push(t.content)
    const f2 = this.tags.end()
    const text = this.stamp.push(f1.text + f2.text) + this.stamp.end()
    return this.after(text, t.reasoning, [...f1.tags, ...f2.tags])
  }

  private after(text: string, reasoning: string, tags: ControlTag[]): VisibleChunk {
    this.queued.push(...tags)
    let out: ControlTag[] = []
    if (this.stamp.decided) {
      out = this.queued.map((g) => ({ ...g, at: Math.max(0, g.at - this.stamp.removed) }))
      this.queued = []
    }
    this.length += text.length
    return { text, reasoning, tags: out }
  }
}
