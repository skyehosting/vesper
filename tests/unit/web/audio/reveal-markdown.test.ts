/**
 * F34 / NEW-1: chunk boundaries over the REAL held-reply DOM shape. A reply rendered by <Markdown srcTags> (react-dom
 * server output, parsed here) is indexed exactly as HighlightRevealController.rebuild() does (collectBlocks), chunked
 * by the real server SpeechDocument, and segmented: every chunk's rendered range must hold exactly its own words.
 * The cases put a boundary right on a run edge (a sentence ending just before **bold**, `code` or a link) with inline
 * pairs (`a` `b`, **A** *B*, [x](u) [y](v)) and a #K7Q2MX chip elsewhere in the same paragraph. @R14
 */
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SpeechDocument } from '@server/speech/segmenter'
import { collectBlocks, segmentChunks, sourceWords, wordsOf, type ChunkInfo, type TextPiece } from '../../../../src/web/lib/audio/reveal.logic'

// The chip resolves ids over the API; here it renders its text (as it does for an unknown id).
vi.mock('../../../../src/web/features/chat/markdown/SessionChip', () => ({
  SessionChip: ({ children }: { children: unknown }) => createElement('a', { className: 'chip' }, children as never)
}))
// The link components import the app router and store, which need a browser at load (no DOM in unit tests).
vi.mock('../../../../src/web/lib/router', () => ({ navigate: () => undefined }))
vi.mock('../../../../src/web/lib/store', () => ({ useStore: () => undefined }))
// A .tsx module (outside the node typecheck project): imported by a computed path, typed by hand.
const MARKDOWN = '../../../../src/web/features/chat/markdown/Markdown.tsx'
const { Markdown } = (await import(/* @vite-ignore */ MARKDOWN)) as { Markdown: (p: { text: string; srcTags?: boolean }) => ReactNode }

interface El {
  attrs: Record<string, string>
  parent: El | null
}

const VOID = new Set(['img', 'br', 'hr', 'input', 'meta', 'link'])

function decode(s: string): string {
  return s.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[e.toLowerCase()]
  )
}

/** Text nodes of static markup in document order, with their nearest data-src-start ancestor (rebuild()'s walk). */
function pieces(html: string): { text: string; pieces: TextPiece<El>[]; texts: string[] } {
  const out: TextPiece<El>[] = []
  const texts: string[] = []
  let text = ''
  let cur: El | null = null
  let skip = 0
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[5] !== undefined) {
      if (skip) continue
      const data = decode(m[5])
      let owner: El | null = cur
      while (owner && owner.attrs['data-src-start'] === undefined) owner = owner.parent
      out.push({ owner, srcStart: Number(owner?.attrs['data-src-start']), srcEnd: Number(owner?.attrs['data-src-end']), run: owner?.attrs['data-src-text'] !== undefined, length: data.length })
      texts.push(data)
      text += data
      continue
    }
    const tag = m[2].toLowerCase()
    if (m[1]) {
      const open = cur as El | null
      if (open && 'skip' in open.attrs) skip--
      cur = open?.parent ?? null
      continue
    }
    const attrs: Record<string, string> = {}
    for (const a of m[3].matchAll(/([^\s=>/]+)(?:="([^"]*)")?/g)) attrs[a[1]] = decode(a[2] ?? '')
    if (VOID.has(tag) || m[4]) continue
    const el: El = { attrs: 'data-reveal-skip' in attrs ? { ...attrs, skip: '' } : attrs, parent: cur }
    if ('data-reveal-skip' in attrs) skip++
    cur = el
  }
  return { text, pieces: out, texts }
}

function check(md: string): void {
  const html = renderToStaticMarkup(createElement(Markdown, { text: md, srcTags: true }))
  const { text, pieces: ps, texts } = pieces(html)
  // Every piece of source text is its own run with exact offsets; only the generated newlines between blocks are not.
  ps.forEach((p, i) => {
    if (!p.run) expect(texts[i]).toMatch(/^\n*$/)
    else if (p.srcEnd - p.srcStart === p.length) expect(md.slice(p.srcStart, p.srcEnd)).toBe(texts[i])
  })
  const blocks = collectBlocks(ps)
  const doc = new SpeechDocument({})
  const planned = [...doc.push(md), ...doc.end(md)]
  expect(planned.length).toBeGreaterThan(1)
  const infos: ChunkInfo[] = planned.map((p, i) => ({ index: p.index, src: p.src, spoken: p.spoken, instant: p.instant, final: i === planned.length - 1, text: md.slice(p.src[0], p.src[1]) }))
  const ranges = segmentChunks(text, wordsOf(text), blocks, infos)
  const got = ranges.map(([s, e]) => wordsOf(text.slice(s, e)).norm.join(' '))
  const want = infos.map((c) => sourceWords(c.text as string).join(' '))
  expect(got).toEqual(want)
}

describe('chunk boundaries over the rendered held reply (F34, NEW-1) @R14', () => {
  const cases: Array<[string, string]> = [
    ['before **bold**, a `code` pair after it', 'This first sentence is long enough to count as one. **Second** sentence has `alpha` `beta` codes in it and keeps going a while. Third sentence ends this paragraph.'],
    ['before **bold**, a **A** *B* pair before it', 'Use **alpha** *beta* to start, and this first sentence is long enough to be a chunk now. **Next** sentence has more words in it to follow along. And the last one closes it.'],
    ['before `code`, a `a` `b` pair before it', 'Run `one` `two` first and then this opening sentence is long enough to stand alone. `three` is the next command you will type after it. Done with that.'],
    ['before a link, a link pair before it', 'See [this](https://a.example/x) [that](https://b.example/y) page and this first sentence is long enough to count. [Another](https://c.example/z) link opens the second sentence here. The end.'],
    ['a newline between inline elements', 'Here is **bold**\n*italic* text and this first sentence is long enough to be one chunk. **Second** sentence follows with several more words in it. Bye now.'],
    ['a #K7Q2MX chip in the paragraph', 'We talked about this in #K7Q2MX last week and that sentence is long enough. **Then** the next sentence starts with bold text in it, see #A1B2C3 too. Final words.'],
    ['chips around a run, before the boundary', 'See #K7Q2MX **and** #A1B2C3 for this, the opening sentence is long enough to count. **Next** sentence comes with more words to follow along here. The end.'],
    ['a sentence ending inside **bold**, then *italic*', 'This opening sentence is long enough to be spoken **as one chunk.** *Next* comes the second sentence with more words in it. The end is here.'],
    ['a sentence ending inside a link, then `code`', 'The opening sentence is long enough and it ends [in a link.](https://a.example/) `code` starts the second sentence with words. The end is here.'],
    ['a chip right after the boundary', 'This opening sentence is long enough to be spoken as a chunk alone. #K7Q2MX has the details you asked about the other day. Thanks again.']
  ]
  for (const [name, md] of cases) it(name, () => check(md))

  it('a #K7Q2MX chip is a run with its own source offsets', () => {
    const md = 'Ask about #K7Q2MX and\n#A1B2C3 later.'
    const { pieces: ps, texts } = pieces(renderToStaticMarkup(createElement(Markdown, { text: md, srcTags: true })))
    const chips = ps.filter((_, i) => /^#/.test(texts[i]))
    expect(chips.map((p) => md.slice(p.srcStart, p.srcEnd))).toEqual(['#K7Q2MX', '#A1B2C3'])
    expect(chips.every((p) => p.run)).toBe(true)
  })
})
