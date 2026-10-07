/**
 * content-server over the built standalone server (out/main/server-node.js, the real extract.process.js forked on
 * Electron's Node) and headless Chromium under the production CSP:
 *   - the page uploads what a paste/drop gives it (Blobs made on a canvas, with a client-made thumbnail) and renders
 *     the stored image with <img>; an SVG with a script never renders inline;
 *   - a PDF's text comes back from the extract process;
 *   - prompts and protocols round-trip; a ChatGPT export imports and the data exports again.
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { launchServer, pageApi, sameOriginHeaders, type TestServer } from '../launch'
import { rawRequest } from '../http'

let s: TestServer

test.beforeAll(async () => {
  s = await launchServer()
})

test.afterAll(async () => {
  await s?.close()
})

function tinyPdf(text: string): string {
  const content = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 3 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  return `${out}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
}

function multipartBody(name: string, data: Buffer): { body: Buffer; type: string } {
  const boundary = `----vesper-e2e-${Date.now()}`
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ])
  return { body, type: `multipart/form-data; boundary=${boundary}` }
}

test('pasted images upload as Blobs and render inline; SVG never does @R18', async () => {
  const result = await s.page.evaluate(async () => {
    const canvas = new OffscreenCanvas(640, 400)
    const g = canvas.getContext('2d')!
    g.fillStyle = '#c9a227'
    g.fillRect(0, 0, 640, 400)
    const image = await canvas.convertToBlob({ type: 'image/png' })
    const small = new OffscreenCanvas(320, 200)
    small.getContext('2d')!.drawImage(canvas, 0, 0, 320, 200)
    const thumb = await small.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
    const fd = new FormData()
    fd.append('meta', JSON.stringify({ name: 'Pasted image.png', width: 640, height: 400 }))
    fd.append('file', image, 'image.png')
    fd.append('thumb', thumb, 'thumb.jpg')
    const up = await fetch('/api/attachments', { method: 'POST', body: fd, headers: { 'x-vesper': '1' } })
    const ref = (await up.json()) as { sha: string; name: string; mime: string; width: number; height: number }

    const load = (src: string) =>
      new Promise<number>((resolve) => {
        const img = new Image()
        img.onload = () => resolve(img.naturalWidth)
        img.onerror = () => resolve(0)
        img.src = src
      })
    const svgFd = new FormData()
    svgFd.append('file', new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>window.__pwned=1</script><rect width="10" height="10"/></svg>'], { type: 'image/svg+xml' }), 'x.svg')
    const svg = (await (await fetch('/api/attachments', { method: 'POST', body: svgFd, headers: { 'x-vesper': '1' } })).json()) as { sha: string; mime: string }
    const svgRes = await fetch(`/api/attachments/${svg.sha}`)
    return {
      status: up.status,
      ref,
      full: await load(`/api/attachments/${ref.sha}`),
      thumb: await load(`/api/attachments/${ref.sha}?thumb=1`),
      svgMime: svg.mime,
      svgInline: await load(`/api/attachments/${svg.sha}`),
      svgType: svgRes.headers.get('content-type'),
      svgDisposition: svgRes.headers.get('content-disposition'),
      pwned: (window as unknown as { __pwned?: number }).__pwned ?? 0
    }
  })
  expect(result.status).toBe(200)
  expect(result.ref).toMatchObject({ name: 'Pasted image.png', mime: 'image/png', width: 640, height: 400 })
  expect(result.full).toBe(640)
  expect(result.thumb).toBe(320)
  expect(result.svgMime).toBe('image/svg+xml')
  expect(result.svgInline).toBe(0)
  expect(result.svgType).toBe('application/octet-stream')
  expect(result.svgDisposition).toMatch(/^attachment;/)
  expect(result.pwned).toBe(0)
  await s.assertNoErrors()
})

test('a PDF is read by the extract process and its text is served @R18', async () => {
  const pdf = tinyPdf('Vesper reads attachments')
  const r = await s.page.evaluate(async (data) => {
    const fd = new FormData()
    fd.append('file', new Blob([data], { type: 'application/pdf' }), 'notes.pdf')
    const ref = (await (await fetch('/api/attachments', { method: 'POST', body: fd, headers: { 'x-vesper': '1' } })).json()) as { sha: string; kind: string; textState?: string }
    const text = (await (await fetch(`/api/attachments/${ref.sha}/text`)).json()) as { text: string }
    return { ref, text: text.text }
  }, pdf)
  expect(r.ref).toMatchObject({ kind: 'pdf', textState: 'ok' })
  expect(r.text).toContain('Vesper reads attachments')
})

test('prompts library and protocols @R11 @R9', async () => {
  const api = pageApi(s.page)
  const p = await api<{ id: number; name: string }>('POST', '/api/prompts', { name: 'Haiku mode', body: 'Answer in haiku.' })
  expect(p.status).toBe(200)
  expect((await api<{ name: string }[]>('GET', '/api/prompts')).json.map((x) => x.name)).toContain('Haiku mode')
  const g = await api<{ isDefault: boolean; warnings: string[] }>('GET', '/api/protocols')
  expect(g.json).toMatchObject({ isDefault: true, warnings: [] })
  expect((await api('PUT', '/api/protocols', { text: 'x' })).status).toBe(403)
  const desk = await s.login('desktop')
  const put = await desk.api<{ warnings: string[] }>('PUT', '/api/protocols', { text: 'Be {{assistant_name}}. {{oops}}' })
  expect(put.status).toBe(200)
  expect(put.json.warnings.join(' ')).toMatch(/oops/)
  expect((await desk.api('POST', '/api/protocols/reset')).status).toBe(200)
})

test('import a ChatGPT export, then export everything @R7 @R18', async () => {
  const desk = await s.login('desktop')
  const fixture = fs.readFileSync(path.resolve(__dirname, '..', '..', 'fixtures', 'import', 'chatgpt-conversations.json'))
  const mp = multipartBody('conversations.json', fixture)
  const imp = await rawRequest(s.url, { method: 'POST', path: '/api/import', headers: { ...sameOriginHeaders(s.url, desk.cookie), 'content-type': mp.type }, body: mp.body })
  expect(imp.status, imp.text).toBe(200)
  expect(imp.json).toMatchObject({ source: 'chatgpt', sessions: 2, messages: 6 })
  const list = await desk.api<{ items: { title: string }[] }>('GET', '/api/sessions?limit=50')
  expect(list.json.items.map((x) => x.title)).toEqual(expect.arrayContaining(['Trip to Lisbon', 'Sourdough']))
  const exp = await rawRequest(s.url, { method: 'GET', path: '/api/export?format=md', headers: sameOriginHeaders(s.url, desk.cookie) })
  expect(exp.status).toBe(200)
  expect(exp.headers['content-type']).toBe('application/zip')
  expect(String(exp.headers['content-disposition'])).toMatch(/vesper-export-\d{8}-\d{6}-markdown\.zip/)
  const b = await rawRequest(s.url, { method: 'POST', path: '/api/backup', headers: sameOriginHeaders(s.url, desk.cookie) })
  expect(b.status).toBe(200)
  expect((b.json as { file: string }).file).toMatch(/^vesper-\d{8}-\d{6}\.db$/)
})
