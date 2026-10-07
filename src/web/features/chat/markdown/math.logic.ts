/**
 * Math delimiters models actually use (P08; 07 D7): `$$…$$` (as before), `\(…\)` and `\[…\]`, and `$…$` when it looks
 * like math — prices such as "$5 and $10" stay text. `\(…\)` / `\[…\]` need a formula-like body too ("\[1\]", "\[sic\]" are
 * escaped brackets in prose), except `\[` alone on its line, which opens a display block whatever it holds.
 *
 * `normalizeMath` rewrites a block's markdown for the renderer WITHOUT changing its length, so every mdast offset (the
 * `data-src-*` the synced reveal maps speech chunks onto, R14) still points into the original text:
 *   - `\(` `\[` → `$ ` and `\)` `\]` → ` $`: single-dollar inline math (the spaces are inside the formula, which KaTeX
 *     ignores). Never `$$`: at the start of a line that would open a display block and swallow what follows.
 *   - a single `$` that does not open or close accepted math becomes U+E000, so the parser (single-dollar math on)
 *     leaves it alone; `restoreDollars` turns it back into `$` in the rendered tree.
 * Code (fenced blocks, inline code spans) and `$$…$$` are left untouched. Pure: no DOM, unit-tested.
 */

/** Stands in for a `$` that is not math (one UTF-16 unit, like `$`: offsets are kept). */
export const DOLLAR_PLACEHOLDER = String.fromCharCode(0xe000)

/** The placeholder as is, or percent-encoded in a link destination (micromark encodes non-ASCII there). */
const PLACEHOLDER_RE = new RegExp(`${DOLLAR_PLACEHOLDER}|%EE%80%80`, 'g')

/** Back from the placeholder (rendered text, link targets). */
export function restoreDollars(s: string): string {
  return s.includes(DOLLAR_PLACEHOLDER) || s.includes('%EE%80%80') ? s.replace(PLACEHOLDER_RE, '$') : s
}

/** Content between single dollars that reads as a formula: a TeX command, a script, a relation, braces, or one letter. */
function looksLikeMath(c: string): boolean {
  if (/\\[A-Za-z]+/.test(c)) return true
  if (/^[A-Za-z]$/.test(c)) return true
  if (/^[\d.,\s]+$/.test(c)) return false
  return /[\^_={}<>+]/.test(c)
}

/**
 * The body of `\( \)` / `\[ \]` reads as a formula. Escaped brackets are ordinary prose too ("\[1\]", "\[sic\]"), so bare
 * numbers and words stay text; a single letter counts only in `\( \)` (`\[x\]` is a ticked box written out).
 */
function looksLikeTex(body: string, close: string): boolean {
  if (close === ']' && /^[A-Za-z]$/.test(body)) return false
  return looksLikeMath(body)
}

/** The `len`-char opener at `i` is the only thing on its line (a display block: `\[`, the formula, `\]`). */
function aloneOnLine(s: string, i: number, len: number): boolean {
  const start = s.lastIndexOf('\n', i - 1) + 1
  const nl = s.indexOf('\n', i + len)
  return !s.slice(start, i).trim() && !s.slice(i + len, nl < 0 ? s.length : nl).trim()
}

/** An odd number of backslashes right before `i` (the character at `i` is escaped). */
function escaped(s: string, i: number): boolean {
  let n = 0
  for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) n++
  return n % 2 === 1
}

function runLength(s: string, i: number, ch: string): number {
  let j = i
  while (j < s.length && s[j] === ch) j++
  return j - i
}

/** Index of the closing `\)` / `\]` for an opener at `from`, within the paragraph (no blank line), or -1. */
function findTexClose(s: string, from: number, close: string): number {
  for (let j = from; j < s.length - 1; j++) {
    if (s[j] === '\n' && /^\n[ \t]*(\n|$)/.test(s.slice(j, j + 40))) return -1
    if (s[j] === '`') return -1
    if (s[j] === '$') return -1
    if (s[j] === '\\' && s[j + 1] === close && !escaped(s, j)) return j
  }
  return -1
}

/** Index of the `$` closing a single-dollar formula opened at `open`, on the same line, or -1. */
function findDollarClose(s: string, open: number): number {
  for (let j = open + 1; j < s.length; j++) {
    const c = s[j]
    if (c === '\n' || c === '`') return -1
    if (c !== '$' || escaped(s, j)) continue
    if (s[j + 1] === '$') return -1
    return j
  }
  return -1
}

export function normalizeMath(src: string): string {
  if (!src.includes('$') && !src.includes('\\(') && !src.includes('\\[')) return src
  const out = src.split('')
  let i = 0
  let lineStart = true
  let fence: string | null = null
  while (i < src.length) {
    const c = src[i]
    if (lineStart) {
      lineStart = false
      // A fenced code block is skipped line by line, its fences included.
      const nl = src.indexOf('\n', i)
      const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(src.slice(i, nl < 0 ? src.length : nl))
      let skip = fence !== null
      if (fence !== null) {
        if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim()) fence = null
      } else if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
        fence = m[1]
        skip = true
      }
      if (skip) {
        if (nl < 0) break
        i = nl + 1
        lineStart = true
        continue
      }
    }
    if (c === '\n') {
      lineStart = true
      i++
      continue
    }
    if (c === '`') {
      // Inline code: skip to the closing run of the same length (or past the run when it has none).
      const n = runLength(src, i, '`')
      const tick = '`'.repeat(n)
      let k = i + n
      let end = -1
      while ((k = src.indexOf(tick, k)) >= 0) {
        if (runLength(src, k, '`') === n) {
          end = k
          break
        }
        k += runLength(src, k, '`')
      }
      i = end < 0 ? i + n : end + n
      continue
    }
    if (c === '\\' && (src[i + 1] === '(' || src[i + 1] === '[') && !escaped(src, i)) {
      const close = src[i + 1] === '(' ? ')' : ']'
      const j = findTexClose(src, i + 2, close)
      const body = j > i + 2 ? src.slice(i + 2, j).trim() : ''
      if (body && (looksLikeTex(body, close) || (close === ']' && aloneOnLine(src, i, 2)))) {
        out[i] = '$'
        out[i + 1] = ' '
        out[j] = ' '
        out[j + 1] = '$'
        i = j + 2
        continue
      }
      i += 2
      continue
    }
    if (c === '$' && !escaped(src, i)) {
      const n = runLength(src, i, '$')
      if (n >= 2) {
        // `$$…$$` (inline or display) as before: skip to its closing run.
        const tick = '$'.repeat(n)
        const end = src.indexOf(tick, i + n)
        i = end < 0 ? i + n : end + n
        continue
      }
      const j = findDollarClose(src, i)
      const body = j > 0 ? src.slice(i + 1, j) : ''
      const ok = j > 0 && body.length > 0 && !/^\s|\s$/.test(body) && !/\d/.test(src[j + 1] ?? '') && looksLikeMath(body)
      if (ok) {
        i = j + 1
        continue
      }
      out[i] = DOLLAR_PLACEHOLDER
      i++
      continue
    }
    i++
  }
  return out.join('')
}

/** Where a math element's source begins: `\[` marks a display formula written inline. */
export function isDisplaySource(src: string, offset: number): boolean {
  return src.startsWith('\\[', offset)
}

/** The text has a formula the renderer typesets. */
export function hasMathSyntax(text: string): boolean {
  return normalizeMath(text).includes('$')
}
