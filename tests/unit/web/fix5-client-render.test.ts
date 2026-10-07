/**
 * Phase 5b fix5-client regressions rendered through the real <Markdown> (react-dom server output). @R14
 */
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/web/features/chat/markdown/SessionChip', () => ({
  SessionChip: ({ children }: { children: unknown }) => createElement('a', { className: 'chip' }, children as never)
}))
vi.mock('../../../src/web/lib/router', () => ({ navigate: () => undefined }))
vi.mock('../../../src/web/lib/store', () => ({ useStore: () => undefined }))
const MARKDOWN = '../../../src/web/features/chat/markdown/Markdown.tsx'
const { Markdown } = (await import(/* @vite-ignore */ MARKDOWN)) as { Markdown: (p: { text: string; srcTags?: boolean }) => ReactNode }

const html = (text: string, srcTags = false): string => renderToStaticMarkup(createElement(Markdown, { text, srcTags }))

describe('P08 inline math renders as math; prices and code keep their dollars', () => {
  it('turns $…$, \\( \\) and \\[ \\] into formulas', () => {
    const out = html('Inline too: $e^{i\\pi}+1=0$, then \\( E = mc^2 \\) and \\[ \\frac{a}{b} \\]')
    // KaTeX loads lazily: until then each formula shows its TeX as pending math (not as raw text with delimiters).
    const formulas = [...out.matchAll(/class="md-math[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1])
    expect(formulas).toEqual(['e^{i\\pi}+1=0', 'E = mc^2', '\\frac{a}{b}'])
    expect(out).not.toContain('$e^')
    expect(out).not.toContain('\\(')
  })
  it('keeps prices, escaped dollars, code and links as written', () => {
    const out = html('It costs $5 and $10 with tax; run `echo $HOME`; see [the $5 deal](https://example.com/$5).')
    expect(out).toContain('It costs $5 and $10 with tax')
    expect(out).toContain('echo $HOME')
    expect(out).toContain('the $5 deal')
    expect(out).toContain('href="https://example.com/$5"')
    expect(out).not.toContain('\uE000')
    expect(out).not.toContain('md-math')
  })
  it('keeps the source offsets of held text (synced reveal)', () => {
    const text = 'Cost $5 and $x^2$ here.\n\nNext \\(y\\) para.'
    const out = html(text, true)
    expect(out).toContain('data-src-start="0" data-src-end="23"')
    expect(out).toContain(`data-src-start="25" data-src-end="${text.length}"`)
    expect(out).toContain('>Cost $5 and </span>')
  })
})
