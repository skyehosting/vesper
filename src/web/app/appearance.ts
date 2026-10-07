/**
 * Apply appearance settings to <html>: data-theme, data-accent, data-reduce-motion and the message font size, plus
 * the browser's theme-color. The last applied values are cached per device so the next load paints in the right
 * theme before the bootstrap request returns (no inline script needed — the CSP forbids one).
 */
import type { PublicSettings } from '@shared/settings'

export interface Appearance {
  theme: 'dark' | 'light' | 'system'
  accent: string
  reduceMotion: boolean
  fontSize: number
}

const KEY = 'vesper.appearance'
let mql: MediaQueryList | null = null

export function appearanceOf(s: PublicSettings): Appearance {
  return { theme: s.appearance.theme, accent: s.appearance.accent, reduceMotion: s.appearance.reduceMotion, fontSize: s.chat.fontSize }
}

function syncThemeColor(): void {
  const css = getComputedStyle(document.documentElement)
  const color = css.getPropertyValue('--theme-color').trim()
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (meta && color) meta.content = color
  // The native caption buttons (titleBarOverlay) don't follow CSS: the desktop window is told on every theme change,
  // including a 'system' theme following Windows (the top bar's background is --theme-color in both themes).
  const symbol = css.getPropertyValue('--text-0').trim()
  if (color && symbol) window.vesperDesktop?.setTitleBarOverlay?.({ color, symbolColor: symbol })
}

export function applyAppearance(a: Appearance, opts: { persist?: boolean } = {}): void {
  const root = document.documentElement
  root.dataset.theme = a.theme
  root.dataset.accent = a.accent
  root.dataset.reduceMotion = String(a.reduceMotion)
  root.style.setProperty('--msg-fs', `${Math.min(20, Math.max(13, a.fontSize))}px`)
  syncThemeColor()
  if (!mql) {
    mql = window.matchMedia('(prefers-color-scheme: light)')
    mql.addEventListener('change', syncThemeColor)
  }
  if (opts.persist !== false) {
    try {
      localStorage.setItem(KEY, JSON.stringify(a))
    } catch {
      // private mode: no cache, the first paint is just dark
    }
  }
}

export function applyCachedAppearance(): void {
  if (window.vesperDesktop) document.documentElement.classList.add('is-desktop')
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return
    const a = JSON.parse(raw) as Partial<Appearance>
    if (a.theme !== 'dark' && a.theme !== 'light' && a.theme !== 'system') return
    applyAppearance(
      { theme: a.theme, accent: typeof a.accent === 'string' ? a.accent : 'gold', reduceMotion: !!a.reduceMotion, fontSize: Number(a.fontSize) || 15 },
      { persist: false }
    )
  } catch {
    // ignore a corrupt cache
  }
}
