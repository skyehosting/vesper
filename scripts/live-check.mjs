#!/usr/bin/env node
/**
 * npm run live-check — for the owner, with real keys (07 E10, 05 §11). Vesper's tests use mock services; this script
 * settles the few behaviours only real providers can, with one small request per risk, and prints a report:
 *
 *   elevenlabs   /with-timestamps returns usable character timing (the same checks Vesper runs on every reply:
 *                audio present, alignment ≥ 90 % of the characters sent, finite non-decreasing times), the
 *                audio-tag prefix is aligned separately, and the timing ends with the audio
 *   voyage       an embedding and a rerank work, and whether this key is on the free-trial limits (a burst of four
 *                tiny requests: 429 + Retry-After means 3 requests/minute — Vesper starts in that mode anyway)
 *   anthropic    a thinking turn that calls a tool is replayed byte for byte (thinking blocks with their signatures,
 *                the tool call, its result), then a third turn replays the whole history — what Vesper does
 *   llm          every other provider whose key is set: GET /models (free); with <ID>_MODEL set, a 1-token chat
 *   stt          cloud speech recognition (OpenAI, Groq, Deepgram, ElevenLabs Scribe) on tests/fixtures/audio/hello.wav
 *
 * Keys come ONLY from environment variables and are never written anywhere or printed (error bodies are reduced to a
 * status and a short message). Nothing runs without a key: with none set, the script prints what it would check and
 * exits 2. Never part of `npm test`. Costs: a few cents at most (≈ 70 ElevenLabs characters, three short Claude
 * requests, ~4 s of audio per speech service, < 200 Voyage tokens).
 *
 *   ANTHROPIC_API_KEY [ANTHROPIC_MODEL]         ELEVENLABS_API_KEY [ELEVENLABS_VOICE_ID] [ELEVENLABS_MODEL]
 *   VOYAGE_API_KEY                              OPENAI_API_KEY [OPENAI_MODEL]   GROQ_API_KEY [GROQ_MODEL]
 *   DEEPGRAM_API_KEY   GEMINI_API_KEY   OPENROUTER_API_KEY   MISTRAL_API_KEY   XAI_API_KEY   DEEPSEEK_API_KEY
 *   TOGETHER_API_KEY   (each with an optional <ID>_MODEL for the 1-token chat)
 *
 *   node scripts/live-check.mjs [--only elevenlabs,voyage,anthropic,llm,stt] [--help]
 *
 * This is a developer command for a source checkout (the installed app has no npm). LIVE_CHECK_MOCK_BASE (loopback
 * only) points every provider at the test mocks; the unit test uses it to run this script without keys.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HELLO_WAV = path.join(ROOT, 'tests', 'fixtures', 'audio', 'hello.wav')
const HELLO_TEXT = fs.existsSync(path.join(ROOT, 'tests', 'fixtures', 'audio', 'hello.txt')) ? fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'audio', 'hello.txt'), 'utf8').trim() : 'Hello Vesper, can you hear me?'
const TIMEOUT_MS = 45_000

// ── where each provider lives (mirrors src/shared/presets.ts and the provider clients) ─────────────────────────────
const MOCK = process.env.LIVE_CHECK_MOCK_BASE?.replace(/\/$/, '') ?? null
if (MOCK && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(MOCK)) {
  console.error('LIVE_CHECK_MOCK_BASE must be a loopback http:// origin (it exists for the unit test).')
  process.exit(2)
}
const BASE = {
  anthropic: MOCK ? `${MOCK}/anthropic` : 'https://api.anthropic.com',
  elevenlabs: MOCK ? `${MOCK}/elevenlabs` : 'https://api.elevenlabs.io',
  voyage: MOCK ? `${MOCK}/voyage/v1` : 'https://api.voyageai.com/v1'
}

/** OpenAI-compatible presets (src/shared/presets.ts): base URL and the output-cap field. */
const LLM = [
  { id: 'openai', label: 'OpenAI', env: 'OPENAI_API_KEY', base: 'https://api.openai.com/v1', capField: 'max_completion_tokens' },
  { id: 'gemini', label: 'Google Gemini', env: 'GEMINI_API_KEY', base: 'https://generativelanguage.googleapis.com/v1beta/openai', capField: 'max_tokens' },
  { id: 'openrouter', label: 'OpenRouter', env: 'OPENROUTER_API_KEY', base: 'https://openrouter.ai/api/v1', capField: 'max_tokens' },
  { id: 'groq', label: 'Groq', env: 'GROQ_API_KEY', base: 'https://api.groq.com/openai/v1', capField: 'max_tokens' },
  { id: 'mistral', label: 'Mistral', env: 'MISTRAL_API_KEY', base: 'https://api.mistral.ai/v1', capField: 'max_tokens' },
  { id: 'xai', label: 'xAI', env: 'XAI_API_KEY', base: 'https://api.x.ai/v1', capField: 'max_tokens' },
  { id: 'deepseek', label: 'DeepSeek', env: 'DEEPSEEK_API_KEY', base: 'https://api.deepseek.com', capField: 'max_tokens' },
  { id: 'together', label: 'Together', env: 'TOGETHER_API_KEY', base: 'https://api.together.ai/v1', capField: 'max_tokens' }
].map((p) => (MOCK ? { ...p, base: `${MOCK}/openai/v1` } : p))

