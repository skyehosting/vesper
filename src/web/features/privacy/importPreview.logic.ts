/**
 * Import preview (07 A4, Settings → Data): before uploading, the client reads the chosen file and says what it holds —
 * "38 conversations, ~1,240 messages from ChatGPT, Mar 2023 – Sep 2026". This is a cheap approximation of the
 * server's readers (src/server/data/sources.ts): the visible branch only, consecutive turns of one role merged, empty
 * and hidden turns skipped. The import result reports the exact numbers. Pure; runs in a worker for big files.
 */

export type ImportSource = 'vesper' | 'chatgpt' | 'claude'

export interface ImportPreview {
  source: ImportSource
  conversations: number
  messages: number
  firstUtc: number | null
  lastUtc: number | null
  titles: string[]
  prompts: number
  facts: number
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export function detectSource(doc: unknown): ImportSource | null {
  if (isObj(doc) && doc.format === 'vesper-export') return 'vesper'
  if (!Array.isArray(doc)) return null
  const first = doc.find(isObj)
  if (!first) return doc.length === 0 ? 'chatgpt' : null
  if ('mapping' in first) return 'chatgpt'
  if ('chat_messages' in first) return 'claude'
  return null
}

function secToMs(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 1000) : null
}

function isoToMs(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/** Count turns after merging consecutive same-role turns (what the importer stores). */
function mergedCount(roles: string[]): number {
  let n = 0
  let prev: string | null = null
  for (const r of roles) {
    if (r !== prev) n++
    prev = r
  }
  return n
}

function gptText(m: Obj): string {
  const content = m.content
  if (!isObj(content)) return ''
  if (Array.isArray(content.parts)) return content.parts.filter((p): p is string => typeof p === 'string').join('\n')
  if (typeof content.text === 'string') return content.text
  return ''
}

function chatgptConversation(c: Obj): { roles: string[]; first: number | null; last: number | null; title: string } {
  const mapping = isObj(c.mapping) ? c.mapping : {}
  const nodes = new Map<string, Obj>()
  for (const [k, v] of Object.entries(mapping)) if (isObj(v)) nodes.set(typeof v.id === 'string' ? v.id : k, v)
  const path: Obj[] = []
  const seen = new Set<string>()
  let cur = typeof c.current_node === 'string' ? c.current_node : null
  while (cur && nodes.has(cur) && !seen.has(cur) && seen.size < 200_000) {
    seen.add(cur)
    const n = nodes.get(cur) as Obj
    path.push(n)
    cur = typeof n.parent === 'string' ? n.parent : null
  }
  path.reverse()
  const roles: string[] = []
  let first: number | null = secToMs(c.create_time)
  let last: number | null = secToMs(c.update_time) ?? first
  for (const n of path) {
    const m = n.message
    if (!isObj(m) || !isObj(m.author)) continue
    const role = m.author.role
    if (role !== 'user' && role !== 'assistant') continue
    if (typeof m.recipient === 'string' && m.recipient !== 'all') continue
    const meta = isObj(m.metadata) ? m.metadata : {}
    if (meta.is_visually_hidden_from_conversation === true || meta.is_user_system_message === true) continue
    if (!gptText(m).trim()) continue
    roles.push(role)
    const ts = secToMs(m.create_time)
    if (ts !== null) {
      first = first === null ? ts : Math.min(first, ts)
      last = last === null ? ts : Math.max(last, ts)
    }
  }
  return { roles, first, last, title: typeof c.title === 'string' ? c.title.trim() : '' }
}

function claudeConversation(c: Obj): { roles: string[]; first: number | null; last: number | null; title: string } {
  const msgs = Array.isArray(c.chat_messages) ? c.chat_messages.filter(isObj) : []
  const roles: string[] = []
  let first = isoToMs(c.created_at)
  let last = isoToMs(c.updated_at) ?? first
  for (const m of msgs) {
    const role = m.sender === 'human' ? 'user' : m.sender === 'assistant' ? 'assistant' : null
    if (!role) continue
    const text = Array.isArray(m.content)
      ? m.content
          .filter(isObj)
          .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
          .join('')
      : ''
    if (!(text || (typeof m.text === 'string' ? m.text : '')).trim()) continue
    roles.push(role)
    const ts = isoToMs(m.created_at)
    if (ts !== null) {
      first = first === null ? ts : Math.min(first, ts)
      last = last === null ? ts : Math.max(last, ts)
    }
  }
  return { roles, first, last, title: typeof c.name === 'string' ? c.name.trim() : '' }
}

export function previewDoc(doc: unknown): ImportPreview | null {
  const source = detectSource(doc)
  if (!source) return null
  const p: ImportPreview = { source, conversations: 0, messages: 0, firstUtc: null, lastUtc: null, titles: [], prompts: 0, facts: 0 }
  const take = (c: { roles: string[]; first: number | null; last: number | null; title: string }): void => {
    const n = mergedCount(c.roles)
    if (n === 0) return
    p.conversations++
    p.messages += n
    if (c.first !== null) p.firstUtc = p.firstUtc === null ? c.first : Math.min(p.firstUtc, c.first)
    if (c.last !== null) p.lastUtc = p.lastUtc === null ? c.last : Math.max(p.lastUtc, c.last)
    if (p.titles.length < 5 && c.title) p.titles.push(c.title.slice(0, 120))
  }
  if (source === 'vesper') {
    const d = doc as Obj
    const sessions = Array.isArray(d.sessions) ? d.sessions.filter(isObj) : []
    for (const s of sessions) {
      const msgs = Array.isArray(s.messages) ? s.messages.filter(isObj) : []
      const ts = msgs.map((m) => (typeof m.tsUtc === 'number' ? m.tsUtc : null)).filter((t): t is number => t !== null)
      take({
        roles: msgs.map((m) => String(m.role)),
        first: ts.length ? Math.min(...ts) : null,
        last: ts.length ? Math.max(...ts) : null,
        title: typeof s.title === 'string' ? s.title : ''
      })
    }
    p.prompts = Array.isArray(d.prompts) ? d.prompts.length : 0
    p.facts = Array.isArray(d.facts) ? d.facts.length : 0
    return p
  }
  for (const c of (doc as unknown[]).filter(isObj)) take(source === 'chatgpt' ? chatgptConversation(c) : claudeConversation(c))
  return p
}

export const SOURCE_LABELS: Record<ImportSource, string> = { chatgpt: 'ChatGPT', claude: 'Claude', vesper: 'a Vesper export' }

/** Names inside a ZIP that hold the document (same rule as the server). */
export function isDocEntry(name: string): boolean {
  return name === 'vesper-export.json' || (/(^|\/)conversations\.json$/i.test(name) && name.split('/').length <= 2)
}

/** Upload limit (07 B6: import ≤ 200 MB). */
export const MAX_IMPORT_BYTES = 200 * 1024 * 1024
