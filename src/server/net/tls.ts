/**
 * Listener B's certificate (research 06 §4, 07 B10/D8): selfsigned 5.5.0, EC P-256 with SHA-256 (the library defaults
 * to SHA-1), leaf profile Apple accepts (SAN names, EKU serverAuth, ≤ 397 days). `tls/lan-cert.pem` sits in the roaming
 * data dir; the private key is stored only through the platform secret store (safeStorage ciphertext) under an
 * internal name. The certificate is stable: it is regenerated only when a needed name is missing from its SANs, the
 * key no longer matches, or it expires within 30 days — phones then accept the warning once, not on every start.
 */
import { createPrivateKey, X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { generate } from 'selfsigned'
import type { SecretStore } from '../platform'
import type { Log } from '../services'
import { INTERNAL_SECRET_PREFIX } from '../settings/secrets'

export const TLS_KEY_SECRET = `${INTERNAL_SECRET_PREFIX}tls-lan-key`
const VALID_DAYS = 397
const RENEW_BEFORE_MS = 30 * 86_400_000

export interface LanCert {
  cert: string
  key: string
  fingerprint256: string
  sans: string[]
  notAfterUtc: number
}

/** SAN entries as `DNS:x` / `IP:y` (the form X509Certificate.subjectAltName uses, with "IP Address" shortened). */
export function wantedSans(o: { hostname: string; addresses: string[] }): string[] {
  const host = o.hostname.toLowerCase().replace(/[^a-z0-9-]/g, '')
  const dns = ['localhost', ...(host ? [host, `${host}.local`] : [])]
  const ips = ['127.0.0.1', ...o.addresses.filter((a) => a !== '0.0.0.0')]
  return [...new Set([...dns.map((d) => `DNS:${d}`), ...ips.map((i) => `IP:${i}`)])]
}

export function sansOf(x: X509Certificate): string[] {
  return (x.subjectAltName ?? '')
    .split(/,\s*/)
    .filter(Boolean)
    .map((s) => s.replace(/^IP Address:/, 'IP:'))
}

export async function generateLanCert(sans: string[], now: number): Promise<{ cert: string; key: string }> {
  const altNames = sans.map((s) => (s.startsWith('IP:') ? { type: 7 as const, ip: s.slice(3) } : { type: 2 as const, value: s.slice(4) }))
  const r = await generate([{ name: 'commonName', value: 'Vesper' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate: new Date(now - 60_000),
    notAfterDate: new Date(now + VALID_DAYS * 86_400_000),
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames }
    ]
  })
  return { cert: r.cert, key: r.private }
}

function describe(cert: string, key: string): LanCert | null {
  try {
    const x = new X509Certificate(cert)
    if (!x.checkPrivateKey(createPrivateKey(key))) return null
    return { cert, key, fingerprint256: x.fingerprint256, sans: sansOf(x), notAfterUtc: Date.parse(x.validTo) }
  } catch {
    return null
  }
}

export interface CertManager {
  /** A certificate covering `sans`, loading or (re)generating as needed. */
  ensure(sans: string[], now: number): Promise<LanCert>
  /** The certificate in use (or on disk) without generating, for status. */
  current(): LanCert | null
}

export function createCertManager(o: { dir: string; secrets: SecretStore; log: Log; generate?: typeof generateLanCert }): CertManager {
  const file = path.join(o.dir, 'tls', 'lan-cert.pem')
  const gen = o.generate ?? generateLanCert
  let cached: LanCert | null = null
  let loaded = false

  async function load(): Promise<LanCert | null> {
    if (loaded) return cached
    loaded = true
    let cert: string
    try {
      cert = await fs.promises.readFile(file, 'utf8')
    } catch {
      return null
    }
    let key: string | null = null
    try {
      key = await o.secrets.get(TLS_KEY_SECRET)
    } catch (e) {
      // DPAPI loss (profile copied, password reset): a new certificate is the only fix; phones re-accept it once.
      o.log.warn('LAN TLS key is unreadable; a new certificate will be made', { error: String(e) })
    }
    cached = key ? describe(cert, key) : null
    return cached
  }

  return {
    async ensure(sans, now) {
      const have = await load()
      if (have && sans.every((s) => have.sans.includes(s)) && have.notAfterUtc - now > RENEW_BEFORE_MS) return have
      const t0 = Date.now()
      const { cert, key } = await gen(sans, now)
      const next = describe(cert, key)
      if (!next) throw new Error('generated certificate does not verify')
      if (o.secrets.available()) {
        await o.secrets.set(TLS_KEY_SECRET, key)
        await fs.promises.mkdir(path.dirname(file), { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        await fs.promises.writeFile(tmp, cert)
        await fs.promises.rename(tmp, file)
      } else {
        // No encrypted store (plain-Node server outside tests): the key lives in memory only and never touches disk.
        o.log.warn('no secret store: the LAN certificate is temporary for this run')
      }
      o.log.info('LAN certificate created', { sans: next.sans.length, ms: Date.now() - t0 })
      cached = next
      return next
    },
    current: () => cached
  }
}
