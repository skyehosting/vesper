/**
 * The reply renderer (07 D7 + B8). Text is split into top-level blocks (blocks.logic.ts); each block renders through
 * react-markdown without raw HTML (raw HTML shows as text), memoized by its source, so while a reply streams only the
 * open block re-renders. Every block-level element carries `data-src-start/-end` (offsets into the whole text) so
 * the synced reveal maps speech chunks onto the DOM exactly (07 C14); with `srcTags` (a held, spoken reply) every run
 * of text is wrapped in a `<span data-src-start data-src-end data-src-text>` too, so a chunk boundary inside a
 * paragraph is exact as well (F34). Code goes to the kit's CodeBlock (shiki in its
 * worker; plain while the fence is open), math to KaTeX (lazy), links/images through MdLink/MdImage.
 */
import { memo, useMemo, useRef, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import type { Element, ElementContent, Root } from 'hast'
import { CodeBlock } from '../../../components/CodeBlock'
import { splitBlocks, type BlockCache } from './blocks.logic'
import { isDisplaySource, normalizeMath, restoreDollars } from './math.logic'
import { urlTransform } from './links.logic'
import { MathView } from './MathView'
import { MdImage, MdLink } from './MdLink'
import { SessionChip } from './SessionChip'
import { remarkSessionIds, sessionIdOfHref } from './sessionIds.logic'
import './markdown.css'

const TAGGED = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'table', 'hr', 'ul', 'ol'])

/** Text inside these is not split by speech chunks (instant chunks, rendered from the node's own text). */
const NO_TEXT_TAGS = new Set(['pre', 'table'])

/**
 * rehype plugin: block-level elements get their source offsets (+ the block's base offset); with `textRuns`, every
 * positioned text run outside code, tables and math — blank ones too (`**A** *B*`: the space between is source text,
 * NEW-1) — is wrapped in a span carrying its own offsets (`data-src-text`). The newlines rehype puts between block
 * elements have no position and stay unwrapped.
 */
function rehypeSrcOffsets(base: number, textRuns: boolean) {
  return (tree: Root): void => {
    const walk = (n: Root | ElementContent, plain: boolean): void => {
      if (n.type === 'element') {
        const s = n.position?.start.offset
        const e = n.position?.end.offset
        if (TAGGED.has(n.tagName) && s !== undefined && e !== undefined) {
          n.properties = { ...n.properties, dataSrcStart: base + s, dataSrcEnd: base + e }
        }
      }
      if (!('children' in n)) return
      const inner = plain && !(n.type === 'element' && (NO_TEXT_TAGS.has(n.tagName) || classOf(n).some((c) => c.startsWith('math'))))
      n.children = (n.children as ElementContent[]).map((c): ElementContent => {
        const s = c.position?.start.offset
        const e = c.position?.end.offset
        if (textRuns && inner && c.type === 'text' && s !== undefined && e !== undefined && c.value) {
          return { type: 'element', tagName: 'span', properties: { dataSrcStart: base + s, dataSrcEnd: base + e, dataSrcText: '' }, children: [c] }
        }
        walk(c, inner)
        return c
      }) as typeof n.children
    }
    walk(tree, true)
  }
}

/**
 * rehype plugin for the math the block was normalized for (P08, math.logic.ts): the `$` placeholders go back to `$` in
 * text and link targets, and an inline formula written as `\[…\]` is marked for display.
 */
function rehypeMathSource(raw: string) {
  return (tree: Root): void => {
    const walk = (n: Root | ElementContent): void => {
      if (n.type === 'text') {
        n.value = restoreDollars(n.value)
        return
      }
      if (n.type !== 'element' && n.type !== 'root') return
      if (n.type === 'element') {
        for (const k of ['href', 'src', 'title', 'alt'] as const) {
          const v = n.properties?.[k]
          if (typeof v === 'string') n.properties[k] = restoreDollars(v)
        }
        const s = n.position?.start.offset
        if (s !== undefined && classOf(n).includes('math-inline') && isDisplaySource(raw, s)) n.properties = { ...n.properties, dataMathDisplay: '' }
      }
      for (const c of n.children as ElementContent[]) walk(c)
    }
    walk(tree)
  }
}

/** Raw HTML in a reply shows as text (react-markdown's default without rehype-raw), never as markup (07 B8). */
function hastText(n: Element | ElementContent): string {
  if (n.type === 'text') return n.value
  if (n.type === 'element') return n.children.map(hastText).join('')
  return ''
}

function classOf(n: Element | undefined): string[] {
  const c = n?.properties?.className
  if (Array.isArray(c)) return c.map(String)
  return typeof c === 'string' ? (c as string).split(/\s+/) : []
}