/** Cloud speech recognition (src/server/providers/stt/cloud.ts): endpoint and Vesper's default model. */
const STT = [
  { id: 'openai', label: 'OpenAI transcription', env: 'OPENAI_API_KEY', url: 'https://api.openai.com/v1/audio/transcriptions', model: 'gpt-4o-mini-transcribe' },
  { id: 'groq', label: 'Groq Whisper', env: 'GROQ_API_KEY', url: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3-turbo' },
  { id: 'deepgram', label: 'Deepgram', env: 'DEEPGRAM_API_KEY', url: 'https://api.deepgram.com/v1/listen', model: 'nova-3' },
  { id: 'elevenlabs', label: 'ElevenLabs Scribe', env: 'ELEVENLABS_API_KEY', url: 'https://api.elevenlabs.io/v1/speech-to-text', model: 'scribe_v2' }
].map((p) => (MOCK ? { ...p, url: `${MOCK}/stt${new URL(p.url).pathname.replace(/^\/openai/, '')}` } : p))

// ── report ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/** @type {Array<{ group: string; name: string; status: 'PASS' | 'FAIL' | 'WARN' | 'SKIP'; detail: string }>} */
const results = []
function record(group, name, status, detail) {
  results.push({ group, name, status, detail })
  const mark = { PASS: 'PASS', FAIL: 'FAIL', WARN: 'WARN', SKIP: 'skip' }[status]
  console.log(`  ${mark.padEnd(4)}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const env = (name) => {
  const v = process.env[name]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** A short, key-free description of a failed response (never the raw body: some services echo the request). */
async function why(res) {
  let msg = ''
  try {
    const j = await res.json()
    const e = j?.error ?? j?.detail ?? j
    msg = typeof e === 'string' ? e : (e?.message ?? e?.status ?? e?.type ?? '')
  } catch {
    /* not JSON */
  }
  msg = String(msg).replace(/(sk|xi|pa|gsk|key)[-_A-Za-z0-9]{8,}/g, '…').slice(0, 160)
  const ra = res.headers.get('retry-after')
  return `HTTP ${res.status}${msg ? ` ${msg}` : ''}${ra ? ` (retry after ${ra} s)` : ''}`
}

async function call(url, init = {}) {
  return fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
}

// ── ElevenLabs: /with-timestamps alignment ──────────────────────────────────────────────────────────────────────────
const TAG_MODEL = /^eleven_v\d/ // models that take audio tags (src/server/providers/tts/elevenlabs.ts)

/** The checks Vesper runs on every /with-timestamps response (validAlignment, research 04 §9.2). */
function validAlignment(body, sent) {
  if (!body || typeof body.audio_base64 !== 'string' || !body.audio_base64) return 'no audio in the response'
  const a = body.alignment
  if (!a || !Array.isArray(a.characters) || !Array.isArray(a.character_start_times_seconds) || !Array.isArray(a.character_end_times_seconds)) return 'no alignment in the response'
  const n = a.characters.length
  if (a.character_start_times_seconds.length !== n || a.character_end_times_seconds.length !== n) return 'alignment arrays differ in length'
  if (n < 0.9 * Array.from(sent).length) return `alignment covers ${n} of ${Array.from(sent).length} characters (< 90 %)`
  let prev = -Infinity
  for (let i = 0; i < n; i++) {
    const s = a.character_start_times_seconds[i]
    const e = a.character_end_times_seconds[i]
    if (!Number.isFinite(s) || !Number.isFinite(e) || s < prev - 1e-6 || e < s - 1e-6) return `times not finite/non-decreasing at character ${i}`
    prev = s
  }
  return null
}

async function checkElevenLabs() {
  const key = env('ELEVENLABS_API_KEY')
  if (!key) return record('elevenlabs', 'ElevenLabs', 'SKIP', 'ELEVENLABS_API_KEY not set')
  const h = { 'xi-api-key': key, accept: 'application/json' }
  let model = env('ELEVENLABS_MODEL')
  const models = await call(`${BASE.elevenlabs}/v1/models`, { headers: h })
  if (!models.ok) return record('elevenlabs', 'ElevenLabs models', 'FAIL', await why(models))
  const list = (await models.json()) ?? []
  const tts = (Array.isArray(list) ? list : []).filter((m) => m?.can_do_text_to_speech === true && m?.requires_alpha_access !== true).map((m) => String(m.model_id))
  model ??= tts.find((m) => TAG_MODEL.test(m)) ?? (tts.includes('eleven_multilingual_v2') ? 'eleven_multilingual_v2' : tts[0])
  record('elevenlabs', 'ElevenLabs models', model ? 'PASS' : 'FAIL', model ? `${tts.length} speech models; checking ${model}${TAG_MODEL.test(model) ? ' (audio tags)' : ''}` : 'no speech model for this key')
  if (!model) return
  let voice = env('ELEVENLABS_VOICE_ID')
  if (!voice) {
    const v = await call(`${BASE.elevenlabs}/v2/voices?page_size=30`, { headers: h })
    if (!v.ok) return record('elevenlabs', 'ElevenLabs voices', 'FAIL', `${await why(v)} — the key needs "Voices: read" (or set ELEVENLABS_VOICE_ID)`)
    const voices = (await v.json())?.voices ?? []
    voice = (voices.find((x) => x?.category === 'premade') ?? voices[0])?.voice_id ?? null
    if (!voice) return record('elevenlabs', 'ElevenLabs voices', 'FAIL', 'no voice available to this key')
  }
  const prefix = TAG_MODEL.test(model) ? '[calm] ' : ''
  const text = 'Hello from Vesper. This is a short live check of the voice timing.'
  const body = { text: prefix + text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }
  const r = await call(`${BASE.elevenlabs}/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { ...h, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!r.ok) return record('elevenlabs', 'ElevenLabs /with-timestamps', 'FAIL', await why(r))
  const j = await r.json()
  const problem = validAlignment(j, prefix + text)
  if (problem) return record('elevenlabs', 'ElevenLabs /with-timestamps alignment', 'FAIL', `${problem} — Vesper would fall back to its own timing estimate (07 C14)`)
  const a = j.alignment
  const audioBytes = Buffer.from(j.audio_base64, 'base64').length
  const audioSec = (audioBytes * 8) / 128_000 // mp3 at 128 kb/s
  const lastEnd = a.character_end_times_seconds.at(-1) ?? 0
  const head = a.characters.slice(0, Array.from(prefix).length).join('')
  const notes = [`${a.characters.length} characters timed for ${Array.from(prefix + text).length} sent`, `last character ends at ${lastEnd.toFixed(2)} s of ~${audioSec.toFixed(2)} s audio`]
  if (prefix) notes.push(head === prefix ? 'the audio-tag prefix is aligned on its own (Vesper drops it)' : `the alignment does not start with the tag prefix ("${head}") — Vesper maps by characters, check the reveal`)
  const late = lastEnd > audioSec + 0.5
  record('elevenlabs', 'ElevenLabs /with-timestamps alignment', late || (prefix && head !== prefix) ? 'WARN' : 'PASS', notes.join('; '))
  const sub = await call(`${BASE.elevenlabs}/v1/user/subscription`, { headers: h })
  if (sub.ok) {
    const s = await sub.json()
    if (typeof s?.character_count === 'number' && typeof s?.character_limit === 'number') record('elevenlabs', 'ElevenLabs quota', 'PASS', `${s.character_count.toLocaleString()} of ${s.character_limit.toLocaleString()} characters used`)
  } else record('elevenlabs', 'ElevenLabs quota', 'WARN', `${await why(sub)} (Settings shows no remaining quota for this key; speech still works)`)
}

// ── Voyage: embed, rerank, free-trial limits ────────────────────────────────────────────────────────────────────────
async function checkVoyage() {
  const key = env('VOYAGE_API_KEY')
  if (!key) return record('voyage', 'Voyage', 'SKIP', 'VOYAGE_API_KEY not set')
  const h = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
  const embed = () =>
    call(`${BASE.voyage}/embeddings`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ input: ['Vesper live check: the harbour lights came on.'], model: 'voyage-4-lite', input_type: 'document', output_dimension: 1024, output_dtype: 'float', encoding_format: 'base64', truncation: true })
    })
  const e = await embed()
  if (!e.ok) return record('voyage', 'Voyage embeddings', 'FAIL', await why(e))
  const ej = await e.json()
  const b64 = ej?.data?.[0]?.embedding
  const dims = typeof b64 === 'string' ? Buffer.from(b64, 'base64').length / 4 : Array.isArray(b64) ? b64.length : 0
  record('voyage', 'Voyage embeddings (voyage-4-lite, 1024 dims)', dims === 1024 ? 'PASS' : 'FAIL', `${dims} dimensions, ${ej?.usage?.total_tokens ?? '?'} tokens`)
  const rr = await call(`${BASE.voyage}/rerank`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ query: 'Where did the ferry go?', documents: ['The ferry crossed the bay at dusk.', 'Tea is ready.'], model: 'rerank-3-lite', top_k: 2, return_documents: false, truncation: true })
  })
  if (!rr.ok) record('voyage', 'Voyage rerank', rr.status === 429 ? 'WARN' : 'FAIL', await why(rr))
  else {
    const top = (await rr.json())?.data?.[0]?.index
    record('voyage', 'Voyage rerank (rerank-3-lite)', top === 0 ? 'PASS' : 'WARN', top === 0 ? 'ranked the ferry first' : `unexpected order (top index ${top})`)
  }
  // Free-trial limits: 3 requests/minute. Two requests so far; two more right away.
  const burst = [await embed(), await embed()]
  const limited = burst.find((x) => x.status === 429)
  if (limited) record('voyage', 'Voyage limits', 'PASS', `free-trial limits in effect (${await why(limited)}) — Vesper's starting mode; add a payment method in Voyage to lift them`)
  else if (burst.every((x) => x.ok)) record('voyage', 'Voyage limits', 'PASS', 'no 429 on 4 requests in a few seconds: paid-tier limits; Vesper speeds up by itself')
  else record('voyage', 'Voyage limits', 'WARN', await why(burst.find((x) => !x.ok)))
}

