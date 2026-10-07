/**
 * "Test connection" for an LLM profile (07 D11): `GET /models` (fills the model dropdown) and, when a model is given,
 * a tiny chat request. Every failure becomes a ProviderTestResult with a kind and Vesper's own message (07 C19);
 * a typed-in key is used for this test only and never stored here.
 */
import { ERRORS, VesperError, type ErrorCode } from '@shared/errors'
import { presetById } from '@shared/presets'
import { baseUrlProblem, PRESET_IDS, settingsSchema, type LlmProfile, type PresetId } from '@shared/settings'
import type { ModelInfo, ProviderTestResult } from '@shared/types/domain'
import type { ProviderTester, ServerContext } from '../../services'
import { adapterFor, resolveProfile } from './client'
import { mapProviderError } from './errors'
import type { AttachmentSource } from './types'

const NO_ATTACHMENTS: AttachmentSource = { bytes: () => null, text: () => null, boundary: () => 'r_test' }

const KIND: Partial<Record<ErrorCode, NonNullable<ProviderTestResult['kind']>>> = {
  provider_auth: 'auth',
  key_missing: 'auth',
  key_origin_mismatch: 'auth',
  secret_unreadable: 'auth',
  provider_quota: 'quota',
  provider_rate: 'rate',
  provider_not_found: 'model',
  network: 'network',
  provider_bad_request: 'unknown'
}

export function testFailure(e: unknown): ProviderTestResult {
  const ve = mapProviderError(e)
  const code = ve.info.code
  const r: ProviderTestResult = { ok: false, kind: KIND[code] ?? 'unknown', message: ve.info.message || ERRORS[code].message }
  if (ve.info.upstreamStatus !== undefined) r.upstreamStatus = ve.info.upstreamStatus
  return r
}

/** A throwaway profile for the test (the saved one when `profileId` names it, with the typed URL/preset/model). */
export function testProfile(ctx: ServerContext, input: { profileId?: string; preset: PresetId; baseUrl: string; model?: string }): LlmProfile {
  const saved = input.profileId ? ctx.settings.get().llm.profiles.find((p) => p.id === input.profileId) : undefined
  const preset = presetById(input.preset)
  // Parsed through the settings schema so every default matches a saved profile exactly.
  const raw = {
    id: saved?.id ?? 'test',
    label: saved?.label ?? 'Test',
    preset: input.preset,
    adapter: preset.adapter,
    baseUrl: input.baseUrl || preset.baseUrl,
    model: input.model ?? '',
    authHeader: saved?.authHeader ?? '',
    options: saved?.options ?? {},
    capabilities: saved?.capabilities ?? {}
  }
  return settingsSchema.parse({ llm: { profiles: [raw] } }).llm.profiles[0]
}

export function createLlmTester(ctx: ServerContext): ProviderTester {
  return {
    async test(raw, signal): Promise<ProviderTestResult> {
      const preset = typeof raw.preset === 'string' && (PRESET_IDS as readonly string[]).includes(raw.preset) ? (raw.preset as PresetId) : null
      if (!preset) return { ok: false, kind: 'unknown', message: 'Choose an AI provider.' }
      const baseUrl = typeof raw.baseUrl === 'string' && raw.baseUrl ? raw.baseUrl : presetById(preset).baseUrl
      const problem = baseUrl ? baseUrlProblem(baseUrl) : 'Enter the address of the AI service.'
      if (problem) return { ok: false, kind: 'url', message: problem }
      const model = typeof raw.model === 'string' ? raw.model.trim() : ''
      const key = typeof raw.key === 'string' && raw.key.trim() ? raw.key.trim() : null
      const profileId = typeof raw.profileId === 'string' ? raw.profileId : undefined
      let p
      try {
        const prof = testProfile(ctx, { profileId, preset, baseUrl, model })
        // Without a typed key, use the saved one — only if it is bound to this exact origin (07 B1).
        p = await resolveProfile(ctx, prof, { keyOverride: key ?? (profileId ? undefined : ''), modelOptional: true })
      } catch (e) {
        return testFailure(e)
      }
      const adapter = adapterFor(p)
      let models: ModelInfo[] | undefined
      let listError: unknown = null
      try {
        models = await adapter.listModels(signal)
      } catch (e) {
        listError = e
      }
      if (!model) {
        if (listError) return testFailure(listError)
        return { ok: true, message: models?.length ? `Connected. ${models.length} models available.` : 'Connected.', models }
      }
      try {
        const stream = adapter.stream(
          {
            model: p.model,
            system: [],
            tools: [],
            toolMode: 'text',
            turns: [{ id: 0, role: 'user', blocks: [{ t: 'text', text: 'Reply with the word OK.' }] }],
            maxTokens: 16,
            reasoningDisplay: 'hidden',
            stripThinkingBefore: null,
            utility: true
          },
          NO_ATTACHMENTS,
          signal
        )
        for await (const _ev of stream.events) {
          /* drain */
        }
        if (signal.aborted) throw new VesperError('network', { message: 'The AI service did not answer in time.' })
      } catch (e) {
        const r = testFailure(e)
        if (r.kind === 'model' && listError === null) r.message = `The model "${model}" was not found at this AI service.`
        if (models) r.models = models
        return r
      }
      return { ok: true, message: 'Connected. The model answered.', ...(models ? { models } : {}) }
    }
  }
}
