/**
 * The one loopback rule (F19/F20): a host is "this PC" only when it is an IPv4 loopback literal (127.x.y.z), ::1
 * (also the IPv4-mapped ::ffff:127.x.y.z, which URL parsing writes as ::ffff:7f00:1), localhost or a *.localhost
 * name. A DNS name that merely starts with "127." (127.voice-cloud.net, 127.0.0.1.example.com), a LAN or tailnet
 * machine, a public server — even this PC's own LAN address — is another computer (the safe direction). Used by the
 * privacy texts and the base-URL rules so they never disagree.
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true
  if (/^127(?:\.\d{1,3}){3}$/.test(h)) return true
  const mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(h)
  return !!mapped && parseInt(mapped[1], 16) >> 8 === 127
}

/** A loopback http(s) URL (see isLoopbackHost). Not a URL → false. */
export function isLoopbackUrl(u: string): boolean {
  try {
    return isLoopbackHost(new URL(u).hostname)
  } catch {
    return false
  }
}
