/**
 * Request recorder of the mock provider server: every request (headers + body) in arrival order, plus validators
 * over the recorded traffic. The Anthropic prefix-invariance check is the guard for 07 C1: within one conversation,
 * `system`, `tools` and every message already sent must be repeated byte-for-byte in the next request, otherwise
 * prompt caching and preserved thinking break.
 */
import { isRecord } from './http'

export interface RecordedRequest {
  /** 1-based arrival order across the whole mock server. */
  seq: number
  ts: number
  /** Module that answered: 'llm', 'voyage', 'tts', 'stt', 'github-models', 'script' or 'unhandled'. */
  module: string
  method: string
  path: string
  rawPath: string
  query: Record<string, string>
  /** Lower-cased header names. */
  headers: Record<string, string>
  /** Body as UTF-8 text (binary bodies are still available in `bytes`). */
  body: string
  bytes: Buffer
  json: unknown
}

export type PathMatcher = string | RegExp | ((r: RecordedRequest) => boolean)

export interface PrefixViolation {
  conversation: string
  /** `seq` of request N and N+1. */
  from: number
  to: number
  field: string
  detail: string
}

export interface PrefixCheckOptions {
  /** Which wire format to check: Anthropic `/v1/messages` (default), OpenAI-style `/chat/completions`, or both. */
  api?: 'anthropic' | 'openai' | 'all'
  /** Keys removed before comparing (moving `cache_control` breakpoints does not change the cached prefix). */
  ignoreKeys?: string[]
  /** Expected breaks (e.g. the thinking-strip retry of 07 C5, an edit that starts a branch). */
  allow?: (v: PrefixViolation) => boolean
  /** Restrict to some requests (e.g. one model). */
  filter?: (r: RecordedRequest) => boolean
}

/** Header a test may send (or the server may forward) to name the conversation explicitly. */
export const CONVERSATION_HEADER = 'x-mock-conversation'

export class Recorder {
  private items: RecordedRequest[] = []
  private waiters = new Set<() => void>()

  /** @internal called by the mock server. */
  push(r: RecordedRequest): void {
    this.items.push(r)
    for (const w of [...this.waiters]) w()
  }

  all(): RecordedRequest[] {
    return [...this.items]
  }

  clear(): void {
    this.items = []
  }

  find(match?: PathMatcher, method?: string): RecordedRequest[] {
    return this.items.filter((r) => (!method || r.method === method.toUpperCase()) && matches(r, match))
  }

  count(match?: PathMatcher, method?: string): number {
    return this.find(match, method).length
  }

  last(match?: PathMatcher, method?: string): RecordedRequest | undefined {
    const list = this.find(match, method)
    return list[list.length - 1]
  }

  byModule(module: string): RecordedRequest[] {
    return this.items.filter((r) => r.module === module)
  }

  /** Requests nothing answered (404). A strict test asserts there are none. */
  unhandled(): RecordedRequest[] {
    return this.byModule('unhandled')
  }

  assertNoUnhandled(): void {
    const u = this.unhandled()
    if (u.length) throw new Error(`mock: ${u.length} unhandled request(s):\n${u.map((r) => `  ${r.method} ${r.rawPath}`).join('\n')}`)
  }

  /** Resolve once a request matching `pred` has been recorded (including earlier ones). */
  waitFor(pred: (r: RecordedRequest) => boolean, timeoutMs = 10_000): Promise<RecordedRequest> {
    const hit = this.items.find(pred)
    if (hit) return Promise.resolve(hit)
    return new Promise((resolve, reject) => {
      const check = (): void => {
        const found = this.items.find(pred)
        if (!found) return
        clearTimeout(timer)
        this.waiters.delete(check)
        resolve(found)
      }
      const timer = setTimeout(() => {
        this.waiters.delete(check)
        reject(new Error(`mock: no matching request within ${timeoutMs} ms`))
      }, timeoutMs)
      this.waiters.add(check)
    })
  }

