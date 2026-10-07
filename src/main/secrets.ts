/**
 * The Platform SecretStore over Electron safeStorage (research 06 §6, 07 B1): `<dataDir>\secrets.json` maps each name
 * to the base64 of its own ciphertext, so one undecryptable entry (DPAPI loss after a profile copy or password reset)
 * never takes the others with it. Values never touch disk or logs in plaintext and there is no plaintext fallback.
 * The cipher is injected so the store is unit-testable without Electron (tests/unit/main/secrets.test.ts).
 */
import { promises as fsp } from 'node:fs'
import { VesperError } from '@shared/errors'
import type { SecretStore } from '@server/platform'
import { writeFileAtomic } from './jsonFile'

export interface SecretCipher {
  /** False before app `ready` or when the OS offers no encryption. */
  available(): boolean
  encrypt(plain: string): Promise<Buffer>
  decrypt(cipher: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}

/** Names are identifiers (`llm:openai`, `tts:elevenlabs`, `tls.key`): never paths, never `__proto__`. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/

function checkName(name: string): void {
  if (typeof name !== 'string' || !NAME.test(name)) throw new VesperError('validation', { message: 'Invalid secret name.' })
}

export function createFileSecretStore(file: string, cipher: SecretCipher, log?: (msg: string) => void): SecretStore {
  let entries: Map<string, string> | null = null
  /** Every read-modify-write runs in this chain, so concurrent `set`s never lose each other's entries. */
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => undefined)
    return next
  }

  async function load(): Promise<Map<string, string>> {
    if (entries) return entries
    const map = new Map<string, string>()
    let raw: string | null = null
    try {
      raw = await fsp.readFile(file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    if (raw != null) {
      try {
        const parsed = JSON.parse(raw) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (NAME.test(k) && typeof v === 'string' && v.length > 0) map.set(k, v)
        }
      } catch {
        // Keep the unreadable file for the owner instead of overwriting it on the next save.
        const aside = `${file}.corrupt-${Date.now()}`
        await fsp.rename(file, aside).catch(() => undefined)
        log?.(`secrets file unreadable; moved aside to ${aside}`)
      }
    }
    entries = map
    return map
  }

  /** Write `next`, and only then make it the current state — a failed write leaves memory and disk in agreement. */
  async function commit(next: Map<string, string>): Promise<void> {
    await writeFileAtomic(file, JSON.stringify(Object.fromEntries(next), null, 2))
    entries = next
  }

  return {
    available: () => cipher.available(),

    list: () => serial(async () => [...(await load()).keys()].sort()),

    get: (name) =>
      serial(async () => {
        checkName(name)
        const map = await load()
        const stored = map.get(name)
        if (!stored) return null
        let out: { result: string; shouldReEncrypt: boolean }
        try {
          out = await cipher.decrypt(Buffer.from(stored, 'base64'))
        } catch {
          throw new VesperError('secret_unreadable')
        }
        if (out.shouldReEncrypt && cipher.available()) {
          // The OS rotated its key: store the value under the current one (best effort; the old one still works).
          try {
            const next = new Map(map)
            next.set(name, (await cipher.encrypt(out.result)).toString('base64'))
            await commit(next)
          } catch {
            log?.(`re-encrypting secret "${name}" failed`)
          }
        }
        return out.result
      }),

    set: (name, value) =>
      serial(async () => {
        checkName(name)
        if (typeof value !== 'string') throw new VesperError('validation')
        if (!cipher.available()) {
          throw new VesperError('secret_unreadable', { message: "Windows encryption isn't available, so keys can't be saved." })
        }
        const next = new Map(await load())
        next.set(name, (await cipher.encrypt(value)).toString('base64'))
        await commit(next)
      }),

    delete: (name) =>
      serial(async () => {
        checkName(name)
        const next = new Map(await load())
        if (next.delete(name)) await commit(next)
      })
  }
}
