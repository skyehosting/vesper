import { describe, expect, it } from 'vitest'
import { ACCEPT, fitWithin, hasAlpha, keepOriginal, kindOf, pastePreview, pastedName, renameFor } from '../../../src/web/features/chat/composer/attachments.logic'
import { chunkText } from '../../../src/web/features/chat/testHooks.logic'

describe('composer attachments (07 B6/C8) @R18', () => {
  it('classifies files the server accepts', () => {
    expect(kindOf('a.png', 'image/png')).toBe('image')
    expect(kindOf('report.PDF', '')).toBe('pdf')
    expect(kindOf('cv.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('docx')
    expect(kindOf('main.ts', '')).toBe('text')
    expect(kindOf('data.bin', 'application/octet-stream')).toBe('other')
    for (const t of ['image/png', 'application/pdf', '.docx', '.md', '.csv', '.json', '.py']) expect(ACCEPT.split(',')).toContain(t)
    expect(ACCEPT).not.toContain('svg')
  })

  it('scales images so the long edge is at most 1568 px, never up', () => {
    expect(fitWithin(4000, 3000, 1568)).toEqual({ width: 1568, height: 1176, scale: 0.392 })
    expect(fitWithin(1000, 3000, 1568).height).toBe(1568)
    expect(fitWithin(800, 600, 1568)).toEqual({ width: 800, height: 600, scale: 1 })
    expect(fitWithin(4000, 3000, 320).width).toBe(320)
  })

  it('keeps small images as they are and re-encodes the rest', () => {
    expect(keepOriginal('image/jpeg', 2_000_000, 1200, 900)).toBe(true)
    expect(keepOriginal('image/jpeg', 5_000_000, 1200, 900)).toBe(false)
    expect(keepOriginal('image/png', 100_000, 3000, 900)).toBe(false)
    expect(keepOriginal('image/avif', 100_000, 300, 300)).toBe(false)
    expect(renameFor('photo.heic', 'image/jpeg')).toBe('photo.jpg')
    expect(renameFor('logo.webp', 'image/png')).toBe('logo.png')
  })

  it('detects transparency', () => {
    expect(hasAlpha(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]))).toBe(false)
    expect(hasAlpha(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 0]))).toBe(true)
  })

  it('names pasted files and previews pasted text', () => {
    expect(pastedName('image/png', 0, new Date(2026, 9, 5, 14, 3))).toBe('Pasted 2026-10-05 14.03.png')
    expect(pastedName('image/jpeg', 1, new Date(2026, 9, 5, 14, 3))).toBe('Pasted 2026-10-05 14.03 (2).jpg')
    expect(pastePreview('  first line\nsecond')).toBe('first line')
    expect(pastePreview('x'.repeat(100))).toHaveLength(61)
  })
})

describe('synthetic speech chunks (test hooks) @R14', () => {
  it('tile the text and never cut inside a link or URL', () => {
    const text = 'One sentence that is long enough to stand alone here. Read [the archive](https://example.com/a.b) now. Done!'
    const chunks = chunkText(text)
    expect(chunks.join('')).toBe(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect((c.match(/\[/g) ?? []).length).toBe((c.match(/\]/g) ?? []).length)
  })
})
