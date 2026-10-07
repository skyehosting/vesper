/** Pure helpers of the chat test hooks (synthetic speech chunks), unit-tested. */

/**
 * Sentence chunks that tile `text` exactly, cut only after . ! ? followed by whitespace (never inside a link or a
 * URL, like the speech segmenter); the first chunk is ≥ 40 chars when possible.
 */
export function chunkText(text: string): string[] {
  const out: string[] = []
  let start = 0
  const re = /[.!?]+\s+/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m.index + m[0].length
    if (end - start >= (out.length === 0 ? 40 : 80)) {
      out.push(text.slice(start, end))
      start = end
    }
  }
  if (start < text.length) out.push(text.slice(start))
  return out.length ? out : [text]
}

/** What a TTS would say for a markdown chunk: link text, no markup characters (the server's spoken rules, simplified). */
export function spokenOf(md: string): string {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
}
