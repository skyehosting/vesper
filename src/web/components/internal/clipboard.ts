/**
 * Copy text to the clipboard. `navigator.clipboard` exists only in secure contexts (desktop, vesper.localhost, LAN
 * HTTPS, Tailscale) — research 03 §5.3 — so anything else falls back to a hidden textarea + execCommand('copy').
 * Resolves false when both fail (the UI then says so instead of claiming success).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Permission denied or document not focused: try the legacy path.
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '-1000px'
  ta.style.opacity = '0'
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  active?.focus({ preventScroll: true })
  return ok
}
