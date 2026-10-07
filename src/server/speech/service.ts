/**
 * SpeechService (07 E2, C14/C15/C22): opens a SpeechJob per spoken reply, resolves provider/voice/model from settings
 * and per-session overrides, keeps the session's last tone in memory only (07 A3) — after a restart it is read back
 * from the chat's wire transcript, never stored anywhere else (H-v11-tone) — caches voice lists (kv, 24 h),
 * and serves the setup endpoints (voices, preview proxy, sample, provider test, key validation).
 */
import { randomBytes } from 'node:crypto'
import { baseUrlProblem } from '@shared/settings'
import { VesperError } from '@shared/errors'
import { stripControlTags } from '@shared/tags'
import type { ProviderTestResult, Voice } from '@shared/types/domain'
import type { SpeechMime } from '@shared/ws'
import type { ServerContext, SpeechService, SpeechSink, SpeechSinkEvent, SpeechTarget, WsClient } from '../services'
import { findMessage } from '../chat/temporary'
import { createTtsProviders, isTtsProvider, type ProviderDeps, type TtsProvider, type TtsProviders, type VoiceList } from '../providers/tts'
import { ELEVEN_BASE, OPENAI_BASE, fetchBytes, isAbort, transportUrl } from '../providers/tts/http'
import { isTestMode } from '../testMode'
import { sniffMime } from './audio'
import { SpeechJob, type JobOutcome } from './job'
import { spokenOf } from './spoken'
import { toMessage } from '../http/convert'
import { speakingToneMode } from '@shared/voiceTone'
import type { WireBlock } from '@shared/types/wire'

/** The last `[tone=…]` value in assistant text blocks (07 A3: the transcript is the only place a tag is kept). */
export function lastToneOf(blocks: readonly WireBlock[]): string | null {
  let tone: string | null = null
  for (const b of blocks) if (b.t === 'text') for (const t of stripControlTags(b.text).tags) if (t.name === 'tone' && t.attrs.value) tone = t.attrs.value
  return tone
}

const VOICES_TTL_MS = 24 * 60 * 60_000
const KV_PREFIX = 'tts.voices.v1.'
const MAX_SESSION_TONES = 500
const SAMPLE_MAX_CHARS = 300
const MAX_SAMPLES_IN_FLIGHT = 2
const LIST_TIMEOUT_MS = 15_000
/** tts.prewarm (07 D6): at most one warm-up per provider this often; each one gives up after PREWARM_TIMEOUT_MS. */
const PREWARM_EVERY_MS = 30_000
const PREWARM_TIMEOUT_MS = 5_000
/**
 * Replies whose synthesis completed are remembered this long (at most RECENT_MAX), because their audio usually still
 * plays: synthesis outruns playback, so a barge-in (speech.cancel) mostly arrives after the job finished (07 C15).
 */
const RECENT_MS = 15 * 60_000
const RECENT_MAX = 64

interface CacheEntry {
  at: number
  list: VoiceList
}

export interface SpeechServiceOptions {
  /** Provider registry override (tests). */
  providers?: TtsProviders
  /** Extra provider deps (tests: fake PowerShell runner, platform). */
  providerDeps?: Partial<ProviderDeps>
  maxInFlight?: number
}

export interface SpeechServiceImpl extends SpeechService {
  /** speech.textFirst: `clientId` gave up on the reply's audio (07 C14); the other speakers keep theirs. */
  textFirst(replyId: string, clientId: string): void
  /** speech.replay: returns the new replyId. */
  replayFor(messageUid: string, client: WsClient): Promise<string>
  played(replyId: string, index: number, revealedChars: number): void
  clientGone(clientId: string): void
  sample(o: { provider?: string; voiceId?: string; text: string }, signal: AbortSignal): Promise<{ audio: Uint8Array; mime: SpeechMime }>
  preview(provider: string, voiceId: string, signal: AbortSignal): Promise<{ audio: Uint8Array; mime: string }>
  test(input: Record<string, unknown>, signal: AbortSignal): Promise<ProviderTestResult>
  /**
   * tts.prewarm (07 D6, Talk mode opened): start the Windows voice host, or open a connection to the HTTP provider
   * (TLS handshake done before the first chunk) and refresh a stale voice list. Best effort, throttled.
   */
  prewarm(): Promise<void>
  validateKey(name: string, value: string, url: string): Promise<void>
  keySaved(name: string): Promise<void>
  keyDeleted(name: string): Promise<void>
  readonly providers: TtsProviders
  stats(): { jobs: number; sessionTones: number; listsInFlight: number; samples: number; prewarming: number; recent: number }
  job(replyId: string): SpeechJob | undefined
}

