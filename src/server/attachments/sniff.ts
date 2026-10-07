/**
 * What an uploaded file really is (07 B5): the type comes from magic bytes, never from the client's Content-Type or
 * file name (those are advisory and only pick among text flavours). Accepted (07 C8): images (png, jpeg, gif, webp,
 * avif), PDF, DOCX, and text (txt/md/code/csv/json, plus html and svg, which are stored but only ever downloaded).
 * Image dimensions come from the header alone — no pixel is decoded in the server (07 B6) — and anything above
 * 50 megapixels is refused.
 */
import type { AttachmentRef } from '@shared/types/domain'
import type { ByteSource } from './bytes'
import { isDocx, readCentralDirectory } from './zip'

export const MAX_IMAGE_PIXELS = 50_000_000

/** Types served inline (07 B5); everything else is a download. */
export const INLINE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'] as const
export type InlineImageType = (typeof INLINE_IMAGE_TYPES)[number]

export interface Sniffed {
  kind: AttachmentRef['kind']
  mime: string
  width?: number
  height?: number
}

export type SniffResult = { ok: true; value: Sniffed } | { ok: false; reason: 'unsupported' | 'damaged-image' | 'too-many-pixels' }

const HEAD = 4096

function startsWith(b: Buffer, bytes: readonly number[], at = 0): boolean {
  if (b.length < at + bytes.length) return false
  for (let i = 0; i < bytes.length; i++) if (b[at + i] !== bytes[i]) return false
  return true
}

function ascii(b: Buffer, at: number, len: number): string {
  return b.length >= at + len ? b.toString('latin1', at, at + len) : ''
}

/** The image type of a file head, from its signature. */
export function imageType(head: Buffer): InlineImageType | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  const gif = ascii(head, 0, 6)
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif'
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return 'image/webp'
  if (ascii(head, 4, 4) === 'ftyp') {
    const boxSize = head.length >= 4 ? head.readUInt32BE(0) : 0
    const end = Math.min(head.length, Math.max(16, boxSize))
    // major brand at 8, compatible brands from 16 (minor version at 12).
    const brands = [ascii(head, 8, 4)]
    for (let p = 16; p + 4 <= end; p += 4) brands.push(ascii(head, p, 4))
    if (brands.includes('avif') || brands.includes('avis')) return 'image/avif'
  }
  return null
}

export interface Dimensions {
  width: number
  height: number
}

async function jpegSize(src: ByteSource): Promise<Dimensions | null> {
  // Walk the marker segments up to the first SOFn; APPn segments (EXIF) can push it far in, so cap the walk.
  let pos = 2
  const limit = Math.min(src.size, 4 * 1024 * 1024)
  while (pos + 4 <= limit) {
    const h = await src.read(pos, 9)
    if (h.length < 4 || h[0] !== 0xff) return null
    const marker = h[1]
    if (marker === 0xff) {
      pos += 1
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null
    const len = h.readUInt16BE(2)
    if (len < 2) return null
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (h.length < 9) return null
      return { height: h.readUInt16BE(5), width: h.readUInt16BE(7) }
    }
    pos += 2 + len
  }
  return null
}

function webpSize(head: Buffer): Dimensions | null {
  const chunk = ascii(head, 12, 4)
  if (chunk === 'VP8 ' && head.length >= 30) {
    // Key frame start code 9d 01 2a, then 14-bit width/height.
    if (!startsWith(head, [0x9d, 0x01, 0x2a], 23)) return null
    return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff }
  }
  if (chunk === 'VP8L' && head.length >= 25) {
    if (head[20] !== 0x2f) return null
    const b = head.readUInt32LE(21)
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X' && head.length >= 30) {
    return { width: head.readUIntLE(24, 3) + 1, height: head.readUIntLE(27, 3) + 1 }
  }
  return null
}

/** AVIF/HEIF: the largest `ispe` (image spatial extent) property; enough for a pixel-count check. */
async function avifSize(src: ByteSource): Promise<Dimensions | null> {
  const buf = await src.read(0, Math.min(src.size, 256 * 1024))
  let best: Dimensions | null = null
  for (let i = buf.indexOf('ispe', 0, 'latin1'); i >= 0 && i + 16 <= buf.length; i = buf.indexOf('ispe', i + 4, 'latin1')) {
    // box: size(4) 'ispe'(4) version+flags(4) width(4) height(4)
    const width = buf.readUInt32BE(i + 8)
    const height = buf.readUInt32BE(i + 12)
    if (!best || width * height > best.width * best.height) best = { width, height }
  }
  return best
}

