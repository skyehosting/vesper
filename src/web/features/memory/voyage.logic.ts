/**
 * Voyage AI choices for the UI (research 02 §2.2/§2.5/§2.6). Voyage has no models endpoint, so the server ships a
 * catalogue (src/server/providers/voyage/catalogue.ts); this is the client's copy of the parts a person picks from,
 * kept equal to the server's by a unit test (tests/unit/web/memory-ui.test.ts).
 */

export interface EmbedChoice {
  id: string
  family: string
  usdPerMTok: number
  label: string
  description: string
}

export const EMBED_CHOICES: readonly EmbedChoice[] = [
  { id: 'voyage-4-lite', family: 'voyage-4', usdPerMTok: 0.02, label: 'voyage-4-lite', description: 'Fast and cheapest — recommended for chat memory' },
  { id: 'voyage-4', family: 'voyage-4', usdPerMTok: 0.06, label: 'voyage-4', description: 'Better recall on long, subtle topics' },
  { id: 'voyage-4-large', family: 'voyage-4', usdPerMTok: 0.12, label: 'voyage-4-large', description: 'Best quality, slowest' },
  { id: 'voyage-code-4', family: 'voyage-code-4', usdPerMTok: 0.12, label: 'voyage-code-4', description: 'Tuned for code-heavy conversations' }
]

export const RERANK_CHOICES: readonly { id: string; usdPerMTok: number; label: string; description: string }[] = [
  { id: 'rerank-3-lite', usdPerMTok: 0.02, label: 'rerank-3-lite', description: 'Re-orders search hits by meaning (recommended)' },
  { id: 'rerank-3', usdPerMTok: 0.05, label: 'rerank-3', description: 'A little sharper, a little slower' },
  { id: 'none', usdPerMTok: 0, label: 'Off', description: 'Use the vector order only (fewer requests)' }
]

export const DIMENSIONS = [256, 512, 1024, 2048] as const
export type Dimension = (typeof DIMENSIONS)[number]

/** Free trial (no payment method): 3 requests and 10K tokens per minute; tier 1: 2,000 requests per minute. */
export const FREE_TRIAL_RPM = 3
export const TIER1_RPM = 2000

export const TIER_LABELS: Record<'free' | 'tier1' | 'tier2' | 'tier3' | 'unknown', string> = {
  free: 'Free trial',
  tier1: 'Tier 1',
  tier2: 'Tier 2',
  tier3: 'Tier 3',
  unknown: 'Checking…'
}

export function embedChoice(id: string): EmbedChoice | undefined {
  return EMBED_CHOICES.find((m) => m.id === id)
}

/** Models of one family share a vector space: switching inside a family keeps the index (07 C10). */
export function familyOf(id: string): string {
  return embedChoice(id)?.family ?? (id.startsWith('voyage-4') && !id.includes('code') ? 'voyage-4' : id)
}

/** A model or dimension change that makes the server build a new index generation (re-embedding in the background). */
export function needsRebuild(from: { model: string; dim: number }, to: { model: string; dim: number }): boolean {
  return from.dim !== to.dim || familyOf(from.model) !== familyOf(to.model)
}

/** Base URL a key belongs to (research 02 §8.1): `al-eu-`/`al-us-` → regional MongoDB Atlas, `al-` → Atlas, else Voyage. */
export function baseUrlForKey(key: string): string {
  const k = key.trim()
  if (k.startsWith('al-eu-')) return 'https://eu.ai.mongodb.com/v1'
  if (k.startsWith('al-us-')) return 'https://us.ai.mongodb.com/v1'
  if (k.startsWith('al-')) return 'https://ai.mongodb.com/v1'
  return 'https://api.voyageai.com/v1'
}

/** A quick shape check before sending a key (Voyage keys start with `pa-`, Atlas keys with `al-`). */
export function voyageKeyProblem(key: string): string | null {
  const k = key.trim()
  if (k.length < 12) return 'That looks too short for a Voyage AI key.'
  if (/\s/.test(k)) return 'A key has no spaces in it.'
  return null
}
