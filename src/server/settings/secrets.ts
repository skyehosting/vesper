/**
 * SecretsService over the platform's encrypted store (07 B1). Each entry is JSON `{value, origin}`: a provider key is
 * bound to the origin (scheme + host + port) it was entered for and is only handed out for requests to that origin,
 * so changing a base URL can never send an old key to a new host. Values never leave the server process.
 */
import { VesperError } from '@shared/errors'
import type { SecretStore } from '../platform'
import type { Log, SecretsService } from '../services'

interface Entry {
  value: string
  origin: string | null
}

/** Secret names the API accepts (03 §2 + custom header values, which are secrets too). */
export const SECRET_NAME = /^(llm:[a-z0-9][a-z0-9_-]{0,63}|llm-header:[a-z0-9][a-z0-9_-]{0,63}|voyage|tts:(elevenlabs|openai|azure|openai-compatible)|stt:(openai|groq|deepgram|elevenlabs))$/

/** Names under this prefix belong to the server itself (e.g. `internal.tls-lan-key`); SECRET_NAME never matches them. */
export const INTERNAL_SECRET_PREFIX = 'internal.'

export function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    throw new VesperError('validation', { message: 'Not a valid URL', fields: { url: 'Not a valid URL' } })
  }
}

export interface SecretsServiceImpl extends SecretsService {
  /** Forget cached readability (after an external change). */
  invalidate(): void
}

export function createSecretsService(store: SecretStore, log: Log): SecretsServiceImpl {
  // Decrypting is cheap but asynchronous (DPAPI); the readable/invalid split is cached until the next change.
  let scan: Promise<{ ok: string[]; bad: string[] }> | null = null

  async function read(name: string): Promise<Entry | null | 'unreadable'> {
    let raw: string | null
    try {
      raw = await store.get(name)
    } catch {
      return 'unreadable'
    }
    if (raw === null) return null
    try {
      const e = JSON.parse(raw) as Partial<Entry>
      if (typeof e.value !== 'string') return 'unreadable'
      return { value: e.value, origin: typeof e.origin === 'string' ? e.origin : null }
    } catch {
      return 'unreadable'
    }
  }

  function scanAll(): Promise<{ ok: string[]; bad: string[] }> {
    scan ??= (async () => {
      const ok: string[] = []
      const bad: string[] = []
      for (const name of await store.list()) {
        // Server-internal entries (the LAN TLS key, access-server) are not API keys: never listed to clients.
        if (name.startsWith(INTERNAL_SECRET_PREFIX)) continue
        const e = await read(name)
        if (e === 'unreadable') bad.push(name)
        else if (e) ok.push(name)
      }
      if (bad.length) log.warn('secrets that cannot be decrypted', { names: bad })
      return { ok: ok.sort(), bad: bad.sort() }
    })()
    return scan
  }

  return {
    async list() {
      return (await scanAll()).ok
    },
    async invalid() {
      return (await scanAll()).bad
    },
    async getFor(name, requestUrl) {
      const e = await read(name)
      if (e === null) return null
      if (e === 'unreadable') throw new VesperError('secret_unreadable')
      if (e.origin !== null && e.origin !== originOf(requestUrl)) throw new VesperError('key_origin_mismatch')
      return e.value
    },
    async set(name, value, boundUrl) {
      if (!store.available()) throw new VesperError('secret_unreadable', { message: "Windows can't encrypt keys right now, so the key wasn't saved." })
      const entry: Entry = { value, origin: boundUrl === null ? null : originOf(boundUrl) }
      await store.set(name, JSON.stringify(entry))
      scan = null
    },
    async delete(name) {
      await store.delete(name)
      scan = null
    },
    async rebind(name, newUrl) {
      const e = await read(name)
      if (e === null) return 'absent'
      if (e !== 'unreadable' && (e.origin === null || e.origin === originOf(newUrl))) return 'kept'
      await store.delete(name)
      scan = null
      return 'cleared'
    },
    invalidate() {
      scan = null
    }
  }
}
