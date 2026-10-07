/**
 * The extract process and its supervisor (07 B6, C19, D2) with the real worker script: PDF/DOCX/text extraction,
 * caps, timeout kill, crash isolation, DOCX bombs refused, idle exit, and no process/timer leak over many jobs. @R18 @R17
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ExtractorPool, type ExtractResult } from '@server/attachments/extractor'
import { fakeLog, fakePlatform, tempDir } from '../../fakes'
import { alive, buildWorkers, docx, pdf, removeWorkers, waitFor } from './helpers'

process.env.VESPER_TEST = '1'

let script = ''
let dir = ''
const platform = () => fakePlatform(dir)
const limits = { maxChars: 10_000, maxPages: 500 }

function write(name: string, data: Buffer | string): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, data)
  return p
}

function pool(o: Partial<{ timeoutMs: number; idleMs: number }> = {}) {
  const p = platform()
  const x = new ExtractorPool({ script, fork: (s, a, opts) => p.forkWorker(s, a, opts), log: fakeLog(), ...o })
  return { pool: x, platform: p, pids: () => p.workers.map((w) => w.handle.pid) }
}

beforeAll(() => {
  script = path.join(buildWorkers(), 'extract.process.js')
  dir = tempDir('vesper-extract-')
})
afterAll(() => removeWorkers())

describe('extraction', () => {
  it('PDF text via unpdf, DOCX via mammoth, text with charset sniffing', async () => {
    const { pool: x } = pool()
    try {
      const a = await x.extract(write('a.pdf', pdf(['Hello from page one', 'Second page text'])), 'pdf', limits)
      expect(a).toMatchObject({ ok: true, extractor: 'unpdf', truncated: false })
      expect((a as { text: string }).text).toContain('Hello from page one')
      expect((a as { text: string }).text).toContain('Second page text')
      const d = await x.extract(write('a.docx', docx(['First paragraph', 'Zweiter Absatz ü'])), 'docx', limits)
      expect(d).toMatchObject({ ok: true, extractor: 'mammoth' })
      expect((d as { text: string }).text).toMatch(/First paragraph\s+Zweiter Absatz ü/)
      const t = await x.extract(write('a.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9])), 'text', limits)
      expect(t).toEqual({ ok: true, text: 'café', truncated: false, extractor: 'text:windows-1252' })
      expect(x.counters.spawned).toBe(1)
    } finally {
      await x.close()
    }
  })

  it('caps output: characters and PDF pages', async () => {
    const { pool: x } = pool()
    try {
      const t = await x.extract(write('long.txt', 'x'.repeat(50_000)), 'text', { maxChars: 1000, maxPages: 500 })
      expect(t).toMatchObject({ ok: true, truncated: true })
      expect((t as { text: string }).text).toHaveLength(1000)
      const p = await x.extract(write('pages.pdf', pdf(['one', 'two', 'three', 'four'])), 'pdf', { maxChars: 10_000, maxPages: 2 })
      expect(p).toMatchObject({ ok: true, truncated: true })
      expect((p as { text: string }).text).not.toContain('three')
    } finally {
      await x.close()
    }
  })

  it('refuses a zip-bomb-ish DOCX from its central directory (07 B6)', async () => {
    const { pool: x } = pool()
    try {
      expect(await x.extract(write('bomb.docx', docx(['x'], { pad: 8 * 1024 * 1024 })), 'docx', limits)).toEqual({ ok: false, code: 'archive_refused' })
      expect(await x.extract(write('junk.pdf', Buffer.from('%PDF-1.4 garbage garbage')), 'pdf', limits)).toEqual({ ok: false, code: 'unreadable' })
      // The process survived both and still works.
      expect(await x.extract(write('ok.txt', 'still alive'), 'text', limits)).toMatchObject({ ok: true, text: 'still alive' })
      expect(x.counters.spawned).toBe(1)
    } finally {
      await x.close()
    }
  })
})

describe('supervision', () => {
  it('kills a hung job after the timeout; the next job gets a fresh process', async () => {
    const { pool: x, pids } = pool({ timeoutMs: 400 })
    try {
      const t0 = Date.now()
      expect(await x.extract(write('h.txt', 'x'), 'test:hang', limits)).toEqual({ ok: false, code: 'timeout' })
      expect(Date.now() - t0).toBeLessThan(5000)
      const first = pids()[0]
      await waitFor(() => !alive(first))
      expect(await x.extract(write('n.txt', 'next'), 'text', limits)).toMatchObject({ ok: true, text: 'next' })
      expect(x.counters).toMatchObject({ spawned: 2, timedOut: 1 })
    } finally {
      await x.close()
    }
  })

  it('a huge PDF that outlives its budget is killed (real parser path)', async () => {
    const { pool: x } = pool({ timeoutMs: 150 })
    try {
      const pages = Array.from({ length: 3000 }, (_, i) => `page ${i} ${'lorem ipsum '.repeat(20)}`)
      const r = await x.extract(write('huge.pdf', pdf(pages)), 'pdf', { maxChars: 50_000_000, maxPages: 5000 })
      expect(r).toEqual({ ok: false, code: 'timeout' })
    } finally {
      await x.close()
    }
  })

  it('a crash fails only the job in flight (crash isolation)', async () => {
    const { pool: x } = pool()
    try {
      const jobs: Promise<ExtractResult>[] = [
        x.extract(write('c.txt', 'x'), 'test:crash', limits),
        x.extract(write('after1.txt', 'after one'), 'text', limits),
        x.extract(write('after2.txt', '__vesper_test_crash__ again'), 'text', limits),
        x.extract(write('after3.txt', 'after three'), 'text', limits)
      ]
      const r = await Promise.all(jobs)
      expect(r.map((j) => (j.ok ? j.text : j.code))).toEqual(['crashed', 'after one', 'crashed', 'after three'])
      expect(x.counters.crashed).toBe(2)
    } finally {
      await x.close()
    }
  })

  it('exits after idling and when closed; a missing script fails fast', async () => {
    const { pool: x, pids } = pool({ idleMs: 150 })
    expect(await x.extract(write('i.txt', 'idle'), 'text', limits)).toMatchObject({ ok: true })
    expect(x.running).toBe(true)
    await waitFor(() => !x.running)
    await waitFor(() => !alive(pids()[0]))
    await x.close()
    expect(await x.extract(write('j.txt', 'closed'), 'text', limits)).toEqual({ ok: false, code: 'unavailable' })
    const missing = new ExtractorPool({ script: path.join(dir, 'nope.js'), fork: () => { throw new Error('must not fork') }, log: fakeLog() })
    expect(await missing.extract(write('k.txt', 'x'), 'text', limits)).toEqual({ ok: false, code: 'unavailable' })
    await missing.close()
  })

  it('leak check: 40 jobs use one process, and nothing is left after close @R17', async () => {
    const { pool: x, pids } = pool({ idleMs: 60_000 })
    const handlesBefore = (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo().filter((r) => r === 'Timeout').length
    for (let i = 0; i < 40; i++) {
      const r = await x.extract(write(`l${i}.txt`, `job ${i}`), 'text', limits)
      expect(r).toMatchObject({ ok: true, text: `job ${i}` })
    }
    expect(x.counters.spawned).toBe(1)
    expect(x.pending).toBe(0)
    await x.close()
    expect(x.running).toBe(false)
    await waitFor(() => pids().every((p) => !alive(p)))
    const handlesAfter = (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo().filter((r) => r === 'Timeout').length
    expect(handlesAfter).toBeLessThanOrEqual(handlesBefore)
  })
})