// ── Anthropic: thinking + tool replay ───────────────────────────────────────────────────────────────────────────────
/** Which models get adaptive thinking (src/server/providers/llm/render.ts anthropicAdaptive). */
const adaptive = (m) => /^claude-(opus|sonnet|fable|mythos)-(5|4-[6-9])/.test(m)

async function checkAnthropic() {
  const key = env('ANTHROPIC_API_KEY')
  if (!key) return record('anthropic', 'Anthropic', 'SKIP', 'ANTHROPIC_API_KEY not set')
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey: key, baseURL: BASE.anthropic, maxRetries: 1, timeout: TIMEOUT_MS })
  const model = env('ANTHROPIC_MODEL') ?? 'claude-opus-5-5'
  try {
    const page = await client.models.list({ limit: 100 })
    const ids = page.data.map((m) => m.id)
    record('anthropic', 'Anthropic models', ids.includes(model) || MOCK ? 'PASS' : 'WARN', ids.includes(model) ? `${ids.length} models; checking ${model}` : `${model} is not in this key's list (${ids.slice(0, 4).join(', ')}…); set ANTHROPIC_MODEL`)
  } catch (e) {
    return record('anthropic', 'Anthropic models', 'FAIL', errText(e))
  }
  const tools = [
    {
      name: 'get_local_time',
      description: 'The current local time in a city. Always use it for questions about the time.',
      input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false }
    }
  ]
  // The request shape Vesper sends (anthropic.ts): adaptive thinking + effort on models that support them.
  const shape = adaptive(model) ? { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'low' } } : { thinking: { type: 'enabled', budget_tokens: 1024 } }
  const req = (messages) => client.messages.create({ model, max_tokens: 16000, tools, tool_choice: { type: 'auto' }, messages, ...shape })
  const messages = [{ role: 'user', content: 'What time is it in Tokyo right now? Use the get_local_time tool.' }]
  let first
  try {
    first = await req(messages)
  } catch (e) {
    return record('anthropic', `Anthropic thinking turn (${model})`, 'FAIL', errText(e))
  }
  if (first.stop_reason === 'refusal') return record('anthropic', 'Anthropic thinking turn', 'WARN', 'the model declined this harmless prompt; run again')
  const thinking = first.content.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking')
  const signed = thinking.filter((b) => b.type === 'redacted_thinking' || (typeof b.signature === 'string' && b.signature.length > 0))
  const toolUse = first.content.find((b) => b.type === 'tool_use')
  record('anthropic', 'Anthropic thinking turn', thinking.length && signed.length === thinking.length ? 'PASS' : 'WARN', `${thinking.length} thinking block(s), ${signed.length} signed; ${toolUse ? 'called get_local_time' : 'answered without the tool'}`)
  // Byte-for-byte replay: the assistant content exactly as received, then the tool result.
  messages.push({ role: 'assistant', content: first.content })
  if (toolUse) messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify({ city: 'Tokyo', time: '21:04', timezone: 'Asia/Tokyo' }) }] })
  else messages.push({ role: 'user', content: 'Thanks. And what about Paris?' })
  let second
  try {
    second = await req(messages)
  } catch (e) {
    return record('anthropic', 'Anthropic replay of thinking + tool call', 'FAIL', `${errText(e)} — Vesper's replay of this turn would fail the same way`)
  }
  record('anthropic', 'Anthropic replay of thinking + tool call', 'PASS', `accepted (stop: ${second.stop_reason})`)
  messages.push({ role: 'assistant', content: second.content })
  messages.push({ role: 'user', content: 'Thanks! One more: is it morning or evening there?' })
  try {
    const third = await req(messages)
    record('anthropic', 'Anthropic long-history replay', 'PASS', `the whole history (${messages.length} messages, thinking blocks included) was accepted (stop: ${third.stop_reason})`)
  } catch (e) {
    record('anthropic', 'Anthropic long-history replay', 'FAIL', errText(e))
  }
}

