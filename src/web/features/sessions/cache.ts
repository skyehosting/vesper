/**
 * Small shared caches for lists the panel, the slash commands and their argument completion all read: the prompt
 * library (GET /api/prompts, invalidated by `prompts.changed`), the model list per AI profile and the voice list per
 * TTS provider. One request in flight per key; failures are not cached; entries expire after a few minutes so a list
 * changed elsewhere shows up without a reload. Bounded: a handful of keys at most.
 */
import type { ModelInfo, Prompt, Voice } from '@shared/types/domain'
import { api } from '../../lib/api'

const TTL_MS = 5 * 60_000

interface Entry<T> {
  at: number
  value?: T
  pending?: Promise<T>
}

function cached<T>(map: Map<string, Entry<T>>, key: string, load: () => Promise<T>, fresh = false): Promise<T> {
  const e = map.get(key)
  if (e?.pending) return e.pending
  if (!fresh && e?.value !== undefined && Date.now() - e.at < TTL_MS) return Promise.resolve(e.value)
  const pending = load().then(
    (value) => {
      map.set(key, { at: Date.now(), value })
      return value
    },
    (err: unknown) => {
      map.delete(key)
      throw err
    }
  )
  map.set(key, { at: e?.at ?? 0, value: e?.value, pending })
  return pending
}

const prompts = new Map<string, Entry<Prompt[]>>()
const models = new Map<string, Entry<ModelInfo[]>>()
const voices = new Map<string, Entry<TtsCatalogue>>()

export interface TtsCatalogue {
  voices: Voice[]
  models: ModelInfo[]
}
const promptListeners = new Set<() => void>()

export function getPrompts(fresh = false): Promise<Prompt[]> {
  return cached(prompts, 'all', () => api('GET /api/prompts'), fresh)
}

export function invalidatePrompts(): void {
  prompts.clear()
  for (const l of [...promptListeners]) l()
}

/** Called when the library changes (any device); returns the unsubscribe. */
export function onPromptsChanged(cb: () => void): () => void {
  promptListeners.add(cb)
  return () => void promptListeners.delete(cb)
}

export function getModels(profileId: string, fresh = false): Promise<ModelInfo[]> {
  return cached(models, profileId, () => api('GET /api/providers/llm/models', { query: { profile: profileId } }), fresh)
}

/** Voices and TTS models of a provider (07 C22). */
export function getTts(provider: string, fresh = false): Promise<TtsCatalogue> {
  return cached(
    voices,
    provider,
    async () => {
      const r = await api('GET /api/tts/voices', { query: { provider } })
      return { voices: r.voices, models: r.models }
    },
    fresh
  )
}

export async function getVoices(provider: string, fresh = false): Promise<Voice[]> {
  return (await getTts(provider, fresh)).voices
}

/** `tts.voices` (07 C22): a key was saved and the provider's voices arrived — no request needed. */
export function primeVoices(provider: string, list: Voice[], models: ModelInfo[]): void {
  voices.set(provider, { at: Date.now(), value: { voices: list, models } })
}

/** Test hook: sizes (bounded caches, 07 D14). */
export function cacheStats(): { prompts: number; models: number; voices: number; promptListeners: number } {
  return { prompts: prompts.size, models: models.size, voices: voices.size, promptListeners: promptListeners.size }
}
