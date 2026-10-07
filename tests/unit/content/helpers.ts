/**
 * content-server test helpers: the extract process built from source (esbuild, packages external so unpdf/mammoth
 * resolve from node_modules), synthetic files of every accepted type, and multipart bodies for fastify.inject.
 */
import fs from 'node:fs'
import path from 'node:path'
import { buildSync } from 'esbuild'
import { zipSync, strToU8 } from 'fflate'

const ROOT = path.resolve(__dirname, '..', '..', '..')

/** Build src/workers/extract.process.ts once per test process; returns the directory holding extract.process.js. */
/**
 * Bundle the extract process and db.worker (as electron-vite does) into a per-process dir, so content tests run the
 * real child process and the real worker thread — export/import/backup run on db.worker (07 C9, platform-int).
 */
export function buildWorkers(): string {
  const dir = path.join(ROOT, 'out', 'test-workers', String(process.pid))
  for (const [entry, file] of [
    ['src/workers/extract.process.ts', 'extract.process.js'],
    ['src/workers/db.worker.ts', 'db.worker.js']
  ] as const) {
    const out = path.join(dir, file)
    if (fs.existsSync(out)) continue
    buildSync({
      entryPoints: [path.join(ROOT, entry)],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      outfile: out,
      packages: 'external',
      define: { __VESPER_TEST__: 'true' },
      alias: { '@shared': path.join(ROOT, 'src/shared'), '@server': path.join(ROOT, 'src/server') },
      logLevel: 'silent'
    })
  }
  return dir
}

export function removeWorkers(): void {
  fs.rmSync(path.join(ROOT, 'out', 'test-workers', String(process.pid)), { recursive: true, force: true })
}

// ── Synthetic files ─────────────────────────────────────────────────────────────────────────────
function be32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}

/** A PNG header (signature + IHDR); enough for sniffing and serving, never decoded. */
export function png(width: number, height: number, extra = 64): Buffer {
  const ihdr = Buffer.concat([be32(13), Buffer.from('IHDR'), be32(width), be32(height), Buffer.from([8, 6, 0, 0, 0]), be32(0)])
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(extra, 7)])
}

/** A JPEG with an APP0 and an EXIF-sized APP1 segment before SOF0. */
export function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0'), Buffer.alloc(9, 1)])
  const exif = Buffer.alloc(3000, 0x41)
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([((exif.length + 2) >> 8) & 0xff, (exif.length + 2) & 0xff]), exif])
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, app1, sof, Buffer.alloc(32, 0), Buffer.from([0xff, 0xd9])])
}

export function gif(width: number, height: number): Buffer {
  const b = Buffer.alloc(32)
  b.write('GIF89a', 0, 'latin1')
  b.writeUInt16LE(width, 6)
  b.writeUInt16LE(height, 8)
  return b
}

export function webp(width: number, height: number): Buffer {
  const b = Buffer.alloc(40)
  b.write('RIFF', 0, 'latin1')
  b.writeUInt32LE(32, 4)
  b.write('WEBP', 8, 'latin1')
  b.write('VP8X', 12, 'latin1')
  b.writeUInt32LE(10, 16)
  b.writeUIntLE(width - 1, 24, 3)
  b.writeUIntLE(height - 1, 27, 3)
  return b
}

export function avif(width: number, height: number): Buffer {
  const ftyp = Buffer.concat([be32(24), Buffer.from('ftypavif'), be32(0), Buffer.from('mif1miaf')])
  const ispe = Buffer.concat([be32(20), Buffer.from('ispe'), be32(0), be32(width), be32(height)])
  const meta = Buffer.concat([be32(12 + ispe.length), Buffer.from('meta'), be32(0), ispe])
  return Buffer.concat([ftyp, meta, Buffer.alloc(16)])
}

/** A valid one-or-more-page PDF with Helvetica text (correct xref offsets). */
export function pdf(pages: string[]): Buffer {
  const objs: string[] = []
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')
  objs.push('<< /Type /Catalog /Pages 2 0 R >>')
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`)
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  pages.forEach((text, i) => {
    const content = `BT /F1 18 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`)
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  })
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** A minimal DOCX mammoth can read. `bodyXml` = paragraphs; `pad` adds a highly compressible part (bomb tests). */
export function docx(paragraphs: string[], o: { pad?: number } = {}): Buffer {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${esc(p)}</w:t></w:r></w:p>`).join('')
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    ),
    'word/document.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
    )
  }
  if (o.pad) files['word/padding.xml'] = new Uint8Array(o.pad).fill(0x20)
  return Buffer.from(zipSync(files, { level: 9 }))
}

// ── Multipart ───────────────────────────────────────────────────────────────────────────────────
export interface Part {
  name: string
  filename?: string
  type?: string
  data: Buffer | string
}

export function multipart(parts: Part[]): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----vesper${Math.random().toString(16).slice(2)}`
  const chunks: Buffer[] = []
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`
    if (p.filename !== undefined) head += `; filename="${p.filename}"`
    head += '\r\n'
    if (p.type) head += `Content-Type: ${p.type}\r\n`
    else if (p.filename !== undefined) head += 'Content-Type: application/octet-stream\r\n'
    chunks.push(Buffer.from(`${head}\r\n`), Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data), Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

/** One file upload (+ optional thumb/meta). */
export function upload(data: Buffer | string, filename: string, o: { type?: string; thumb?: Buffer; meta?: object } = {}): { payload: Buffer; headers: Record<string, string> } {
  const parts: Part[] = []
  if (o.meta) parts.push({ name: 'meta', data: JSON.stringify(o.meta) })
  parts.push({ name: 'file', filename, type: o.type ?? 'application/octet-stream', data })
  if (o.thumb) parts.push({ name: 'thumb', filename: 'thumb.jpg', type: 'image/jpeg', data: o.thumb })
  return multipart(parts)
}

export function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'))
      setTimeout(tick, 20)
    }
    tick()
  })
}

/** Is a process with this pid still running? */
export function alive(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