function errText(e) {
  const status = e?.status ? `HTTP ${e.status} ` : ''
  const msg = String(e?.error?.error?.message ?? e?.message ?? e).replace(/(sk-ant)[-_A-Za-z0-9]{8,}/g, '…').slice(0, 200)
  return `${status}${msg}`
}

// ── other LLM providers (OpenAI-compatible) ─────────────────────────────────────────────────────────────────────────
async function checkLlm() {
  let any = false
  for (const p of LLM) {
    const key = env(p.env)
    if (!key) continue
    any = true
    const h = { authorization: `Bearer ${key}` }
    const r = await call(`${p.base}/models`, { headers: h })
    if (!r.ok) {
      record('llm', `${p.label} /models`, 'FAIL', await why(r))
      continue
    }
    const ids = ((await r.json())?.data ?? []).map((m) => m?.id).filter(Boolean)
    record('llm', `${p.label} /models`, ids.length ? 'PASS' : 'WARN', `${ids.length} models`)
    const model = env(`${p.id.toUpperCase()}_MODEL`)
    if (!model) continue
    const c = await call(`${p.base}/chat/completions`, {
      method: 'POST',
      headers: { ...h, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with OK.' }], [p.capField]: p.id === 'openai' ? 16 : 1 })
    })
    record('llm', `${p.label} chat (${model})`, c.ok ? 'PASS' : 'FAIL', c.ok ? 'answered' : await why(c))
  }
  if (!any) record('llm', 'Other AI providers', 'SKIP', `none of ${LLM.map((p) => p.env).join(', ')} set`)
}

// ── cloud speech recognition ────────────────────────────────────────────────────────────────────────────────────────
function words(s) {
  return s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean)
}