/** Width and height from the header of an image of type `mime`, or null if the header is damaged. */
export async function imageSize(src: ByteSource, mime: InlineImageType): Promise<Dimensions | null> {
  const head = await src.read(0, 64)
  let d: Dimensions | null = null
  switch (mime) {
    case 'image/png':
      d = head.length >= 24 && ascii(head, 12, 4) === 'IHDR' ? { width: head.readUInt32BE(16), height: head.readUInt32BE(20) } : null
      break
    case 'image/gif':
      d = head.length >= 10 ? { width: head.readUInt16LE(6), height: head.readUInt16LE(8) } : null
      break
    case 'image/webp':
      d = webpSize(head)
      break
    case 'image/jpeg':
      d = await jpegSize(src)
      break
    case 'image/avif':
      d = await avifSize(src)
      break
  }
  return d && d.width > 0 && d.height > 0 ? d : null
}

/** Does this head look like text (no NULs outside UTF-16, few control characters)? */
export function looksLikeText(head: Buffer): boolean {
  if (head.length === 0) return true
  if (startsWith(head, [0xff, 0xfe]) || startsWith(head, [0xfe, 0xff])) return true
  let control = 0
  let nul = 0
  for (const c of head) {
    if (c === 0) nul++
    else if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x0c && c !== 0x1b) control++
  }
  if (nul > 0) {
    // UTF-16 without a BOM: NULs in every other byte.
    let even = 0
    let odd = 0
    for (let i = 0; i + 1 < head.length; i += 2) {
      if (head[i] === 0) even++
      if (head[i + 1] === 0) odd++
    }
    const pairs = Math.floor(head.length / 2)
    return pairs > 0 && (odd > pairs * 0.4 || even > pairs * 0.4) && control === 0
  }
  return control <= head.length * 0.02
}

const TEXT_TYPES: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  svg: 'image/svg+xml'
}

/** A text file's flavour: by content for markup that browsers would execute, by extension otherwise. */
export function textMime(name: string, head: Buffer): string {
  const s = head.toString('utf8', 0, Math.min(head.length, 1024)).replace(/^﻿/, '').trimStart().toLowerCase()
  const withoutProlog = s.replace(/^<\?xml[^>]*>\s*/, '').replace(/^(<!--[\s\S]*?-->\s*)+/, '')
  if (withoutProlog.startsWith('<svg') || withoutProlog.startsWith('<!doctype svg')) return 'image/svg+xml'
  if (withoutProlog.startsWith('<!doctype html') || withoutProlog.startsWith('<html')) return 'text/html'
  const ext = /\.([a-z0-9]{1,10})$/i.exec(name)?.[1]?.toLowerCase() ?? ''
  return TEXT_TYPES[ext] ?? 'text/plain'
}

/** Classify a file. `name` only chooses among text flavours. */
export async function sniff(src: ByteSource, name: string): Promise<SniffResult> {
  const head = await src.read(0, HEAD)
  const img = imageType(head)
  if (img) {
    const d = await imageSize(src, img)
    if (!d) return { ok: false, reason: 'damaged-image' }
    if (d.width * d.height > MAX_IMAGE_PIXELS) return { ok: false, reason: 'too-many-pixels' }
    return { ok: true, value: { kind: 'image', mime: img, width: d.width, height: d.height } }
  }
  // %PDF- may follow a little junk (the spec allows it within the first 1024 bytes).
  const pdfAt = head.subarray(0, 1024).indexOf('%PDF-', 0, 'latin1')
  if (pdfAt >= 0) return { ok: true, value: { kind: 'pdf', mime: 'application/pdf' } }
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
    const entries = await readCentralDirectory(src)
    if (entries && isDocx(entries)) return { ok: true, value: { kind: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } }
    return { ok: false, reason: 'unsupported' }
  }
  if (looksLikeText(head)) return { ok: true, value: { kind: 'text', mime: textMime(name, head) } }
  return { ok: false, reason: 'unsupported' }
}

/** May these bytes be shown inline (07 B5)? Only the five raster image types. */
export function isInlineType(mime: string): mime is InlineImageType {
  return (INLINE_IMAGE_TYPES as readonly string[]).includes(mime)
}
