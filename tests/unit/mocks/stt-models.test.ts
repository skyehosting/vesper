import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startMockServer, type MockServer } from '../../mocks/server'
import { encodeWav, synthSpeech } from '../../mocks/audio'
import { removeTempDirs, tempDir } from '../../fakes'

let mock: MockServer
beforeAll(async () => {
  mock = await startMockServer()
})
afterAll(async () => {
  await mock.close()
  removeTempDirs()
})
beforeEach(() => mock.reset())

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

describe('mock STT', () => {
  it('returns scripted transcripts for a multipart upload and records the audio', async () => {
    mock.stt.script('first words')
    const form = new FormData()
    form.append('file', new Blob([encodeWav(synthSpeech('one two').pcm, 16000)], { type: 'audio/wav' }), 'clip.wav')
    form.append('model', 'whisper-1')
    const r1 = (await (await fetch(`${mock.url}/v1/audio/transcriptions`, { method: 'POST', headers: { authorization: 'Bearer k' }, body: form })).json()) as { text: string }
    expect(r1.text).toBe('first words')
    const r2 = (await (await fetch(`${mock.url}/openai/v1/audio/transcriptions`, { method: 'POST', headers: { authorization: 'Bearer k' }, body: form })).json()) as { text: string }
    expect(r2.text).toBe('hello from the mock microphone')
    const rec = mock.stt.received()
    expect(rec).toHaveLength(2)
    expect(rec[0].filename).toBe('clip.wav')
    expect(rec[0].durationMs).toBeGreaterThan(0)
    expect((await fetch(`${mock.url}/v1/audio/transcriptions`, { method: 'POST', body: form })).status).toBe(401)
  })
})

describe('mock GitHub model downloads', () => {
  it('redirects like a release asset and serves bytes with the published SHA-256', async () => {
    const f = mock.models.fixture('ok')
    const res = await fetch(f.url) // follows the 302 to the CDN path
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(res.status).toBe(200)
    expect(bytes.length).toBe(f.size)
    expect(sha(bytes)).toBe(f.sha256)
    const manual = await fetch(f.url, { redirect: 'manual' })
    expect(manual.status).toBe(302)
    expect(manual.headers.get('location')).toBe(f.directUrl)
    expect(mock.models.catalogEntry().files[0]).toMatchObject({ url: f.url, sha256: f.sha256, size: f.size, archive: 'tar.bz2' })
  })

  it('supports Range resume and connection drops', async () => {
    const f = mock.models.fixture('ok')
    mock.models.dropNextAfter(1000)
    await expect(fetch(f.directUrl).then((r) => r.arrayBuffer())).rejects.toThrow()
    const part = await fetch(f.directUrl, { headers: { range: 'bytes=1000-' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 1000-${f.size - 1}/${f.size}`)
    const rest = new Uint8Array(await part.arrayBuffer())
    expect(Buffer.compare(Buffer.from(rest), f.bytes.subarray(1000))).toBe(0)
    expect(mock.models.rangesRequested()).toEqual([null, 'bytes=1000-'])
  })

  it('offers a tampered archive (same size, wrong hash) and archives that must be refused', () => {
    const ok = mock.models.fixture('ok')
    const bad = mock.models.fixture('tampered')
    expect(bad.size).toBe(ok.size)
    expect(bad.sha256).toBe(ok.sha256) // the published digest...
    expect(sha(bad.bytes)).not.toBe(ok.sha256) // ...does not match the bytes
    const dir = tempDir()
    const list = (kind: 'ok' | 'traversal' | 'link'): string => {
      const file = path.join(dir, `${kind}.tar.bz2`)
      fs.writeFileSync(file, mock.models.fixture(kind).bytes)
      return execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-tvf', file], { encoding: 'utf8' })
    }
    expect(list('ok')).toContain('sherpa-onnx-mock-model/tokens.txt')
    expect(list('traversal')).toContain('../escape.txt')
    expect(list('link')).toMatch(/outside -> \.\.\/\.\.\/outside\.txt/)
  })
})
