/**
 * Mock cloud speech-to-text (owner: voice-in-server; foundation version by test-infra), one scripted transcript queue
 * for every provider shape (research 05 §2.7):
 *   OpenAI / Groq   POST …/audio/transcriptions   multipart {file, model, language?, response_format?}, Bearer
 *   Deepgram        POST /v1/listen?model=…       raw audio body, `Authorization: Token <key>`, query recorded
 *   ElevenLabs      POST /v1/speech-to-text       multipart {file, model_id, language_code?}, `xi-api-key`
 */
import type { ServerResponse } from 'node:http'
import { bearer, header, sendJson, sendText, sleep, type MockRequest } from './http'
import { parseWav } from './audio'
import type { MockModule } from './module'

export interface SttReceived {
  provider: 'openai' | 'deepgram' | 'elevenlabs'
  model: string
  filename: string
  bytes: number
  /** Duration when the upload is a parseable PCM16 WAV. */
  durationMs: number | null
  language: string | null
  /** Deepgram query parameters (07 B18: mip_opt_out must be "true"). */
  query?: Record<string, string>
}

export interface SttMock {
  /** Queue transcripts, one per request; when empty the default is returned. */
  script(...texts: string[]): void
  setDefault(text: string): void
  failNext(status: 401 | 429 | 500, count?: number): void
  setDelay(ms: number): void
  received(): SttReceived[]
}

export const DEFAULT_TRANSCRIPT = 'hello from the mock microphone'

interface Part {
  name: string
  filename: string | null
  data: Buffer
}

/** Minimal multipart/form-data parser (enough for the fields an STT client sends). */
export function parseMultipart(body: Buffer, contentType: string | undefined): Part[] {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '')
  if (!m) return []
  const boundary = Buffer.from(`--${m[1] ?? m[2]}`)
  const parts: Part[] = []
  let pos = body.indexOf(boundary)
  while (pos >= 0) {
    const start = pos + boundary.length
    if (body.subarray(start, start + 2).toString() === '--') break
    const headEnd = body.indexOf('\r\n\r\n', start)
    if (headEnd < 0) break
    const next = body.indexOf(boundary, headEnd)
    if (next < 0) break
    const head = body.subarray(start, headEnd).toString('utf8')
    const name = /name="([^"]*)"/i.exec(head)?.[1] ?? ''
    const filename = /filename="([^"]*)"/i.exec(head)?.[1] ?? null
    parts.push({ name, filename, data: body.subarray(headEnd + 4, next - 2) })
    pos = next
  }
  return parts
}

function wavDuration(bytes: Buffer): number | null {
  try {
    const w = parseWav(bytes)
    return (w.pcm.length / w.channels / w.sampleRate) * 1000
  } catch {
    return null
  }
}

function openaiError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: { message, type: status === 429 ? 'requests' : 'invalid_request_error', param: null, code: null } })
}

