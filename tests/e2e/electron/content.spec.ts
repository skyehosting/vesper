/**
 * Attachments in the desktop app (07 B6): the extract process runs as an Electron utilityProcess with its heap cap;
 * a dropped text file and a PDF come back with their text, and an image renders from the store.
 */
import { expect, test } from '@playwright/test'
import { launchApp, type TestApp } from '../launch'

let t: TestApp | null = null

test.afterEach(async () => {
  await t?.close()
  t = null
})

test('files dropped in the desktop app are stored, sniffed and read by the utility process @R18', async () => {
  t = await launchApp()
  const r = await t.page.evaluate(async () => {
    const pdf = [
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
      '4 0 obj << /Length 52 >> stream',
      'BT /F1 18 Tf 72 720 Td (Desktop extraction works) Tj ET',
      'endstream endobj',
      '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
      'trailer << /Root 1 0 R >>',
      '%%EOF'
    ].join('\n')
    const send = async (blob: Blob, name: string) => {
      const fd = new FormData()
      fd.append('file', blob, name)
      const res = await fetch('/api/attachments', { method: 'POST', body: fd, headers: { 'x-vesper': '1' } })
      return (await res.json()) as { sha: string; kind: string; mime: string; textState?: string }
    }
    const p = await send(new Blob([pdf], { type: 'application/pdf' }), 'desk.pdf')
    const txt = await send(new Blob(['Grüße aus dem Desktop'], { type: 'text/plain' }), 'note.txt')
    const canvas = new OffscreenCanvas(48, 32)
    canvas.getContext('2d')!.fillRect(0, 0, 48, 32)
    const img = await send(await canvas.convertToBlob({ type: 'image/png' }), 'dot.png')
    const width = await new Promise<number>((resolve) => {
      const el = new Image()
      el.onload = () => resolve(el.naturalWidth)
      el.onerror = () => resolve(0)
      el.src = `/api/attachments/${img.sha}`
    })
    const text = async (sha: string) => ((await (await fetch(`/api/attachments/${sha}/text`)).json()) as { text: string }).text
    return { p, txt, img, width, pdfText: await text(p.sha), noteText: await text(txt.sha) }
  })
  expect(r.p).toMatchObject({ kind: 'pdf', textState: 'ok' })
  expect(r.pdfText).toContain('Desktop extraction works')
  expect(r.txt).toMatchObject({ kind: 'text', textState: 'ok' })
  expect(r.noteText).toBe('Grüße aus dem Desktop')
  expect(r.img).toMatchObject({ kind: 'image', mime: 'image/png' })
  expect(r.width).toBe(48)
  await t.assertNoErrors()
})