// Single-dollar math is on for the PARSER only: normalizeMath leaves a lone `$` (a price) as a placeholder (P08).
const REMARK = [remarkGfm, [remarkMath, { singleDollarTextMath: true }], remarkSessionIds] as const

function makeComponents(open: boolean): Components {
  return {
    a: ({ href, children }) => {
      // `#K7Q2MX` in the text (07 C18): a chip that opens that chat.
      const shortId = typeof href === 'string' ? sessionIdOfHref(href) : null
      return shortId ? <SessionChip shortId={shortId}>{children}</SessionChip> : <MdLink href={href}>{children}</MdLink>
    },
    img: ({ src, alt }) => <MdImage src={typeof src === 'string' ? src : ''} alt={alt} />,
    pre: ({ node, ...rest }) => {
      const code = node?.children.find((c): c is Element => c.type === 'element' && c.tagName === 'code')
      const cls = classOf(code)
      const value = code ? hastText(code) : ''
      const tag = { 'data-src-start': rest['data-src-start' as keyof typeof rest], 'data-src-end': rest['data-src-end' as keyof typeof rest] } as Record<string, unknown>
      if (cls.includes('math-display')) {
        return (
          <div className="md-math-wrap" {...tag}>
            <MathView tex={value} display />
          </div>
        )
      }
      const lang = cls.find((c) => c.startsWith('language-'))?.slice(9) ?? null
      const raw = code?.data && typeof code.data === 'object' && 'meta' in code.data ? String((code.data as { meta?: unknown }).meta ?? '') : ''
      return (
        <div className="md-code" {...tag}>
          <CodeBlock code={value} lang={raw ? `${lang ?? ''} ${raw}`.trim() : lang} streaming={open} />
        </div>
      )
    },
    code: ({ node, children }) => {
      if (classOf(node).includes('math-inline')) return <MathView tex={node ? hastText(node).trim() : ''} display={false} block={node?.properties?.dataMathDisplay !== undefined} />
      return <code className="md-inline-code">{children}</code>
    },
    table: ({ node: _node, children, ...rest }) => (
      <div className="md-table" tabIndex={0} role="region" aria-label="Table">
        <table {...rest}>{children}</table>
      </div>
    ),
    input: ({ node: _node, ...rest }) => <input {...rest} disabled aria-label={rest.checked ? 'Done' : 'Not done'} />
  }
}

const COMPONENTS_OPEN = makeComponents(true)
const COMPONENTS_CLOSED = makeComponents(false)

interface BlockProps {
  raw: string
  base: number
  /** The block is still streaming (its code fence may be open). */
  open: boolean
  /** Tag every text run with its source offsets (a held, spoken reply). */
  textRuns: boolean
}

const MdBlockView = memo(function MdBlockView({ raw, base, open, textRuns }: BlockProps): ReactNode {
  const rehype = useMemo(() => [() => rehypeSrcOffsets(base, textRuns), () => rehypeMathSource(raw)], [base, textRuns, raw])
  // Same length as `raw` (math.logic.ts), so every source offset still points into the reply's text.
  const md = useMemo(() => normalizeMath(raw), [raw])
  return (
    <ReactMarkdown remarkPlugins={REMARK as never} rehypePlugins={rehype} components={open ? COMPONENTS_OPEN : COMPONENTS_CLOSED} urlTransform={urlTransform as never}>
      {md}
    </ReactMarkdown>
  )
})

export interface MarkdownProps {
  text: string
  /** The text is still growing (a streaming reply): re-parse only the tail; the last block counts as open. */
  streaming?: boolean
  className?: string
  /** Also tag each run of text with its source offsets (the synced reveal of a held reply, F34). */
  srcTags?: boolean
}

/** Rendered markdown. Block elements carry `data-src-*` offsets into `text`. */
export function Markdown({ text, streaming = false, className, srcTags = false }: MarkdownProps): ReactNode {
  const cache = useRef<BlockCache | null>(null)
  const blocks = useMemo(() => {
    const b = splitBlocks(text, streaming ? cache.current : null)
    cache.current = { text, blocks: b }
    return b
  }, [text, streaming])
  return (
    <div className={className ? `md ${className}` : 'md'}>
      {blocks.map((b, i) => {
        const last = i === blocks.length - 1
        return <MdBlockView key={b.start} raw={text.slice(b.start, b.end)} base={b.start} open={streaming && last && (b.kind !== 'code' || !b.closed)} textRuns={srcTags} />
      })}
    </div>
  )
}
