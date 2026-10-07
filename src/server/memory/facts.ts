/**
 * Pinned facts, "About you" (07 A4): `/remember <fact>`, a message action and the memory viewer edit them; the chat
 * engine delivers them as a `system_note` at epoch start and whenever they change (07 C1: no clock or state in the
 * system prompt). The engine asks for `note()` and compares `version()` per turn, or subscribes with `onChange`.
 */
import { createHash } from 'node:crypto'
import { VesperError } from '@shared/errors'
import type { Fact } from '@shared/types/domain'
import type { ServerContext } from '../services'

export const MAX_FACTS = 200
export const MAX_FACT_CHARS = 500

export interface FactsApi {
  list(): Fact[]
  create(text: string): Fact
  update(id: number, text: string): Fact
  delete(id: number): void
  /** Hash of the current facts ('' when none) — changes whenever the note would change. */
  version(): string
  /** The system_note text the engine appends (null when there are no facts). */
  note(): string | null
  onChange(cb: () => void): () => void
}

function clean(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t) throw new VesperError('validation', { fields: { text: 'Write the fact to remember.' } })
  if (t.length > MAX_FACT_CHARS) throw new VesperError('validation', { fields: { text: `Keep it under ${MAX_FACT_CHARS} characters.` } })
  return t
}

export function createFacts(ctx: ServerContext): FactsApi {
  const listeners = new Set<() => void>()
  const changed = () => {
    for (const cb of [...listeners]) {
      try {
        cb()
      } catch (e) {
        ctx.log.warn('facts listener failed', { error: e })
      }
    }
  }
  const api: FactsApi = {
    list: () => ctx.repos.facts.list(),
    create(text) {
      if (ctx.repos.facts.list().length >= MAX_FACTS) throw new VesperError('validation', { message: `You can pin up to ${MAX_FACTS} facts.` })
      const f = ctx.repos.facts.create(clean(text), ctx.clock.now())
      changed()
      return f
    },
    update(id, text) {
      const f = ctx.repos.facts.update(id, clean(text), ctx.clock.now())
      changed()
      return f
    },
    delete(id) {
      const exists = ctx.repos.facts.list().some((f) => f.id === id)
      if (!exists) throw new VesperError('not_found')
      ctx.repos.facts.delete(id)
      changed()
    },
    version() {
      const facts = ctx.repos.facts.list()
      if (!facts.length) return ''
      return createHash('sha256')
        .update(facts.map((f) => `${f.id}:${f.text}`).join('\n'))
        .digest('hex')
        .slice(0, 16)
    },
    note() {
      const facts = ctx.repos.facts.list()
      if (!facts.length) return null
      return `About the user (facts the user pinned; newer statements in the conversation may supersede them):\n${facts.map((f) => `- ${f.text}`).join('\n')}`
    },
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
  return api
}
