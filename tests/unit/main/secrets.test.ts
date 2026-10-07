import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFileSecretStore, type SecretCipher } from '../../../src/main/secrets'

/** A reversible stand-in for safeStorage: XOR with a key, prefixed like Chromium's `v10`. */
function fakeCipher(o: { available?: boolean; rotate?: boolean } = {}): SecretCipher & { key: number } {
  const c = {
    key: 0x5a,
    available: () => o.available ?? true,
    encrypt: async (plain: string) => Buffer.concat([Buffer.from('v10'), Buffer.from(plain, 'utf8').map((b) => b ^ c.key)]),
    decrypt: async (buf: Buffer) => {
      if (buf.subarray(0, 3).toString() !== 'v10') throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      return { result: Buffer.from(buf.subarray(3).map((b) => b ^ c.key)).toString('utf8'), shouldReEncrypt: !!o.rotate }
    }
  }
  return c
}

let dir: string
let file: string
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vesper-secrets-'))
  file = path.join(dir, 'secrets.json')
})
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('file secret store', () => {
  it('round-trips and never writes plaintext', async () => {
    const s = createFileSecretStore(file, fakeCipher())
    await s.set('llm:openai', 'sk-test-1234567890abcdef')
    await s.set('tts:elevenlabs', 'el-key')
    expect(await s.get('llm:openai')).toBe('sk-test-1234567890abcdef')
    expect(await s.list()).toEqual(['llm:openai', 'tts:elevenlabs'])
    const raw = await fsp.readFile(file, 'utf8')
    expect(raw).not.toContain('sk-test')
    expect(Object.keys(JSON.parse(raw))).toEqual(['llm:openai', 'tts:elevenlabs'])
    // A fresh store (next launch) reads the same file.
    expect(await createFileSecretStore(file, fakeCipher()).get('tts:elevenlabs')).toBe('el-key')
  })

  it('returns null for unknown names and deletes', async () => {
    const s = createFileSecretStore(file, fakeCipher())
    expect(await s.get('nope')).toBeNull()
    await s.set('a', '1')
    await s.delete('a')
    expect(await s.list()).toEqual([])
    expect(await s.get('a')).toBeNull()
  })

  it('serializes concurrent writes', async () => {
    const s = createFileSecretStore(file, fakeCipher())
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.set(`k${i}`, `v${i}`)))
    const fresh = createFileSecretStore(file, fakeCipher())
    expect((await fresh.list()).length).toBe(20)
    expect(await fresh.get('k13')).toBe('v13')
  })

  it('reports an undecryptable entry without losing the others', async () => {
    await fsp.writeFile(file, JSON.stringify({ good: Buffer.from('v10').toString('base64'), bad: Buffer.from('garbage').toString('base64') }))
    const s = createFileSecretStore(file, fakeCipher())
    await expect(s.get('bad')).rejects.toMatchObject({ info: { code: 'secret_unreadable' } })
    expect(await s.get('good')).toBe('')
    expect(await s.list()).toEqual(['bad', 'good'])
  })

  it('refuses to save when OS encryption is unavailable (no plaintext fallback)', async () => {
    const s = createFileSecretStore(file, fakeCipher({ available: false }))
    expect(s.available()).toBe(false)
    await expect(s.set('a', 'b')).rejects.toMatchObject({ info: { code: 'secret_unreadable' } })
    await expect(fsp.access(file)).rejects.toThrow()
  })

  it('re-encrypts when the OS asks for it', async () => {
    const c = fakeCipher({ rotate: true })
    let encrypts = 0
    const encrypt = c.encrypt
    c.encrypt = async (plain) => {
      encrypts++
      return encrypt(plain)
    }
    const s = createFileSecretStore(file, c)
    await s.set('a', 'value')
    expect(encrypts).toBe(1)
    expect(await s.get('a')).toBe('value')
    expect(encrypts).toBe(2)
    expect(await createFileSecretStore(file, fakeCipher()).get('a')).toBe('value')
  })

  it('rejects names that are not identifiers', async () => {
    const s = createFileSecretStore(file, fakeCipher())
    for (const n of ['__proto__', '../x', '', 'a b', 'x'.repeat(200)]) {
      await expect(s.set(n, 'v'), n).rejects.toMatchObject({ info: { code: 'validation' } })
    }
  })

  it('moves a corrupt file aside instead of overwriting it', async () => {
    await fsp.writeFile(file, '{not json')
    const s = createFileSecretStore(file, fakeCipher())
    expect(await s.list()).toEqual([])
    await s.set('a', '1')
    const names = await fsp.readdir(dir)
    expect(names.some((n) => n.startsWith('secrets.json.corrupt-'))).toBe(true)
  })
})
