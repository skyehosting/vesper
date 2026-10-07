/**
 * Memory functions run for the model (R9, 07 C1/B7/C13): native tool calls and text-mode bracket tags both end here.
 * Arguments are clamped in code to the allowed set (the scope is clamped again by MemoryService against what the
 * session may access); refusals and "disabled" are fixed strings; results are the untrusted() rendering from
 * MemoryService.formatResult. Memory being off never removes the tools (that would change the frozen tool set) — the
 * functions just answer "memory is disabled".
 */
import { normalizeShortId } from '@shared/ids'
import type { MemoryHit, MemoryScope } from '@shared/types/domain'
import type { MemoryService } from '../services'

export const MEMORY_DISABLED = 'memory is disabled'
export const LIMIT_REACHED = 'Lookup limit reached for this reply. Answer now with what you already have.'
export const SEARCH_BUDGET_MS = 1200

export interface ToolRun {
  text: string
  isError: boolean
  kind: 'search' | 'recall' | 'sessions'
  query: string
  hits: MemoryHit[]
}

export interface ToolEnv {
  memory: MemoryService | undefined
  enabled: boolean
  sessionUid: string
  nowUtc: number
  tzName: string | null
  tzOffsetMin: number
  /**
   * P19: after an empty memory_search, what the model is told about chats outside this one's reach that mention the
   * query (scopeHint.ts) — null when there are none or a link can't help.
   */
  outOfReach?: (query: string) => string | null
}

const str = (v: unknown, max = 500): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : undefined)
const int = (v: unknown, lo: number, hi: number): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.trunc(n))) : undefined
}
const date = (v: unknown): string | undefined => {
  const s = str(v, 40)
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined
}
const scopeOf = (v: unknown): MemoryScope | undefined => (v === 'this' || v === 'linked' || v === 'all' ? v : undefined)

const kindOf = (name: string): ToolRun['kind'] => (name === 'memory_recall' ? 'recall' : name === 'memory_sessions' ? 'sessions' : 'search')

export async function runMemoryFunction(name: string, input: Record<string, unknown>, env: ToolEnv): Promise<ToolRun> {
  const kind = kindOf(name)
  const base = { kind, query: '', hits: [] as MemoryHit[] }
  if (name !== 'memory_search' && name !== 'memory_recall' && name !== 'memory_sessions') return { ...base, text: `Unknown function ${name.slice(0, 40)}.`, isError: true }
  if (!env.enabled || !env.memory) return { ...base, text: MEMORY_DISABLED, isError: false }
  const fmt = { nowUtc: env.nowUtc, tzName: env.tzName, tzOffsetMin: env.tzOffsetMin }
  try {
    if (name === 'memory_search') {
      const query = str(input.query) ?? ''
      if (!query) return { ...base, text: 'memory_search needs a query.', isError: true }
      const r = await env.memory.search(
        { query, after: date(input.after), before: date(input.before), limit: int(input.limit, 1, 10) ?? 8 },
        { sessionUid: env.sessionUid, requested: scopeOf(input.scope) },
        SEARCH_BUDGET_MS
      )
      // A refusal (memory off for this chat, …) is said as such, never rendered as "No matching records" (F27).
      if (r.refused) return { kind, query, hits: [], text: r.refused, isError: false }
      const text = env.memory.formatResult(r.hits, { query, ...fmt })
      const hint = r.hits.length === 0 ? (env.outOfReach?.(query) ?? null) : null
      // P19: nothing in reach, but other chats mention it — the model can point the owner at /link (scopeHint.ts).
      return { kind, query, hits: r.hits, text: hint ? [text, hint].join('\n') : text, isError: false }
    }
    if (name === 'memory_recall') {
      const short = normalizeShortId(str(input.session, 20) ?? '')
      if (!short) return { ...base, text: 'memory_recall needs a conversation ID like #K7Q2MX.', isError: true }
      const query = str(input.query)
      const r = await env.memory.recall({ shortId: short, query, around: date(input.around), last: int(input.last, 1, 40) ?? 20 }, { sessionUid: env.sessionUid })
      // MemoryService's refusals are fixed strings (07 B7) whose only variable is the normalised ID: passed through, so
      // the model can tell the user why — not linked (with the /link hint), no such ID, private, memory off (F30).
      if (r.refused) return { kind, query: `#${short}`, hits: [], text: r.refused, isError: false }
      return { kind, query: `#${short}`, hits: r.hits, text: env.memory.formatResult(r.hits, { query: query ?? `#${short}`, ...fmt }), isError: false }
    }
    const query = str(input.query)
    const r = await env.memory.sessions(query, { sessionUid: env.sessionUid })
    return { kind, query: query ?? '', hits: [], text: r.text, isError: false }
  } catch {
    return { ...base, text: 'Memory is unavailable right now.', isError: true }
  }
}
