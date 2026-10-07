/** Magic-byte sniffing, header-only image sizes, text detection/decoding and the ZIP bomb check (07 B5/B6) @R18 */
import { describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'
import { bufferSource } from '@server/attachments/bytes'
import { imageSize, imageType, isInlineType, looksLikeText, sniff, textMime } from '@server/attachments/sniff'
import { decodeText } from '@server/attachments/text'
import { archiveProblem, isDocx, readCentralDirectory } from '@server/attachments/zip'
import { avif, docx, gif, jpeg, pdf, png, webp } from './helpers'

const sniffBuf = (b: Buffer, name = 'x.bin') => sniff(bufferSource(b), name)

describe('images', () => {
  it.each([
    ['png', png(640, 480), 'image/png'],
    ['jpeg (SOF after a 3 KB EXIF segment)', jpeg(1568, 1045), 'image/jpeg'],
    ['gif', gif(320, 200), 'image/gif'],
    ['webp', webp(1024, 768), 'image/webp'],
    ['avif', avif(2000, 1000), 'image/avif']
  ])('%s: type and size from the header only', async (_n, bytes, mime) => {
    const r = await sniffBuf(bytes)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.kind).toBe('image')
    expect(r.value.mime).toBe(mime)
    expect(r.value.width! * r.value.height!).toBeGreaterThan(0)
    expect(isInlineType(r.value.mime)).toBe(true)
  })

  it('reads exact dimensions', async () => {
    expect(await imageSize(bufferSource(jpeg(1568, 1045)), 'image/jpeg')).toEqual({ width: 1568, height: 1045 })
    expect(await imageSize(bufferSource(webp(1024, 768)), 'image/webp')).toEqual({ width: 1024, height: 768 })
    expect(await imageSize(bufferSource(avif(2000, 1000)), 'image/avif')).toEqual({ width: 2000, height: 1000 })
  })

  it('refuses more than 50 megapixels and damaged headers', async () => {
    expect(await sniffBuf(png(10_000, 6_000))).toEqual({ ok: false, reason: 'too-many-pixels' })
    expect(await sniffBuf(png(7000, 7000))).toEqual({ ok: true, value: { kind: 'image', mime: 'image/png', width: 7000, height: 7000 } })
    const broken = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    expect(await sniffBuf(broken)).toEqual({ ok: false, reason: 'damaged-image' })
    expect(await sniffBuf(png(0, 10))).toEqual({ ok: false, reason: 'damaged-image' })
  })

  it('the declared name never changes the sniffed type', async () => {
    const r = await sniffBuf(png(10, 10), 'evil.html')
    expect(r.ok && r.value.mime).toBe('image/png')
    expect(imageType(Buffer.from('<svg onload=alert(1)>'))).toBeNull()
  })
})

describe('documents and text', () => {
  it('pdf, docx, other zips', async () => {
    expect(await sniffBuf(pdf(['hello']))).toEqual({ ok: true, value: { kind: 'pdf', mime: 'application/pdf' } })
    const d = await sniffBuf(docx(['hi']), 'a.docx')
    expect(d.ok && d.value.kind).toBe('docx')
    const z = Buffer.from(zipSync({ 'a.txt': new Uint8Array([1, 2, 3]) }))
    expect(await sniffBuf(z, 'a.docx')).toEqual({ ok: false, reason: 'unsupported' })
  })

  it('text flavours: svg and html by content, others by extension', () => {
    expect(textMime('a.txt', Buffer.from('<?xml version="1.0"?>\n<!-- x -->\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBe('image/svg+xml')
    expect(textMime('notes.txt', Buffer.from('<!DOCTYPE html><html><script>x</script>'))).toBe('text/html')
    expect(textMime('a.md', Buffer.from('# hi'))).toBe('text/markdown')
    expect(textMime('data.CSV', Buffer.from('a,b'))).toBe('text/csv')
    expect(textMime('x.json', Buffer.from('{}'))).toBe('application/json')
    expect(textMime('main.ts', Buffer.from('export {}'))).toBe('text/plain')
  })

  it('binary files are not text', async () => {
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0), Buffer.from([1, 2, 3, 4, 5])])
    expect(looksLikeText(exe)).toBe(false)
    expect(await sniffBuf(exe, 'setup.exe')).toEqual({ ok: false, reason: 'unsupported' })
    expect(looksLikeText(Buffer.from('plain\ttext\r\nwith lines'))).toBe(true)
    expect(looksLikeText(Buffer.from('h\0e\0l\0l\0o\0 \0w\0o\0r\0l\0d\0', 'latin1'))).toBe(true)
  })
})

describe('decodeText (charset sniffing)', () => {
  it('BOMs, strict UTF-8, UTF-16 without BOM, Windows-1252 fallback', () => {
    expect(decodeText(Buffer.from('﻿héllo', 'utf8'), 100)).toMatchObject({ text: 'héllo', charset: 'utf-8' })
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ünï', 'utf16le')]), 100)).toMatchObject({ text: 'ünï', charset: 'utf-16le' })
    const be = Buffer.from('abc', 'utf16le')
    be.swap16()
    expect(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be]), 100)).toMatchObject({ text: 'abc', charset: 'utf-16be' })
    expect(decodeText(Buffer.from('hello world', 'utf16le'), 100)).toMatchObject({ text: 'hello world', charset: 'utf-16le' })
    expect(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80]), 100)).toMatchObject({ text: 'café €', charset: 'windows-1252' })
    expect(decodeText(Buffer.from('a\r\nb\rc\0d'), 100).text).toBe('a\nb\ncd')
  })

  it('caps the output without splitting a surrogate pair and without decoding the whole file', () => {
    const big = Buffer.from('😀'.repeat(1000), 'utf8')
    const r = decodeText(big, 5)
    expect(r.truncated).toBe(true)
    expect(r.text).toBe('😀😀')
    const huge = Buffer.alloc(50 * 1024 * 1024, 0x61)
    const t0 = performance.now()
    expect(decodeText(huge, 1000)).toMatchObject({ truncated: true })
    expect(performance.now() - t0).toBeLessThan(200)
  })
})

describe('zip central directory', () => {
  it('lists entries and recognises DOCX', async () => {
    const entries = await readCentralDirectory(bufferSource(docx(['x'])))
    expect(entries?.map((e) => e.name).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'word/document.xml'])
    expect(isDocx(entries!)).toBe(true)
    expect(await readCentralDirectory(bufferSource(Buffer.from('not a zip at all, sorry')))).toBeNull()
  })

  it('refuses bombs from the directory alone: ratio > 100:1 or > 50 MB inflated', async () => {
    const ratio = await readCentralDirectory(bufferSource(docx(['x'], { pad: 4 * 1024 * 1024 })))
    expect(archiveProblem(ratio!)).toBe('ratio')
    const large = await readCentralDirectory(bufferSource(docx(['x'], { pad: 51 * 1024 * 1024 })))
    expect(archiveProblem(large!)).toBe('too_large')
    expect(archiveProblem((await readCentralDirectory(bufferSource(docx(['ok']))))!)).toBeNull()
  })
})
