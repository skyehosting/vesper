/**
 * Attachment text extractor (07 B6): an on-demand utility process (Electron utilityProcess, or a Node child in the
 * standalone server) started with `--max-old-space-size=512`. The server kills it after 30 s per job and restarts
 * it lazily, so a pathological PDF, a DOCX bomb or a parser crash costs one attachment its text — never the server.
 *
 * Protocol (one job at a time; ExtractorPool in src/server/attachments/extractor.ts):
 *   → {t:'extract', id, file, kind:'pdf'|'docx'|'text', maxChars, maxPages}
 *   ← {t:'done', id, text, truncated, extractor} | {t:'failed', id, code}
 *   → {t:'ping'} ← {t:'pong'}
 * Text is capped at `maxChars` here, so the reply message is bounded too.
 */
import fs from 'node:fs/promises'
import { bufferSource } from '../server/attachments/bytes'
import { decodeText } from '../server/attachments/text'
import { archiveProblem, readCentralDirectory } from '../server/attachments/zip'
import { onParentMessage } from './parentPort'

interface ExtractJob {
  t: 'extract'
  id: number
  file: string
  kind: string
  maxChars: number
  maxPages: number
}

type Reply = { t: 'done'; id: number; text: string; truncated: boolean; extractor: string } | { t: 'failed'; id: number; code: string }

class Refused extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

function cap(text: string, maxChars: number): { text: string; truncated: boolean } {
  return text.length > maxChars ? { text: text.slice(0, maxChars), truncated: true } : { text, truncated: false }
}

async function extractPdf(buf: Buffer, maxChars: number, maxPages: number): Promise<{ text: string; truncated: boolean }> {
  const { getDocumentProxy } = await import('unpdf')
  // pdf.js 5 (inside unpdf 1.8) dropped `isEvalSupported`: PostScript functions compile to wasm or to JS from a
  // parsed AST, and text extraction does not evaluate them. Fonts are never installed (no DOM here anyway).
  const pdf = await getDocumentProxy(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), {
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    // Errors only: font-data warnings are expected (no standard fonts needed for text) and would flood the log.
    verbosity: 0
  })
  try {
    const pages = Math.min(pdf.numPages, maxPages)
    let text = ''
    let truncated = pdf.numPages > maxPages
    for (let i = 1; i <= pages; i++) {
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      for (const item of content.items) {
        if ('str' in item) text += item.str + (item.hasEOL ? '\n' : '')
      }
      text += '\n\n'
      page.cleanup()
      if (text.length > maxChars) {
        truncated = true
        break
      }
    }
    const c = cap(text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), maxChars)
    return { text: c.text, truncated: truncated || c.truncated }
  } finally {
    await pdf.loadingTask.destroy()
  }
}

async function extractDocx(buf: Buffer, maxChars: number): Promise<{ text: string; truncated: boolean }> {
  // Refuse bombs from the central directory before anything is inflated (07 B6).
  const entries = await readCentralDirectory(bufferSource(buf))
  if (!entries) throw new Refused('unreadable')
  const problem = archiveProblem(entries)
  if (problem) throw new Refused('archive_refused')
  const mammoth = (await import('mammoth')).default
  const r = await mammoth.extractRawText({ buffer: buf })
  return cap(r.value.replace(/\n{3,}/g, '\n\n').trim(), maxChars)
}

async function run(job: ExtractJob): Promise<Reply> {
  const buf = await fs.readFile(job.file)
  if (__VESPER_TEST__ && process.env.VESPER_TEST === '1') {
    // Test hooks for the supervision tests (timeout kill, crash isolation); compiled out of release builds (07 B10).
    const marker = buf.subarray(0, 32).toString('latin1')
    if (job.kind === 'test:hang' || marker.startsWith('__vesper_test_hang__')) for (;;);
    if (job.kind === 'test:crash' || marker.startsWith('__vesper_test_crash__')) process.exit(3)
  }
  let r: { text: string; truncated: boolean }
  let extractor: string
  switch (job.kind) {
    case 'pdf':
      r = await extractPdf(buf, job.maxChars, job.maxPages)
      extractor = 'unpdf'
      break
    case 'docx':
      r = await extractDocx(buf, job.maxChars)
      extractor = 'mammoth'
      break
    case 'text': {
      const d = decodeText(buf, job.maxChars)
      r = { text: d.text, truncated: d.truncated }
      extractor = `text:${d.charset}`
      break
    }
    default:
      return { t: 'failed', id: job.id, code: 'unsupported' }
  }
  return { t: 'done', id: job.id, text: r.text, truncated: r.truncated, extractor }
}

// A Node child must not outlive its server (utilityProcess children die with Electron's main process anyway).
if (process.send) process.on('disconnect', () => process.exit(0))

onParentMessage((m, reply) => {
  if (typeof m !== 'object' || m === null) return
  const msg = m as { t?: unknown }
  if (msg.t === 'ping') return reply({ t: 'pong' })
  if (msg.t !== 'extract') return
  const job = m as ExtractJob
  run(job).then(reply, (e: unknown) => reply({ t: 'failed', id: job.id, code: e instanceof Refused ? e.code : 'unreadable' } satisfies Reply))
})
