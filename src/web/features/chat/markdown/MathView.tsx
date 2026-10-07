/**
 * Math (07 D7: KaTeX lazy). KaTeX and its CSS load on the first formula of the session; until then the TeX shows as
 * code. Options per 07 B8: trust:false, maxSize:10, maxExpand:1000, strict:'ignore', no throwing.
 */
import { useSyncExternalStore, type ReactNode } from 'react'

type Katex = typeof import('katex').default

let katex: Katex | null = null
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

/** Start loading KaTeX (idempotent). */
export function loadKatex(): Promise<void> {
  loading ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')])
    .then(([m]) => {
      katex = m.default
      for (const l of [...listeners]) l()
    })
    .catch(() => {
      // Offline chunk failure: keep showing the TeX source; a later formula retries.
      loading = null
    })
  return loading
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}
const ready = (): boolean => katex !== null

const cache = new Map<string, string>()
const CACHE_MAX = 300

function render(tex: string, display: boolean): string {
  const key = `${display ? 'D' : 'I'}${tex}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const html = (katex as Katex).renderToString(tex, { displayMode: display, throwOnError: false, trust: false, maxSize: 10, maxExpand: 1000, strict: 'ignore', output: 'htmlAndMathml' })
  cache.set(key, html)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
  return html
}

/** `block`: a display formula inside a paragraph (`\[…\]` written inline): typeset as display in a block-level span. */
export function MathView({ tex, display, block = false }: { tex: string; display: boolean; block?: boolean }): ReactNode {
  const loaded = useSyncExternalStore(subscribe, ready, ready)
  if (!loaded) {
    void loadKatex()
    return display ? (
      <pre className="md-math md-math--display md-math--pending">
        <code>{tex}</code>
      </pre>
    ) : (
      <code className="md-math md-math--pending">{tex}</code>
    )
  }
  // KaTeX output with trust:false is generated markup (input is escaped), the same thing rehype-katex inserts.
  const html = render(tex, display || block)
  if (block) return <span className="md-math md-math--display md-math--block" dangerouslySetInnerHTML={{ __html: html }} />
  return display ? (
    <div className="md-math md-math--display" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <span className="md-math" dangerouslySetInnerHTML={{ __html: html }} />
  )
}