  checkPrefixInvariant(o: PrefixCheckOptions = {}): PrefixViolation[] {
    const api = o.api ?? 'anthropic'
    const ignore = new Set(o.ignoreKeys ?? ['cache_control'])
    const reqs = this.items.filter((r) => {
      if (r.method !== 'POST' || !isRecord(r.json)) return false
      const isAnthropic = /\/v1\/messages$/.test(r.path)
      const isOpenai = /\/chat\/completions$/.test(r.path)
      if (api === 'anthropic' && !isAnthropic) return false
      if (api === 'openai' && !isOpenai) return false
      if (api === 'all' && !isAnthropic && !isOpenai) return false
      return o.filter ? o.filter(r) : true
    })
    const byConv = new Map<string, RecordedRequest[]>()
    for (const r of reqs) {
      const key = conversationKey(r, ignore)
      if (key === null) continue
      const list = byConv.get(key) ?? []
      list.push(r)
      byConv.set(key, list)
    }
    const out: PrefixViolation[] = []
    for (const [key, list] of byConv) {
      const label = key.length > 80 ? `${key.slice(0, 77)}...` : key
      for (let i = 0; i + 1 < list.length; i++) {
        for (const v of comparePair(list[i], list[i + 1], ignore)) {
          const violation = { conversation: label, from: list[i].seq, to: list[i + 1].seq, ...v }
          if (!o.allow || !o.allow(violation)) out.push(violation)
        }
      }
    }
    return out
  }

  /** Throws with a readable report when any conversation broke its prefix (07 C1). */
  assertPrefixInvariant(o: PrefixCheckOptions = {}): void {
    const v = this.checkPrefixInvariant(o)
    if (!v.length) return
    const lines = v.slice(0, 10).map((x) => `  #${x.from} → #${x.to} ${x.field}: ${x.detail}\n    conversation: ${x.conversation}`)
    throw new Error(`mock: prefix invariance broken in ${v.length} place(s):\n${lines.join('\n')}${v.length > 10 ? '\n  …' : ''}`)
  }
}

function matches(r: RecordedRequest, m: PathMatcher | undefined): boolean {
  if (m === undefined) return true
  if (typeof m === 'string') return r.path === m || r.rawPath === m
  if (m instanceof RegExp) return m.test(r.path)
  return m(r)
}

/** Deterministic text of a JSON value with ignored keys removed (key order is kept: it is part of the bytes). */
export function canonical(v: unknown, ignore: ReadonlySet<string>): string {
  return JSON.stringify(v, (k, val: unknown) => (k && ignore.has(k) ? undefined : val))
}

function messagesOf(r: RecordedRequest): unknown[] {
  const j = r.json as Record<string, unknown>
  return Array.isArray(j.messages) ? j.messages : []
}

function conversationKey(r: RecordedRequest, ignore: ReadonlySet<string>): string | null {
  const explicit = r.headers[CONVERSATION_HEADER]
  if (explicit) return `header:${explicit}`
  const first = messagesOf(r).find((m) => isRecord(m) && m.role === 'user')
  return first === undefined ? null : canonical(first, ignore)
}

function comparePair(a: RecordedRequest, b: RecordedRequest, ignore: ReadonlySet<string>): Array<{ field: string; detail: string }> {
  const out: Array<{ field: string; detail: string }> = []
  const ja = a.json as Record<string, unknown>
  const jb = b.json as Record<string, unknown>
  for (const field of ['system', 'tools'] as const) {
    const x = canonical(ja[field] ?? null, ignore)
    const y = canonical(jb[field] ?? null, ignore)
    if (x !== y) out.push({ field, detail: diffSnippet(x, y) })
  }
  const ma = messagesOf(a)
  const mb = messagesOf(b)
  if (mb.length < ma.length) out.push({ field: 'messages.length', detail: `${ma.length} → ${mb.length} (earlier turns were dropped)` })
  for (let i = 0; i < Math.min(ma.length, mb.length); i++) {
    const x = canonical(ma[i], ignore)
    const y = canonical(mb[i], ignore)
    if (x !== y) {
      out.push({ field: `messages[${i}]`, detail: diffSnippet(x, y) })
      break
    }
  }
  return out
}

/** "…context…" around the first differing character of two strings. */
export function diffSnippet(x: string, y: string): string {
  let i = 0
  while (i < x.length && i < y.length && x[i] === y[i]) i++
  const from = Math.max(0, i - 30)
  const cut = (s: string): string => JSON.stringify(s.slice(from, i + 40))
  return `differs at char ${i}: ${cut(x)} vs ${cut(y)}`
}
