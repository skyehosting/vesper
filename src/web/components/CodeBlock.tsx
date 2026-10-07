/**
 * CodeBlock (04: language label + copy; 07 D7) — the shell chat-ui renders fenced code in. While a fence is still
 * streaming it is plain `<pre>`; once closed it is highlighted in a Web Worker (shiki, lazy grammars, cached by
 * content hash) and repainted in place. Tokens carry both theme colors, so switching dark/light costs nothing. Copy
 * copies the raw code, not the DOM.
 *
 *   <CodeBlock code={node.value} lang={node.lang} streaming={!closed} />
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { WrapText } from 'lucide-react'
import { CopyButton } from './CopyButton'
import { IconButton } from './IconButton'
import { cachedHighlight, highlight, type HlLines } from './code/highlighter'
import { langLabel } from './code/langs.logic'
import { cx } from './internal/cx'
import './CodeBlock.css'

export interface CodeBlockProps {
  code: string
  /** The fence info string ("ts", "python title=x.py"); unknown/empty → plain text. */
  lang?: string | null
  /** The fence is still open: don't highlight yet. */
  streaming?: boolean
  /** Shown before the language (a file name). */
  title?: string
  lineNumbers?: boolean
  /** Start wrapped (the user can toggle). */
  wrap?: boolean
  /** Scroll vertically beyond this height (px). */
  maxHeight?: number
  className?: string
}

/** Strip one trailing newline (fences end with one) so there's no empty last line. */
const trimEnd = (s: string): string => (s.endsWith('\n') ? s.slice(0, -1) : s)

function Highlighted({ lines, lineNumbers }: { lines: HlLines; lineNumbers: boolean }): ReactNode {
  return (
    <>
      {lines.map((line, i) => (
        <span key={i} className="code-line">
          {lineNumbers ? <span className="code-ln" aria-hidden="true" data-n={i + 1} /> : null}
          {line.map((t, j) =>
            t.d || t.l || t.s ? (
              <span
                key={j}
                className={cx('tok', t.s && t.s & 1 && 'tok--i', t.s && t.s & 2 && 'tok--b', t.s && t.s & 4 && 'tok--u')}
                style={{ '--d': t.d, '--l': t.l } as CSSProperties}
              >
                {t.t}
              </span>
            ) : (
              t.t
            )
          )}
          {i < lines.length - 1 ? '\n' : null}
        </span>
      ))}
    </>
  )
}

export function CodeBlock({ code, lang, streaming = false, title, lineNumbers = false, wrap: wrapInit = false, maxHeight, className }: CodeBlockProps): ReactNode {
  const text = trimEnd(code)
  const [lines, setLines] = useState<HlLines | undefined>(() => (streaming ? undefined : cachedHighlight(text, lang)))
  const [wrap, setWrap] = useState(wrapInit)

  useEffect(() => {
    if (streaming) {
      setLines(undefined)
      return
    }
    const hit = cachedHighlight(text, lang)
    if (hit) {
      setLines(hit)
      return
    }
    let live = true
    void highlight(text, lang).then((l) => {
      if (live) setLines(l ?? undefined)
    })
    return () => {
      live = false
    }
  }, [text, lang, streaming])

  const label = langLabel(lang)
  return (
    <figure className={cx('code-block', wrap && 'is-wrapped', lineNumbers && 'has-line-numbers', className)} data-highlighted={lines ? '' : undefined}>
      {/* UI chrome, not reply text: the synced reveal (07 C14) skips it. */}
      <figcaption className="code-block__head" data-reveal-skip="">
        <span className="code-block__lang">
          {title ? <span className="code-block__title">{title}</span> : null}
          {label}
        </span>
        <span className="code-block__tools">
          <IconButton size="sm" label={wrap ? 'Don’t wrap lines' : 'Wrap lines'} icon={<WrapText />} pressed={wrap} onClick={() => setWrap(!wrap)} />
          <CopyButton text={text} label="Copy code" />
        </span>
      </figcaption>
      <pre className="code-block__pre" style={maxHeight ? { maxHeight } : undefined} tabIndex={0} aria-label={`${label} code`}>
        <code>{lines && !streaming ? <Highlighted lines={lines} lineNumbers={lineNumbers} /> : lineNumbers ? <Highlighted lines={text.split('\n').map((t) => [{ t }])} lineNumbers /> : text}</code>
      </pre>
    </figure>
  )
}
