/**
 * Text decoding with charset sniffing (07 B6/C8): BOM first, then strict UTF-8, then UTF-16 without a BOM (NUL
 * pattern), else Windows-1252 — the usual encoding of older Windows text files. Pure; runs in the extract process
 * and in unit tests.
 */

export interface DecodedText {
  text: string
  truncated: boolean
  charset: 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252'
}

function utf16Guess(b: Buffer): 'utf-16le' | 'utf-16be' | null {
  const n = Math.min(b.length, 4096) & ~1
  if (n < 4) return null
  let evenNul = 0
  let oddNul = 0
  for (let i = 0; i < n; i += 2) {
    if (b[i] === 0) evenNul++
    if (b[i + 1] === 0) oddNul++
  }
  const pairs = n / 2
  if (oddNul > pairs * 0.4 && evenNul < pairs * 0.05) return 'utf-16le'
  if (evenNul > pairs * 0.4 && oddNul < pairs * 0.05) return 'utf-16be'
  return null
}

function decodeUtf16be(b: Buffer): string {
  const swapped = Buffer.from(b.subarray(0, b.length & ~1))
  swapped.swap16()
  return swapped.toString('utf16le')
}

/** Cut at `max` UTF-16 units without splitting a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s
  const code = s.charCodeAt(max - 1)
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max)
}

/**
 * Decode `buf` to at most `maxChars` characters. Only a prefix of the bytes is decoded (enough for `maxChars` in the
 * widest encoding), so a huge file costs no more than the cap.
 */
export function decodeText(buf: Buffer, maxChars: number): DecodedText {
  let body = buf
  let charset: DecodedText['charset'] | null = null
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    charset = 'utf-8'
    body = buf.subarray(3)
  } else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    charset = 'utf-16le'
    body = buf.subarray(2)
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    charset = 'utf-16be'
    body = buf.subarray(2)
  }
  const maxBytes = maxChars * 4 + 4
  const prefix = body.length > maxBytes ? body.subarray(0, maxBytes) : body
  const bytesCut = prefix.length < body.length

  let text: string | null = null
  // NULs in every other byte are valid UTF-8 too, so the UTF-16 pattern is checked first.
  if (charset === null) charset = utf16Guess(prefix)
  if (charset === null) {
    try {
      // stream:true tolerates a multi-byte character cut at the end of the prefix.
      text = new TextDecoder('utf-8', { fatal: true }).decode(prefix, { stream: bytesCut })
      charset = 'utf-8'
    } catch {
      charset = 'windows-1252'
    }
  }
  if (text === null) {
    if (charset === 'utf-8') text = new TextDecoder('utf-8').decode(prefix, { stream: bytesCut })
    else if (charset === 'utf-16le') text = prefix.subarray(0, prefix.length & ~1).toString('utf16le')
    else if (charset === 'utf-16be') text = decodeUtf16be(prefix)
    else text = new TextDecoder('windows-1252').decode(prefix)
  }
  text = text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '')
  const truncated = bytesCut || text.length > maxChars
  return { text: cut(text, maxChars), truncated, charset }
}
