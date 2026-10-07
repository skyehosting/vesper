/**
 * Link and image rules for rendered replies (07 B8, research 03 §5.2): only http/https/mailto and in-app links
 * survive; images render only from our attachments, blob: or data:image URLs (the CSP allows nothing else), remote
 * images become a chip; links show their real host when the text says something else; loopback/private hosts and
 * long query strings ask before opening.
 */

const SAFE_DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp|avif);/i

/** In-app path: "/s/…", "/settings…" — one leading slash, never protocol-relative "//host". */
export function isAppPath(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\')
}

/**
 * The exact forms the app itself renders (parts.tsx `attUrl`): `/api/attachments/<sha-256 hex>` with an optional
 * `?thumb=1`. Matched against the raw string, never a prefix: the browser resolves dot-segments (also `%2e`), strips
 * tabs/newlines and treats `\` as `/`, so "/api/attachments/../export" would fetch another route as the owner (F10).
 */
const ATTACHMENT_SRC = /^\/api\/attachments\/[0-9a-f]{64}(?:\?thumb=1)?$/

export function isLocalImageSrc(url: string): boolean {
  return ATTACHMENT_SRC.test(url) || url.startsWith('blob:') || SAFE_DATA_IMAGE.test(url)
}

/**
 * react-markdown `urlTransform`: '' drops the URL. Images keep remote http(s) so the renderer can name the host in
 * its chip (it never loads them).
 */
export function urlTransform(url: string, key: string, node: { tagName?: string }): string {
  const u = url.trim()
  if (node.tagName === 'img' && key === 'src') {
    if (isLocalImageSrc(u)) return u
    return /^https?:\/\//i.test(u) ? u : ''
  }
  if (u.startsWith('#')) return u
  if (isAppPath(u)) return u
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(u)?.[1]?.toLowerCase()
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return u
  return ''
}

export function parseUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/** Host without a leading "www.", for display. */
export function displayHost(u: URL): string {
  return u.hostname.replace(/^www\./, '')
}

function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  return parts.every((p) => p <= 255) ? parts : null
}

/**
 * Loopback, private, link-local or otherwise local-network hosts (07 B8: confirm before opening). A trailing root dot
 * names the same host ("localhost." and "router.lan." resolve like "localhost" and "router.lan"), so it is dropped first.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return true
  if (host.includes(':')) {
    // IPv6 (URL parsing has already canonicalised it): loopback, unspecified, unique-local, link-local, and IPv4-mapped
    // or IPv4-compatible forms of a private IPv4 address ("::ffff:7f00:1" is 127.0.0.1).
    if (host === '::1' || host === '::' || /^f[cd]|^fe[89ab]/.test(host)) return true
    const mapped = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
    if (mapped) {
      const hi = parseInt(mapped[1], 16)
      const lo = parseInt(mapped[2], 16)
      return isPrivateHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
    }
    return false
  }
  const ip = ipv4(host)
  if (!ip) return !host.includes('.') // single-label names resolve on the local network
  const [a, b] = ip
  return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
}

export const LONG_QUERY = 120
/** Longer paths, fragments or host labels than this carry data rather than name a page (F13, beyond B8's query rule). */
export const LONG_PATH = 200
export const LONG_LABEL = 40

/** Why opening this http(s) URL needs a confirm first, or null (07 B8: private hosts, look-alikes, long data). */
export function urlRisk(u: URL): string | null {
  const labels = u.hostname.split('.')
  if (isPrivateHost(u.hostname)) return `${u.hostname} is on this computer or your local network.`
  if (labels.some((l) => l.startsWith('xn--'))) return `${u.hostname} uses look-alike characters.`
  if (u.search.length > LONG_QUERY || u.hash.length > LONG_QUERY || u.pathname.length > LONG_PATH || labels.some((l) => l.length > LONG_LABEL))
    return 'This link carries a long string of data in its address.'
  if (u.username || u.password) return 'This link contains a user name.'
  return null
}

/** The extra warning for a remote image's "Open in browser" (same checks as links), or null. */
export function remoteImageRisk(src: string): string | null {
  const u = parseUrl(src)
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return null
  return urlRisk(u)
}

export interface LinkInfo {
  kind: 'app' | 'external' | 'mailto' | 'anchor' | 'invalid'
  url: URL | null
  host: string | null
  /** Show the real host next to the text (the text names something else). */
  showHost: boolean
  /** Ask before opening (private host, long query string, look-alike punycode host). */
  risky: string | null
}

/** Host as compared: lower-case ASCII (punycode, as URL parsing yields), no "www.", no trailing root dot. */
function hostKey(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '')
}

/** The host a word of link text names when it is a URL or a domain ("https://a.b/x", "a.b", "a.b/x"), else null. */
function tokenHost(token: string): string | null | 'userinfo' {
  let t = token
  for (let prev = ''; prev !== t; ) {
    prev = t
    t = t.replace(/^[("'<[“‘«]+/, '').replace(/[)"'>\]”’».,;:!?]+$/, '')
  }
  if (!t) return null
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t)
  if (!scheme && !/^[^\s/@:]+\.[^\s/@:]*[^\s/@:.](?:[:/?#]|$)/.test(t)) return null
  const p = parseUrl(scheme ? t : `https://${t}`)
  if (!p || (p.protocol !== 'http:' && p.protocol !== 'https:')) return null
  if (p.username || p.password) return 'userinfo'
  return hostKey(p.hostname)
}

/**
 * Whether the link text already names the destination's host (07 B8: otherwise the real host is shown). Hosts are
 * compared after URL parsing — never as string prefixes or substrings (F11: "https://bank.com" must not name
 * "bank.com.evil.example", nor "h" every http URL). Text whose URL carries a user name ("https://bank.com@evil.example")
 * never names its host. A single-label host ("nas") is named only by the whole text.
 */
function textNames(text: string, u: URL): boolean {
  const t = text.trim()
  if (!t) return false
  const host = hostKey(u.hostname)
  if (t.toLowerCase() === host) return true
  let named = false
  for (const word of t.split(/\s+/)) {
    const h = tokenHost(word)
    if (h === 'userinfo') return false
    if (h === host) named = true
  }
  return named
}

export function linkInfo(href: string, text: string): LinkInfo {
  if (!href) return { kind: 'invalid', url: null, host: null, showHost: false, risky: null }
  if (href.startsWith('#')) return { kind: 'anchor', url: null, host: null, showHost: false, risky: null }
  if (isAppPath(href)) return { kind: 'app', url: null, host: null, showHost: false, risky: null }
  const u = parseUrl(href)
  if (!u) return { kind: 'invalid', url: null, host: null, showHost: false, risky: null }
  if (u.protocol === 'mailto:') return { kind: 'mailto', url: u, host: null, showHost: false, risky: null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { kind: 'invalid', url: null, host: null, showHost: false, risky: null }
  return { kind: 'external', url: u, host: displayHost(u), showHost: !textNames(text, u), risky: urlRisk(u) }
}
