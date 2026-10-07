/**
 * Voyage AI model catalogue and limits (research 02 §2.2/§2.5/§2.6, prices as of 2026-09-29). Voyage has no models
 * endpoint (GET /v1/models → 404), so Vesper ships this table. Pure data: used by the main process (estimates, wizard)
 * and by db.worker (batch sizing, rate limits).
 */

export type VoyageTier = 'free' | 'tier1' | 'tier2' | 'tier3'

export interface EmbedModelInfo {
  id: string
  /** Models of one family share an embedding space (voyage-4 series): switching keeps the generation (07 C10). */
  family: string
  usdPerMTok: number
  /** Max tokens in one request. */
  maxRequestTokens: number
  /** Tier-1 tokens per minute. */
  tier1Tpm: number
}

export interface RerankModelInfo {
  id: string
  usdPerMTok: number
  tier1Tpm: number
}

export const EMBED_MODELS: readonly EmbedModelInfo[] = [
  { id: 'voyage-4-lite', family: 'voyage-4', usdPerMTok: 0.02, maxRequestTokens: 1_000_000, tier1Tpm: 16_000_000 },
  { id: 'voyage-4', family: 'voyage-4', usdPerMTok: 0.06, maxRequestTokens: 320_000, tier1Tpm: 8_000_000 },
  { id: 'voyage-4-large', family: 'voyage-4', usdPerMTok: 0.12, maxRequestTokens: 120_000, tier1Tpm: 3_000_000 },
  { id: 'voyage-code-4', family: 'voyage-code-4', usdPerMTok: 0.12, maxRequestTokens: 120_000, tier1Tpm: 3_000_000 }
]

export const RERANK_MODELS: readonly RerankModelInfo[] = [
  { id: 'rerank-3-lite', usdPerMTok: 0.02, tier1Tpm: 4_000_000 },
  { id: 'rerank-3', usdPerMTok: 0.05, tier1Tpm: 2_000_000 }
]

/** Free trial (no payment method): 3 RPM / 10K TPM for everything (research 02 §2.6). */
export const FREE_TRIAL_LIMITS = { rpm: 3, tpm: 10_000 } as const
export const TIER1_RPM = 2000
const TIER_MULT: Record<VoyageTier, number> = { free: 0, tier1: 1, tier2: 2, tier3: 3 }

/** Per request at most 1,000 inputs (embeddings) or documents (rerank). */
export const MAX_INPUTS = 1000
/**
 * Practical cap on one background request (research 02 §5.2: "about 100K tokens per request") so a single slow
 * request never holds a big batch hostage.
 */
export const MAX_BATCH_TOKENS = 100_000

/** Unknown models: assume a voyage-4-like model of its own family (conservative limits). */
export function embedModel(id: string): EmbedModelInfo {
  return EMBED_MODELS.find((m) => m.id === id) ?? { id, family: id.startsWith('voyage-4') && !id.includes('code') ? 'voyage-4' : id, usdPerMTok: 0.12, maxRequestTokens: 120_000, tier1Tpm: 3_000_000 }
}

export function rerankModel(id: string): RerankModelInfo {
  return RERANK_MODELS.find((m) => m.id === id) ?? { id, usdPerMTok: 0.05, tier1Tpm: 2_000_000 }
}

/** Rate limits of one model at a tier. */
export function limitsFor(tier: VoyageTier, tier1Tpm: number): { rpm: number; tpm: number } {
  if (tier === 'free') return { ...FREE_TRIAL_LIMITS }
  const k = TIER_MULT[tier]
  return { rpm: TIER1_RPM * k, tpm: tier1Tpm * k }
}

/** Rough token count (research 02 §2.2: characters ÷ 5; at least 1). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 5))
}

/**
 * Default base URL for a key (research 02 §8.1): `al-eu-`/`al-us-` → regional Atlas, `al-` → ai.mongodb.com, anything
 * else → api.voyageai.com.
 */
export function baseUrlForKey(key: string): string {
  const k = key.trim()
  if (k.startsWith('al-eu-')) return 'https://eu.ai.mongodb.com/v1'
  if (k.startsWith('al-us-')) return 'https://us.ai.mongodb.com/v1'
  if (k.startsWith('al-')) return 'https://ai.mongodb.com/v1'
  return 'https://api.voyageai.com/v1'
}