/** Provider id of a secret name (`tts:elevenlabs` → elevenlabs), or null. */
export function providerOfSecret(name: string): string | null {
  const id = name.startsWith('tts:') ? name.slice(4) : ''
  return isTtsProvider(id) ? id : null
}

function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; done(): void } {
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const t = setTimeout(() => ac.abort(), ms)
  return {
    signal: ac.signal,
    done() {
      clearTimeout(t)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

export function createSpeechService(ctx: ServerContext, o: SpeechServiceOptions = {}): SpeechServiceImpl {
  const log = ctx.log.child('speech')
  const providers =
    o.providers ??
    createTtsProviders({
      secrets: ctx.secrets,
      settings: ctx.settings,
      log,
      resourcesDir: ctx.platform.resourcesDir,
      tempDir: `${ctx.paths.temp}/tts`,
      ...o.providerDeps
    })
  const jobs = new Map<string, SpeechJob>()
  /** Completed jobs whose audio may still be playing: replyId → target + when synthesis completed. */
  const recent = new Map<string, { target: SpeechTarget; at: number }>()
  const sessionTones = new Map<string, string>()
  /** Chats whose transcript had no tone when last looked at (H-v11-tone): not scanned again until a tag arrives. */
  const toneless = new Set<string>()
  const cache = new Map<string, CacheEntry>()
  const listing = new Map<string, Promise<VoiceList>>()
  let samples = 0
  let closed = false
  const lastPrewarm = new Map<string, number>()
  const prewarming = new Set<Promise<void>>()
  /** Aborts provider list calls still running at shutdown. */
  const life = new AbortController()

  function rememberTone(sessionUid: string, tone: string): void {
    toneless.delete(sessionUid)
    sessionTones.delete(sessionUid)
    sessionTones.set(sessionUid, tone)
    if (sessionTones.size > MAX_SESSION_TONES) sessionTones.delete(sessionTones.keys().next().value as string)
  }

  /** Epochs looked through for a chat's last tone after a restart (the current one and the one before). */
  const TONE_LOOKBACK_EPOCHS = 2

  /**
   * The chat's tone before `target.messageUid` when it is not in memory (a restart, or the chat was evicted): the
   * latest tag in its transcript on the active path before that message (H-v11-tone). A new reply's tone is
   * remembered in memory again (`remember`); a replay of an older reply's is not.
   */
  function transcriptTone(target: SpeechTarget, remember = true): string | null {
    if (!target.messageUid || (remember && toneless.has(target.sessionUid))) return null
    try {
      const found = findMessage(ctx, target.messageUid)
      if (!found) return null
      const repos = found.store.repos
      const epochs = repos.epochs.onPath(found.message.sessionId)
      for (let i = epochs.length - 1; i >= Math.max(0, epochs.length - TONE_LOOKBACK_EPOCHS); i--) {
        const rows = repos.transcript.forEpoch(epochs[i])
        const own = rows.findIndex((r) => r.messageId === found.message.id)
        for (let j = (own < 0 ? rows.length : own) - 1; j >= 0; j--) {
          const r = rows[j]
          if (r.role !== 'assistant') continue
          const tone = lastToneOf(r.blocks)
          if (tone) {
            if (remember) rememberTone(target.sessionUid, tone)
            return tone
          }
        }
      }
      if (remember) {
        toneless.add(target.sessionUid)
        if (toneless.size > MAX_SESSION_TONES) toneless.delete(toneless.values().next().value as string)
      }
    } catch (e) {
      log.debug('could not read the chat tone from its transcript', { error: e })
    }
    return null
  }

  async function voiceList(pid: string, refresh = false): Promise<VoiceList> {
    const p = providers.get(pid)
    if (!refresh) {
      const hit = cache.get(pid) ?? ctx.repos.kv.get<CacheEntry>(KV_PREFIX + pid)
      if (hit && Array.isArray(hit.list?.voices) && ctx.clock.now() - hit.at < VOICES_TTL_MS) {
        cache.set(pid, hit)
        return hit.list
      }
    }
    let running = listing.get(pid)
    if (!running) {
      const t = withTimeout(life.signal, LIST_TIMEOUT_MS)
      running = p
        .list(t.signal)
        .then((list) => {
          const entry = { at: ctx.clock.now(), list }
          cache.set(pid, entry)
          ctx.repos.kv.set(KV_PREFIX + pid, entry)
          return list
        })
        .finally(() => {
          t.done()
          listing.delete(pid)
        })
      listing.set(pid, running)
    }
    return running
  }

  function publicList(pid: string, l: VoiceList): { provider: string; voices: Voice[]; models: VoiceList['models']; quota?: { used: number; limit: number } } {
    return { provider: pid, voices: l.voices, models: l.models, ...(l.quota ? { quota: l.quota } : {}) }
  }

  interface Resolved {
    provider: TtsProvider
    voiceId: string | null
    model: string | null
  }

  async function resolve(override: { provider: string; voiceId: string; model?: string } | null | undefined, talkMode: boolean, explicit?: { provider?: string; voiceId?: string }): Promise<Resolved> {
    const tts = ctx.settings.get().voice.tts
    const wanted = explicit?.provider ?? (override && isTtsProvider(override.provider) ? override.provider : tts.provider)
    const provider = providers.get(wanted)
    const own = wanted === tts.provider
    let voiceId: string | null = explicit?.voiceId ?? (override?.provider === wanted ? override.voiceId : own ? tts.voiceId : null)
    let model: string | null = override?.provider === wanted && override.model ? override.model : own ? tts.model : null
    const fast = talkMode && tts.fastModelInTalk && wanted === 'elevenlabs'
    if (!voiceId || !model || fast) {
      const list = await voiceList(wanted).catch((e: unknown) => {
        log.debug('voice list unavailable', { provider: wanted, code: ctx.toApiError(e).code })
        return { voices: [], models: [] } as VoiceList
      })
      if (fast) model = provider.defaultModel(list, true) ?? model
      model ??= provider.defaultModel(list, false)
      voiceId ??= provider.defaultVoice(list, model)
    }
    return { provider, voiceId, model }
  }

  /**
   * 07 C15: the reply was interrupted after `spokenChars` characters. Replays ("speak again", `rp_…`) are not
   * recorded: the reply was heard in full before, and its next turn needs no "(The user interrupted…)" note.
   * `after` = the barge-in came after synthesis completed (the turn has ended, so the stored body is final and the chat
   * engine no longer watches): clamp to the body, ignore "everything was heard", and tell the clients.
   */
  function persistInterruption(target: SpeechTarget, spokenChars: number, after = false): void {
    if (!target.messageUid || target.replyId.startsWith('rp_')) return
    try {
      const found = findMessage(ctx, target.messageUid)
      if (!found || found.message.role !== 'assistant') return
      let n = Math.max(0, Math.trunc(spokenChars))
      if (after) {
        const len = found.message.body.length
        if (len > 0 && n >= len) return
        n = Math.min(n, len)
      }
      const m = found.store.repos.messages.update(found.message.id, { spokenChars: n, interrupted: true })
      if (after) ctx.hub.emit(target.sessionUid, { t: 'message.updated', sessionUid: target.sessionUid, message: toMessage(m, target.sessionUid) })
    } catch (e) {
      log.warn('could not record the interruption', { error: e })
    }
  }

  function rememberCompleted(target: SpeechTarget): void {
    if (!target.messageUid || target.replyId.startsWith('rp_')) return
    const now = ctx.clock.now()
    for (const [id, r] of recent) if (now - r.at > RECENT_MS || recent.size >= RECENT_MAX) recent.delete(id)
    recent.set(target.replyId, { target, at: now })
  }

  function openJob(
    target: SpeechTarget,
    opts: {
      voiceOverride?: { provider: string; voiceId: string; model?: string } | null
      talkMode: boolean
      initialTone?: string | null
      explicit?: { provider?: string; voiceId?: string }
      onEvent?: (e: SpeechSinkEvent) => void
    }
  ): SpeechJob {
    jobs.get(target.replyId)?.abort('stopped')
    const tts = ctx.settings.get().voice.tts
    // H-v11-tone: the mode in force for the voice this reply is spoken with ('off' when it can't use a tone).
    const toneMode = speakingToneMode(tts, opts.voiceOverride)
    const initialTone = toneMode === 'off' ? null : opts.initialTone !== undefined ? opts.initialTone : (sessionTones.get(target.sessionUid) ?? transcriptTone(target))
    let resolved: Promise<Resolved> | null = null
    const job: SpeechJob = new SpeechJob(
      { ...target, clientIds: [...new Set(target.clientIds)] },
      {
        hub: ctx.hub,
        log,
        now: () => ctx.clock.now(),
        toApiError: ctx.toApiError,
        tts: { toneMode, tonePlacement: tts.tonePlacement, waitForTone: tts.waitForTone, speakCode: tts.speakCode },
        initialTone,
        maxInFlight: o.maxInFlight,
        synth: async (plan, so, signal) => {
          resolved ??= resolve(opts.voiceOverride, opts.talkMode, opts.explicit)
          const r = await resolved
          const now = ctx.settings.get().voice.tts
          return r.provider.synthesize({ text: plan.spoken, voiceId: r.voiceId, model: r.model, tone: so.tone, speed: now.speed, stability: now.stability, similarity: now.similarity, prevText: so.prevText, nextText: so.nextText }, signal)
        },
        onTone: (v) => rememberTone(target.sessionUid, v),
        onEvent: opts.onEvent,
        onFinish: (j, outcome: JobOutcome, r) => {
          if (jobs.get(j.replyId) === j) jobs.delete(j.replyId)
          if (outcome === 'barge-in') persistInterruption(target, r.spokenChars)
          else if (outcome === 'complete') rememberCompleted(target)
        }
      }
    )
    if (closed) job.abort('stopped')
    else if (!job.isFinished) jobs.set(target.replyId, job)
    return job
  }

  async function replayFor(messageUid: string, client: WsClient): Promise<string> {
    if (typeof messageUid !== 'string') throw new VesperError('validation')
    // A temporary chat's messages live in its own in-memory store (07 B9), so look in every store.
    const found = findMessage(ctx, messageUid)
    const m = found?.message
    if (!found || !m || m.role !== 'assistant' || m.deleted || !m.body.trim()) throw new VesperError('not_found')
    const repos = found.store.repos
    const s = repos.sessions.byId(m.sessionId)
    if (!s || s.deletedUtc !== null) throw new VesperError('not_found')
    // 07 A3: the tone is not stored anywhere but the wire transcript; "speak again" re-runs the TagFilter over it.
    let tone: string | null = null
    for (const row of repos.transcript.forMessage(m.id)) if (row.role === 'assistant') tone = lastToneOf(row.blocks) ?? tone
    // Speaking again replaces an earlier replay to the same client.
    for (const j of jobs.values()) if (j.replyId.startsWith('rp_') && j.target.clientIds.includes(client.id)) j.abort('stopped')
    const replyId = `rp_${randomBytes(8).toString('base64url')}`
    const job = openJob({ replyId, sessionUid: s.uid, clientIds: [client.id], messageUid: m.uid }, { voiceOverride: s.voice, talkMode: false, initialTone: tone ?? transcriptTone({ replyId, sessionUid: s.uid, clientIds: [], messageUid: m.uid }, false) ?? sessionTones.get(s.uid) ?? null })
    job.push(m.body)
    job.end(m.body)
    return replyId
  }

  function testKind(e: unknown): { kind: ProviderTestResult['kind']; message: string; upstreamStatus?: number } {
    const err = ctx.toApiError(e)
    const kind: ProviderTestResult['kind'] =
      err.code === 'provider_auth' || err.code === 'key_missing' || err.code === 'key_origin_mismatch'
        ? /permission|can't list/i.test(err.message)
          ? 'permission'
          : 'auth'
        : err.code === 'tts_quota' || err.code === 'provider_quota'
          ? 'quota'
          : err.code === 'network'
            ? 'network'
            : err.code === 'provider_rate'
              ? 'rate'
              : err.code === 'provider_not_found' || err.code === 'validation'
                ? 'url'
                : 'unknown'
    return { kind, message: err.message, upstreamStatus: err.upstreamStatus }
  }

  const svc: SpeechServiceImpl = {
    providers,

    open(target, opts) {
      return openJob(target, opts) as SpeechSink
    },

    async replay(messageUid, client) {
      await replayFor(messageUid, client)
    },

    replayFor,

    cancel(replyId, spokenChars, byClientId, opts) {
      const job = jobs.get(replyId)
      const sessionUid = job?.target.sessionUid ?? recent.get(replyId)?.target.sessionUid
      const beforeAudio = opts?.beforeAudio === true
      if (job) job.cancel(spokenChars, { beforeAudio, byClientId })
      else {
        // Synthesis already completed, the audio still plays: record the interruption here (07 C15) — unless the
        // canceller, its only speaker, had not started playing it (F31: nothing was heard, nothing to record).
        const done = recent.get(replyId)
        if (!done) return
        recent.delete(replyId)
        const unheard = beforeAudio && !!byClientId && done.target.clientIds.every((id) => id === byClientId)
        if (!unheard && typeof spokenChars === 'number' && Number.isFinite(spokenChars)) persistInterruption(done.target, spokenChars, true)
      }
      // Every other device stops its audio too (07 C16: speech.cancel from any device stops speech everywhere).
      if (sessionUid) ctx.hub.emit(sessionUid, { t: 'speech.stopped', sessionUid, replyId }, byClientId ? { except: byClientId } : undefined)
    },

    textFirst(replyId, clientId) {
      jobs.get(replyId)?.dropClient(clientId)
    },

    played(replyId, index, revealedChars) {
      jobs.get(replyId)?.played(index, revealedChars)
    },

    clientGone(clientId) {
      for (const j of [...jobs.values()]) j.clientGone(clientId)
    },

    job: (replyId) => jobs.get(replyId),

    async voices(provider, refresh) {
      if (!isTtsProvider(provider)) throw new VesperError('validation', { fields: { provider: 'Unknown voice provider' } })
      const l = await voiceList(provider, !!refresh)
      return { voices: l.voices, models: l.models, ...(l.quota ? { quota: l.quota } : {}) }
    },

    async sample(q, signal) {
      if (samples >= MAX_SAMPLES_IN_FLIGHT) throw new VesperError('rate_limited')
      const text = spokenOf(stripControlTags(String(q.text ?? '')).text).text.replace(/\s+/g, ' ').trim().slice(0, SAMPLE_MAX_CHARS)
      if (!/[\p{L}\p{N}]/u.test(text)) throw new VesperError('validation', { fields: { text: 'Enter something to say' } })
      samples++
      try {
        const r = await resolve(null, false, { provider: q.provider, voiceId: q.voiceId })
        const tts = ctx.settings.get().voice.tts
        const out = await r.provider.synthesize({ text, voiceId: r.voiceId, model: r.model, tone: null, speed: tts.speed, stability: tts.stability, similarity: tts.similarity }, signal)
        return { audio: out.audio, mime: out.mime }
      } finally {
        samples--
      }
    },

    async preview(pid, voiceId, signal) {
      if (!isTtsProvider(pid)) throw new VesperError('not_found')
      if (pid === 'windows') {
        const list = await voiceList(pid)
        const v = list.voices.find((x) => x.id === voiceId)
        if (!v) throw new VesperError('not_found')
        const out = await providers.get(pid).synthesize({ text: `Hello, I'm ${v.name.replace(/^Microsoft\s+/, '')}.`, voiceId, model: null, tone: null, speed: 1, stability: 0.5, similarity: 0.75 }, signal)
        return { audio: out.audio, mime: out.mime }
      }
      const list = await voiceList(pid)
      const url = list.previews?.[voiceId]
      // Only URLs the provider itself listed are fetched, never one from a client (no open proxy).
      if (!url || baseUrlProblem(url) !== null) throw new VesperError('not_found')
      const r = await fetchBytes(url, { signal, timeoutMs: 15_000, maxBytes: 5 * 1024 * 1024, headers: { accept: 'audio/*' } })
      if (r.status !== 200 || !r.bytes.length) throw new VesperError('not_found', { upstreamStatus: r.status })
      return { audio: r.bytes, mime: sniffMime(r.bytes) ?? 'audio/mpeg' }
    },

    async test(input, signal) {
      const pid = input.provider
      if (!isTtsProvider(pid)) return { ok: false, kind: 'unknown', message: 'Unknown voice provider.' }
      const key = typeof input.key === 'string' && input.key.trim() ? input.key.trim() : undefined
      const baseUrl = typeof input.baseUrl === 'string' && input.baseUrl.trim() ? input.baseUrl.trim() : undefined
      try {
        const p = providers.get(pid)
        if (!p.available() && !(pid === 'openai-compatible' && baseUrl)) return { ok: false, kind: 'unknown', message: pid === 'windows' ? 'Windows voices are only available on Windows.' : 'Enter the address of your voice server.' }
        const list = await p.list(signal, { key, baseUrl })
        if (!key && !baseUrl) {
          const entry = { at: ctx.clock.now(), list }
          cache.set(pid, entry)
          ctx.repos.kv.set(KV_PREFIX + pid, entry)
        }
        const n = list.voices.length
        return { ok: true, message: n ? `Connected. ${n} voice${n === 1 ? '' : 's'} available.` : 'Connected.', voices: list.voices, models: list.models, ...(list.quota ? { quota: list.quota } : {}) }
      } catch (e) {
        if (isAbort(e)) return { ok: false, kind: 'network', message: "The voice service didn't answer in time." }
        return { ok: false, ...testKind(e) }
      }
    },

    async validateKey(name, value, url) {
      const pid = providerOfSecret(name)
      if (!pid) return
      const p = providers.get(pid)
      if (!p.validateKey) return
      const t = withTimeout(life.signal, 10_000)
      try {
        await p.validateKey(value, url, t.signal)
      } catch (e) {
        // A refused key is the client's input: 400 with the provider's mapped code, not a server error.
        if (e instanceof VesperError) throw new VesperError(e.info.code, { message: e.info.message, upstreamStatus: e.info.upstreamStatus, status: 400 })
        if (isAbort(e)) return // no answer in time: keep the key; the voices fetch reports problems
        throw e
      } finally {
        t.done()
      }
    },

    async keySaved(name) {
      const pid = providerOfSecret(name)
      if (!pid) return
      cache.delete(pid)
      ctx.repos.kv.delete(KV_PREFIX + pid)
      try {
        const list = await voiceList(pid, true)
        if (closed) return
        ctx.hub.broadcast({ t: 'tts.voices', ...publicList(pid, list) })
        // 07 C22: the dropdown auto-selects the first premade voice — persist it when none is chosen yet.
        const tts = ctx.settings.get().voice.tts
        if (tts.provider === pid && !tts.voiceId) {
          const p = providers.get(pid)
          const voiceId = p.defaultVoice(list, tts.model)
          if (voiceId) await ctx.settings.patch({ voice: { tts: { voiceId } } })
        }
      } catch (e) {
        if (closed) return
        const err = ctx.toApiError(e)
        log.warn('voices after key save failed', { provider: pid, code: err.code, upstreamStatus: err.upstreamStatus })
        ctx.hub.broadcast({ t: 'toast', tone: 'warning', text: err.message }, { desktopOnly: true })
      }
    },

    async keyDeleted(name) {
      const pid = providerOfSecret(name)
      if (!pid) return
      cache.delete(pid)
      ctx.repos.kv.delete(KV_PREFIX + pid)
      ctx.hub.broadcast({ t: 'tts.voices', provider: pid, voices: [], models: [] })
    },

    prewarm() {
      if (closed) return Promise.resolve()
      const tts = ctx.settings.get().voice.tts
      const pid = tts.provider
      const now = Date.now()
      if (now - (lastPrewarm.get(pid) ?? -Infinity) < PREWARM_EVERY_MS) return Promise.resolve()
      lastPrewarm.set(pid, now)
      const run = (async () => {
        const p = providers.get(pid)
        if (!p.available()) return
        const t = withTimeout(life.signal, PREWARM_TIMEOUT_MS)
        try {
          if (pid === 'windows') {
            // Asking the host for its voices starts it (≈ 0.6 s); it then stays up for 10 min idle (07 D2).
            await p.list(t.signal)
          } else {
            const origin = pid === 'elevenlabs' ? ELEVEN_BASE : pid === 'openai' ? new URL(OPENAI_BASE).origin : tts.baseUrl ? new URL(tts.baseUrl).origin : null
            if (origin) {
              const url = transportUrl(`${origin}/`)
              // Test builds never leave the machine (mock origins only).
              const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/)/.test(url)
              if (local || !(__VESPER_TEST__ && isTestMode())) await fetchBytes(url, { signal: t.signal, timeoutMs: PREWARM_TIMEOUT_MS, maxBytes: 64 * 1024 })
            }
            // Voice/model choice comes from the cached list; refresh it now if it went stale.
            await voiceList(pid).catch(() => undefined)
          }
        } catch (e) {
          if (!isAbort(e)) log.debug('tts prewarm failed', { provider: pid, code: ctx.toApiError(e).code })
        } finally {
          t.done()
        }
      })()
      const owned = run.finally(() => prewarming.delete(owned))
      prewarming.add(owned)
      return run
    },

    stats: () => ({ jobs: jobs.size, sessionTones: sessionTones.size, listsInFlight: listing.size, samples, prewarming: prewarming.size, recent: recent.size }),

    async close() {
      closed = true
      life.abort()
      for (const j of [...jobs.values()]) j.abort('stopped')
      jobs.clear()
      recent.clear()
      await Promise.allSettled([...listing.values(), ...prewarming])
      await providers.close()
    }
  }
  return svc
}