async function checkStt() {
  const wav = fs.readFileSync(HELLO_WAV)
  let any = false
  for (const p of STT) {
    const key = env(p.env)
    if (!key) continue
    any = true
    const blob = new Blob([wav], { type: 'audio/wav' })
    let r
    if (p.id === 'deepgram') {
      const q = new URLSearchParams({ model: p.model, smart_format: 'true', punctuate: 'true', mip_opt_out: 'true', detect_language: 'true' })
      r = await call(`${p.url}?${q}`, { method: 'POST', headers: { authorization: `Token ${key}`, 'content-type': 'audio/wav' }, body: blob })
    } else {
      const form = new FormData()
      if (p.id === 'elevenlabs') {
        form.append('model_id', p.model)
        form.append('file', blob, 'speech.wav')
        form.append('tag_audio_events', 'false')
      } else {
        form.append('file', blob, 'speech.wav')
        form.append('model', p.model)
        form.append('response_format', 'json')
      }
      r = await call(p.url, { method: 'POST', headers: p.id === 'elevenlabs' ? { 'xi-api-key': key } : { authorization: `Bearer ${key}` }, body: form })
    }
    if (!r.ok) {
      record('stt', `${p.label} (${p.model})`, 'FAIL', await why(r))
      continue
    }
    const j = await r.json()
    const text = p.id === 'deepgram' ? (j?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '') : (j?.text ?? '')
    const want = words(HELLO_TEXT)
    const got = new Set(words(text))
    const hit = want.filter((w) => got.has(w)).length / want.length
    record('stt', `${p.label} (${p.model})`, hit >= 0.6 ? 'PASS' : 'WARN', `heard "${String(text).trim().slice(0, 80)}" (${Math.round(hit * 100)} % of the words)`)
  }
  if (!any) record('stt', 'Cloud speech recognition', 'SKIP', 'none of OPENAI_API_KEY, GROQ_API_KEY, DEEPGRAM_API_KEY, ELEVENLABS_API_KEY set')
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const GROUPS = { elevenlabs: checkElevenLabs, voyage: checkVoyage, anthropic: checkAnthropic, llm: checkLlm, stt: checkStt }
const KEY_VARS = ['ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY', 'VOYAGE_API_KEY', 'DEEPGRAM_API_KEY', ...LLM.map((p) => p.env)]

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n/, '').replace(/^ \* ?/gm, ''))
    return 0
  }
  const onlyArg = args.find((a) => a.startsWith('--only'))
  const only = onlyArg ? (onlyArg.includes('=') ? onlyArg.split('=')[1] : args[args.indexOf(onlyArg) + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : Object.keys(GROUPS)
  const unknown = only.filter((g) => !(g in GROUPS))
  if (unknown.length) {
    console.error(`Unknown check(s): ${unknown.join(', ')}. Known: ${Object.keys(GROUPS).join(', ')}`)
    return 2
  }
  const present = KEY_VARS.filter((k) => env(k))
  if (!present.length) {
    console.log('Vesper live check: no API keys in the environment, so nothing was called.')
    console.log(`Set any of ${KEY_VARS.join(', ')} for this command only, e.g. in PowerShell:`)
    console.log('  $env:ELEVENLABS_API_KEY = "…"; $env:VOYAGE_API_KEY = "…"; npm run live-check')
    console.log('Keys are read from the environment only and are never saved or printed.')
    return 2
  }
  console.log(`Vesper live check${MOCK ? ` (MOCK services at ${MOCK})` : ''} — keys found: ${present.join(', ')}`)
  console.log('A few small paid requests follow (cents at most). Keys are never saved or printed.\n')
  for (const g of only) {
    console.log(`${g}`)
    try {
      await GROUPS[g]()
    } catch (e) {
      record(g, `${g} check`, 'FAIL', `${e?.name === 'TimeoutError' ? 'timed out' : errText(e)}`)
    }
    console.log('')
  }
  const count = (s) => results.filter((r) => r.status === s).length
  console.log(`Summary: ${count('PASS')} passed, ${count('WARN')} to look at, ${count('FAIL')} failed, ${count('SKIP')} skipped.`)
  if (count('FAIL')) console.log('A failure names the service and the HTTP status; Settings → the same service → Test shows the same problem in the app.')
  return count('FAIL') ? 1 : 0
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`live-check crashed: ${errText(e)}`)
    process.exit(1)
  }
)