export function createSttMock(): SttMock & MockModule {
  let queue: string[] = []
  let fallback = DEFAULT_TRANSCRIPT
  let failures: number[] = []
  let delayMs = 0
  let received: SttReceived[] = []

  async function transcribe(req: MockRequest, res: ServerResponse): Promise<void> {
    if (!bearer(req)) return openaiError(res, 401, 'Missing bearer authentication in header')
    const parts = parseMultipart(req.body, header(req, 'content-type'))
    const field = (n: string): string | null => parts.find((p) => p.name === n)?.data.toString('utf8') ?? null
    const file = parts.find((p) => p.name === 'file')
    if (!file) return openaiError(res, 400, "Missing required parameter: 'file'.")
    const model = field('model')
    if (!model) return openaiError(res, 400, "Missing required parameter: 'model'.")
    const fail = failures.shift()
    if (fail) return openaiError(res, fail, `Mock failure ${fail}.`)
    if (delayMs) await sleep(delayMs)
    const durationMs = wavDuration(file.data)
    received.push({ provider: 'openai', model, filename: file.filename ?? '', bytes: file.data.length, durationMs, language: field('language') })
    const text = queue.shift() ?? fallback
    const format = field('response_format') ?? 'json'
    const duration = (durationMs ?? 1000) / 1000
    if (format === 'text') return sendText(res, 200, text)
    if (format === 'verbose_json')
      return sendJson(res, 200, { task: 'transcribe', language: field('language') ?? 'english', duration, text, segments: [{ id: 0, seek: 0, start: 0, end: duration, text, no_speech_prob: 0.01 }] })
    if (format === 'srt' || format === 'vtt') return sendText(res, 200, `${format === 'vtt' ? 'WEBVTT\n\n' : '1\n'}00:00:00.000 --> 00:00:0${Math.min(9, Math.ceil(duration))}.000\n${text}\n`)
    sendJson(res, 200, { text, usage: { type: 'duration', seconds: Math.ceil(duration) } })
  }

  async function deepgram(req: MockRequest, res: ServerResponse): Promise<void> {
    const auth = header(req, 'authorization') ?? ''
    if (!/^Token\s+\S+/i.test(auth)) return sendJson(res, 401, { err_code: 'INVALID_AUTH', err_msg: 'Invalid credentials.' })
    const fail = failures.shift()
    if (fail) return sendJson(res, fail, { err_code: 'MOCK', err_msg: `Mock failure ${fail}.` })
    if (!req.body.length) return sendJson(res, 400, { err_code: 'Bad Request', err_msg: 'Empty audio.' })
    if (delayMs) await sleep(delayMs)
    const query = Object.fromEntries(req.query)
    const durationMs = wavDuration(req.body)
    received.push({ provider: 'deepgram', model: query.model ?? '', filename: '', bytes: req.body.length, durationMs, language: query.language ?? null, query })
    const text = queue.shift() ?? fallback
    sendJson(res, 200, {
      metadata: { request_id: 'mock', duration: (durationMs ?? 0) / 1000, channels: 1 },
      results: { channels: [{ alternatives: [{ transcript: text, confidence: 0.99, words: [] }] }] }
    })
  }

  async function elevenlabs(req: MockRequest, res: ServerResponse): Promise<void> {
    if (!header(req, 'xi-api-key')) return sendJson(res, 401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } })
    const fail = failures.shift()
    if (fail) return sendJson(res, fail, { detail: { status: 'mock_failure', message: `Mock failure ${fail}.` } })
    const parts = parseMultipart(req.body, header(req, 'content-type'))
    const field = (n: string): string | null => parts.find((p) => p.name === n)?.data.toString('utf8') ?? null
    const file = parts.find((p) => p.name === 'file')
    const model = field('model_id')
    if (!file || !model) return sendJson(res, 422, { detail: [{ loc: ['body', file ? 'model_id' : 'file'], msg: 'field required' }] })
    if (delayMs) await sleep(delayMs)
    const durationMs = wavDuration(file.data)
    received.push({ provider: 'elevenlabs', model, filename: file.filename ?? '', bytes: file.data.length, durationMs, language: field('language_code') })
    const text = queue.shift() ?? fallback
    sendJson(res, 200, { language_code: field('language_code') ?? 'eng', language_probability: 0.98, text, words: [] })
  }

  return {
    name: 'stt',
    prefixes: ['stt', 'openai', 'groq'],
    script(...texts) {
      queue.push(...texts)
    },
    setDefault(text) {
      fallback = text
    },
    failNext(status, count = 1) {
      for (let i = 0; i < count; i++) failures.push(status)
    },
    setDelay(ms) {
      delayMs = ms
    },
    received() {
      return [...received]
    },
    reset() {
      queue = []
      fallback = DEFAULT_TRANSCRIPT
      failures = []
      delayMs = 0
      received = []
    },
    async handle(req, res) {
      if (req.method !== 'POST') return false
      if (req.path.endsWith('/audio/transcriptions')) await transcribe(req, res)
      else if (req.path === '/v1/listen' && (req.forced === null || req.forced === 'stt')) await deepgram(req, res)
      else if (req.path === '/v1/speech-to-text' && (req.forced === null || req.forced === 'stt')) await elevenlabs(req, res)
      else return false
      return true
    }
  }
}
