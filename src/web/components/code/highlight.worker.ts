/**
 * Syntax highlighting off the main thread (07 D7): shiki core + the JavaScript regex engine (no WASM), grammars and
 * the two themes loaded on first use. Returns compact tokens with a dark and a light color each, so the page can switch
 * theme without re-highlighting. Messages: {id, code, lang} → {id, lines} | {id, error}.
 */
import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { LANG_LOADERS } from './langs'
import type { HlRequest, HlResponse, HlToken } from './protocol'

const DARK = 'rose-pine-moon'
const LIGHT = 'rose-pine-dawn'

let core: Promise<HighlighterCore> | null = null
const loaded = new Set<string>()

function highlighter(): Promise<HighlighterCore> {
  core ??= createHighlighterCore({
    themes: [import('@shikijs/themes/rose-pine-moon'), import('@shikijs/themes/rose-pine-dawn')],
    langs: [],
    engine: createJavaScriptRegexEngine()
  })
  return core
}

async function tokens(code: string, lang: string): Promise<HlToken[][]> {
  const hl = await highlighter()
  if (!loaded.has(lang)) {
    const load = LANG_LOADERS[lang]
    if (!load) throw new Error(`unsupported language ${lang}`)
    await hl.loadLanguage((await load()).default)
    loaded.add(lang)
  }
  const lines = hl.codeToTokensWithThemes(code, { lang, themes: { dark: DARK, light: LIGHT } })
  return lines.map((line) =>
    line.map((t) => {
      const d = t.variants.dark ?? {}
      const l = t.variants.light ?? {}
      const out: HlToken = { t: t.content }
      if (d.color) out.d = d.color
      if (l.color) out.l = l.color
      const fs = d.fontStyle ?? l.fontStyle ?? 0
      if (fs > 0) out.s = fs
      return out
    })
  )
}

/** The worker global, typed minimally (the web tsconfig has DOM types, not WebWorker ones). */
const scope = self as unknown as { onmessage: ((e: MessageEvent<HlRequest>) => void) | null; postMessage(m: HlResponse): void }
scope.onmessage = (e: MessageEvent<HlRequest>) => {
  const { id, code, lang } = e.data
  tokens(code, lang).then(
    (lines) => scope.postMessage({ id, lines } satisfies HlResponse),
    (err: unknown) => scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies HlResponse)
  )
}
