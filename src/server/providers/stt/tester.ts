/**
 * ProviderTester 'stt' (wizard step 5, Settings → Voice in; 07 D11: every Test has a 10 s timeout). Local: is the
 * model installed? Cloud: one tiny upload with the given (or saved) key — the transcript itself does not matter, only
 * that the provider accepted the key and the audio. Errors are reported as Vesper's own messages (07 C19).
 */
import { z } from 'zod'
import { STT_PROVIDERS } from '@shared/settings'
import { VesperError, type ErrorCode } from '@shared/errors'
import type { ProviderTestResult } from '@shared/types/domain'
import type { ModelManager } from '../../models/manager'
import type { ProviderTester, SecretsService, SettingsStore } from '../../services'
import { CLOUD_PROVIDERS, cloudModel, keyFor, providerUrl, transcribe } from './cloud'
import { encodeWav } from './pcm'
import { SAMPLE_RATE } from './protocol'

const input = z.object({ provider: z.enum(STT_PROVIDERS), key: z.string().min(1).max(8192).optional(), model: z.string().max(80).optional() })

const KIND: Partial<Record<ErrorCode, NonNullable<ProviderTestResult['kind']>>> = {
  provider_auth: 'auth',
  key_missing: 'auth',
  key_origin_mismatch: 'url',
  provider_quota: 'quota',
  provider_rate: 'rate',
  provider_not_found: 'model',
  provider_bad_request: 'unknown',
  network: 'network',
  stt_model_missing: 'model'
}

/** 0.6 s of a quiet 220 Hz tone: valid audio every provider accepts. */
export function testClip(): Uint8Array {
  const n = Math.round(SAMPLE_RATE * 0.6)
  const pcm = new Int16Array(n)
  for (let i = 0; i < n; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * 3000)
  return encodeWav(pcm, SAMPLE_RATE)
}

export function createSttTester(d: { secrets: SecretsService; settings: SettingsStore; manager: ModelManager }): ProviderTester {
  return {
    async test(raw, signal) {
      const r = input.safeParse(raw)
      if (!r.success) return { ok: false, kind: 'unknown', message: "Some values aren't valid." }
      const { provider, key, model } = r.data
      try {
        if (provider === 'local') {
          const id = model ?? d.settings.get().voice.stt.model
          const e = d.manager.entry(id)
          if (!e) return { ok: false, kind: 'model', message: 'Unknown speech model.' }
          if (!d.manager.resolve(id)) return { ok: false, kind: 'model', message: `${e.label} is not downloaded yet.` }
          return { ok: true, message: `${e.label} is installed and runs on this PC.` }
        }
        const p = CLOUD_PROVIDERS[provider]
        const k = await keyFor(d.secrets, p, providerUrl(p.endpoint), key)
        await transcribe(p, { wav: testClip(), model: cloudModel(p, model ?? d.settings.get().voice.stt.model), language: 'auto', key: k, signal, timeoutMs: 10_000 })
        return { ok: true, message: `${p.label} accepted the key and transcribed a test clip.` }
      } catch (e) {
        if (signal.aborted) return { ok: false, kind: 'network', message: 'The test took too long.' }
        const info = e instanceof VesperError ? e.info : new VesperError('internal').info
        return { ok: false, kind: KIND[info.code] ?? 'unknown', message: info.message, ...(info.upstreamStatus ? { upstreamStatus: info.upstreamStatus } : {}) }
      }
    }
  }
}
