/**
 * One AI provider profile (Settings → AI providers and wizard step 1, 07 D11): address, API key (write-only, bound to
 * the address's origin — 07 B1), Test (GET /models + a 1-token chat, 10 s, specific messages), the model dropdown with
 * capability badges, the provider's privacy notice just in time (07 B13/B18) with OpenRouter's no-training / ZDR
 * switches, and — in Settings — the Advanced part (custom header, limits, effort, capabilities).
 *
 * Edits go to `llm.profiles` through the instant-save module; the address saves only when it is valid.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { CircleCheck, CircleX, PlugZap, TriangleAlert } from 'lucide-react'
import { presetById, PRESETS } from '@shared/presets'
import { ackKey, disclosure, llmDisclosureId, llmMayForward } from '@shared/privacy'
import { apiError } from '@shared/errors'
import { baseUrlProblem, EFFORTS, type LlmProfile, type PresetId } from '@shared/settings'
import type { ModelInfo, ProviderTestResult } from '@shared/types/domain'
import { Badge, LeavesPcBadge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { Callout } from '../../../components/Callout'
import { Combobox } from '../../../components/Combobox'
import { SecretInput } from '../../../components/SecretInput'
import { Segmented } from '../../../components/Segmented'
import { Select } from '../../../components/Select'
import { Slider } from '../../../components/Slider'
import { Switch } from '../../../components/Switch'
import { TextField } from '../../../components/TextField'
import { api } from '../../../lib/api'
import { ApiErrorException, toApiError } from '../../../lib/errors.logic'
import { useStore } from '../../../lib/store'
import { flushSettings, setSettingRaw, useCanWrite } from '../save'
import { rangeOf } from '../schema.logic'
import { ExternalLink, RowError, SettingRow, SettingsAdvanced, SettingsGroup } from '../ui'
// Building blocks carry their styles: the wizard uses them without the Settings shell.
import '../settings.css'
import { capabilitiesFor, capabilityTags, headerSecretName, hostOf, keyRefusal, modelsFrom, secretName, soleModel, testView, withPreset, type TestView } from './providers.logic'

/** The server answers every Test within 10 s (07 D11); the client gives up shortly after. */
const CLIENT_TEST_TIMEOUT_MS = 11_500

export interface ProviderEditorProps {
  profileId: string
  /** 'wizard' = the essentials only (no name or Advanced), Test right after the key is saved. */
  mode?: 'settings' | 'wizard'
  /** Every Test outcome (the wizard enables Continue on success). */
  onTest?: (ok: boolean) => void
  advanced?: boolean
}

export function useProfiles(): LlmProfile[] {
  return useStore((s) => s.settings?.llm.profiles ?? EMPTY)
}
const EMPTY: LlmProfile[] = []

/** Replace one profile in `llm.profiles` (optimistic + saved). */
export function updateProfile(id: string, patch: Partial<LlmProfile>, o: { immediate?: boolean } = {}): void {
  const profiles = useStore.getState().settings?.llm.profiles ?? []
  setSettingRaw(
    'llm.profiles',
    profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    o
  )
}

export function ProviderEditor({ profileId, mode = 'settings', onTest, advanced }: ProviderEditorProps): ReactNode {
  const profile = useProfiles().find((p) => p.id === profileId)
  if (!profile) return null
  return <Editor key={`${profileId}:${profile.preset}`} profile={profile} mode={mode} onTest={onTest} advanced={advanced} />
}

function Editor({ profile, mode, onTest, advanced }: { profile: LlmProfile; mode: 'settings' | 'wizard'; onTest?: (ok: boolean) => void; advanced?: boolean }): ReactNode {
  const preset = presetById(profile.preset)
  const index = useStore((s) => s.settings?.llm.profiles.findIndex((p) => p.id === profile.id) ?? -1)
  const errors = useStore((s) => s.settingsErrors)
  const secretsSet = useStore((s) => s.bootstrap?.secretsSet ?? EMPTY_NAMES)
  const secretsInvalid = useStore((s) => s.bootstrap?.secretsInvalid ?? EMPTY_NAMES)
  const { readOnly } = useCanWrite('llm.profiles')
  const keyName = secretName(profile.id)
  const keySaved = secretsSet.includes(keyName)
  const service = preset.label.replace(/\s*\(.*\)$/, '')

  // Address: a local draft while typing; only valid addresses are saved (an invalid one would be reverted mid-typing).
  const [urlDraft, setUrlDraft] = useState<string | null>(null)
  const url = urlDraft ?? profile.baseUrl
  const urlProblem = url ? baseUrlProblem(url) : preset.id === 'custom' ? 'Enter the address of your AI service.' : null
  const serverUrlError = errors[`llm.profiles.${index}.baseUrl`] ?? errors['llm.profiles']

  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<TestView | null>(null)
  const ctlRef = useRef<AbortController | null>(null)
  const timerRef = useRef(0)

  // Every request this editor starts is aborted when it unmounts (owner: this component).
  useEffect(
    () => () => {
      ctlRef.current?.abort()
      window.clearTimeout(timerRef.current)
    },
    []
  )

  const canList = (keySaved || !preset.keyRequired) && !!profile.baseUrl && !baseUrlProblem(profile.baseUrl)
  // Fill the model list quietly when a key is already saved (Settings, a re-run wizard); Test shows errors. Not while
  // a Test runs: it lists the models itself (saving a key starts one).
  useEffect(() => {
    if (!canList || models || ctlRef.current) return
    const ctl = new AbortController()
    setModelsLoading(true)
    api('GET /api/providers/llm/models', { query: { profile: profile.id }, signal: ctl.signal })
      .then((list) => setModels(list))
      .catch(() => undefined)
      .finally(() => {
        if (!ctl.signal.aborted) setModelsLoading(false)
      })
    return () => ctl.abort()
    // Re-list when the key or address changes.
  }, [canList, profile.id, profile.baseUrl, keySaved])

  const runTest = useCallback(
    async (model = profile.model): Promise<void> => {
      ctlRef.current?.abort()
      const ctl = new AbortController()
      ctlRef.current = ctl
      setTesting(true)
      setResult(null)
      let timedOut = false
      window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => {
        timedOut = true
        ctl.abort()
      }, CLIENT_TEST_TIMEOUT_MS)
      try {
        await flushSettings()
        const current = useStore.getState().settings?.llm.profiles.find((p) => p.id === profile.id) ?? profile
        const r: ProviderTestResult = await api('POST /api/providers/llm/test', {
          body: { profileId: current.id, preset: current.preset, baseUrl: current.baseUrl, model: model || undefined },
          signal: ctl.signal
        })
        if (r.models?.length) setModels(r.models)
        setResult(testView(r, { service, baseUrl: current.baseUrl, model }))
        onTest?.(r.ok && !!model)
      } catch (e) {
        if (ctl.signal.aborted && !timedOut) return
        const view = timedOut
          ? testView({ ok: false, kind: 'network', message: '' }, { service, baseUrl: profile.baseUrl, model, timedOut: true })
          : { tone: 'danger' as const, title: 'The test could not run', body: toApiError(e).message }
        setResult(view)
        onTest?.(false)
      } finally {
        window.clearTimeout(timerRef.current)
        if (ctlRef.current === ctl) {
          ctlRef.current = null
          setTesting(false)
        }
      }
    },
    [profile, service, onTest]
  )

  // The wizard (a re-run, or back from a later step) re-checks a profile that looks ready, so Continue reflects reality.
  const autoTested = useRef(false)
  useEffect(() => {
    if (mode !== 'wizard' || autoTested.current || !canList || !profile.model) return
    autoTested.current = true
    void runTest()
  }, [mode, canList, profile.model, runTest])

  const saveKey = async (value: string): Promise<void> => {
    if (urlProblem) throw new ApiErrorException(apiError('validation', { message: 'Fix the address first; the key is saved for that address.' }), 400)
    await flushSettings()
    const saved = useStore.getState().settings?.llm.profiles.find((p) => p.id === profile.id)
    try {
      await api('PUT /api/secrets/:name', { params: { name: keyName }, body: { value, forUrl: saved?.baseUrl ?? profile.baseUrl } })
    } catch (e) {
      // The server checks a key with the provider before storing it; a definite refusal shows in the key field (like
      // the voice and Voyage keys), and the step stays blocked.
      const err = toApiError(e)
      if (err.code !== 'provider_auth') throw e instanceof ApiErrorException ? e : new ApiErrorException(err, 0)
      setResult(null)
      onTest?.(false)
      throw new ApiErrorException({ ...err, message: keyRefusal(service, err.upstreamStatus) }, 400)
    }
    useStore.getState().markSecret(keyName, true)
    setModels(null)
    // Test right away: it fills the model list (07 D11) and catches a wrong key before the owner moves on.
    void runTest()
  }

  const removeKey = async (): Promise<void> => {
    await api('DELETE /api/secrets/:name', { params: { name: keyName } })
    useStore.getState().markSecret(keyName, false)
    setModels(null)
    setResult(null)
  }

  const chooseModel = (id: string | null): void => {
    if (!id) return
    const m = models?.find((x) => x.id === id)
    updateProfile(profile.id, { model: id, capabilities: { ...profile.capabilities, ...capabilitiesFor(m) } }, { immediate: true })
    setResult(null)
    void runTest(id)
  }

  // One model listed and none chosen (a local server, a custom endpoint): pick it and test it (fix5-ui P04).
  const only = readOnly || testing ? null : soleModel(models, profile.model)
  useEffect(() => {
    if (only) chooseModel(only)
    // chooseModel is recreated every render; `only` is the trigger.
  }, [only])

  const d = disclosure(llmDisclosureId(profile.preset, profile.baseUrl, profile.model))
  const local = d?.training === 'local'
  // A loopback custom address is a program on this PC that may forward the text online: no green "On this PC" (F19).
  const mayForward = llmMayForward(d?.id ?? null)
  const chosen = models?.find((m) => m.id === profile.model)
  const modelOptions = (models ?? []).map((m) => ({
    value: m.id,
    label: m.label && m.label !== m.id ? m.label : m.id,
    description: m.label && m.label !== m.id ? m.id : undefined,
    meta: capabilityTags(m).join(' · ') || undefined,
    keywords: [m.id]
  }))
  if (profile.model && !modelOptions.some((o) => o.value === profile.model)) modelOptions.unshift({ value: profile.model, label: profile.model, description: models ? 'Not in the service’s list' : undefined, meta: undefined, keywords: [] })

  return (
    <div className="peditor" data-profile={profile.id}>
      {mode === 'settings' ? (
        <SettingRow setting="llm.profiles[].preset" className="set-row--field">
          <Select<PresetId>
            label="Service"
            value={profile.preset}
            disabled={readOnly}
            hint="Changing the service resets the address and model; the saved key is kept only if the address stays the same."
            options={PRESETS.map((p) => ({ value: p.id, label: p.label }))}
            onChange={(id) => id !== profile.preset && updateProfile(profile.id, withPreset(profile, id), { immediate: true })}
          />
        </SettingRow>
      ) : null}
      {mode === 'settings' ? (
        <SettingRow setting="llm.profiles[].label" className="set-row--field">
          <TextField
            label="Profile name"
            value={profile.label}
            readOnly={readOnly}
            maxLength={60}
            onChange={(e) => e.target.value.trim() && updateProfile(profile.id, { label: e.target.value })}
            hint="Shown in the model picker and on each reply."
          />
        </SettingRow>
      ) : null}

      <SettingRow setting="llm.profiles[].baseUrl" className="set-row--field">
        <TextField
          label="Address (base URL)"
          labelExtra={
            mayForward ? (
              <Badge tone="neutral" title="A program on this PC; it may pass your conversation on to an online service.">
                On this PC, unless it forwards
              </Badge>
            ) : local ? (
              <Badge tone="success">On this PC</Badge>
            ) : (
              <LeavesPcBadge service={service} what="conversation" />
            )
          }
          value={url}
          readOnly={readOnly}
          spellCheck={false}
          autoComplete="off"
          inputMode="url"
          placeholder={preset.baseUrl || 'https://example.com/v1'}
          className="mono"
          error={(urlDraft !== null && urlProblem) || serverUrlError || undefined}
          hint={preset.id === 'custom' ? 'Any OpenAI-compatible server. https:// unless it runs on this PC.' : 'Change it only for a proxy or gateway.'}
          onFocus={() => setUrlDraft(profile.baseUrl)}
          onBlur={() => setUrlDraft(null)}
          onChange={(e) => {
            const v = e.target.value.trim()
            setUrlDraft(e.target.value)
            if (v && !baseUrlProblem(v)) updateProfile(profile.id, { baseUrl: v })
          }}
        />
      </SettingRow>

      <div className="set-row" data-setting-secret={keyName}>
        <SecretInput
          label={preset.keyRequired ? 'API key' : 'API key (optional)'}
          saved={keySaved}
          disabled={readOnly}
          onSave={saveKey}
          onRemove={removeKey}
          error={secretsInvalid.includes(keyName) ? "The saved key can't be unlocked on this Windows account. Enter it again." : undefined}
          hint={
            <>
              Kept encrypted on this PC and sent only to {profile.baseUrl ? hostOf(profile.baseUrl) : 'this address'}.{' '}
              {preset.keyUrl ? <ExternalLink href={preset.keyUrl}>Get a key</ExternalLink> : null}
            </>
          }
        />
      </div>

      <SettingRow setting="llm.profiles[].model" className="set-row--field">
        {models || modelsLoading ? (
          <Combobox
            label="Model"
            value={profile.model || null}
            options={modelOptions}
            loading={modelsLoading && !models}
            disabled={readOnly || (!models && modelsLoading)}
            placeholder={models ? 'Search models' : 'Loading models…'}
            emptyText="No model matches"
            onChange={chooseModel}
            hint={models ? modelsFrom(models.length, service) : undefined}
          />
        ) : (
          <TextField
            label="Model"
            value={profile.model}
            readOnly={readOnly}
            spellCheck={false}
            placeholder={preset.exampleModel ?? 'Test the connection to list models'}
            hint={canList ? 'Test the connection to choose from the list, or type a model name.' : preset.keyRequired ? 'Save your key, then choose a model from the list.' : 'Test the connection to list the models.'}
            onChange={(e) => updateProfile(profile.id, { model: e.target.value.trim() })}
          />
        )}
        {chosen && capabilityTags(chosen).length ? (
          <div className="peditor__caps" aria-label="What this model can do">
            {capabilityTags(chosen).map((t) => (
              <Badge key={t} tone="accent">
                {t}
              </Badge>
            ))}
          </div>
        ) : null}
      </SettingRow>

      <div className="set-row peditor__test">
        <div className="peditor__test-row">
          <Button icon={<PlugZap />} loading={testing} disabled={readOnly || !!urlProblem || (preset.keyRequired && !keySaved)} onClick={() => void runTest()}>
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
          <span className="peditor__test-note">{preset.keyRequired && !keySaved ? 'Save a key to test.' : 'Lists the models, then asks the model for one word.'}</span>
        </div>
        <div aria-live="polite" className="peditor__result-live">
          {result ? (
            <div className={`peditor__result peditor__result--${result.tone}`} role={result.tone === 'success' ? 'status' : 'alert'} data-test-result={result.tone}>
              {result.tone === 'success' ? <CircleCheck aria-hidden="true" /> : result.tone === 'warning' ? <TriangleAlert aria-hidden="true" /> : <CircleX aria-hidden="true" />}
              <div>
                <p className="peditor__result-title">{result.title}</p>
                <p className="peditor__result-body">{result.body}</p>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {d ? (
        <div className="set-row">
          <Callout
            tone="privacy"
            title={mayForward ? 'Stays on this PC unless that program forwards it' : local ? 'Stays on this PC' : `What ${d.service} receives`}
            learnMore={d.sources[0] ? { href: d.sources[0], label: `${d.service}'s terms` } : undefined}
          >
            <p>{d.summary}</p>
            <p className="peditor__verified">Checked {d.verified}.</p>
          </Callout>
          {profile.preset === 'openrouter' ? (
            <div className="peditor__switches">
              <SettingRow setting="llm.profiles[].options.openrouterNoTraining">
                <Switch
                  checked={profile.options.openrouterNoTraining}
                  disabled={readOnly}
                  label="Only providers that don't train on prompts"
                  description="Vesper asks OpenRouter to skip hosts that train on what you send."
                  onChange={(v) => updateProfile(profile.id, { options: { ...profile.options, openrouterNoTraining: v } }, { immediate: true })}
                />
              </SettingRow>
              <SettingRow setting="llm.profiles[].options.openrouterZdr">
                <Switch
                  checked={profile.options.openrouterZdr}
                  disabled={readOnly}
                  label="Zero-retention providers only"
                  description="Also skip hosts that keep logs. Many free (:free) models then stop working and answer “not found”."
                  onChange={(v) => updateProfile(profile.id, { options: { ...profile.options, openrouterZdr: v } }, { immediate: true })}
                />
              </SettingRow>
            </div>
          ) : null}
        </div>
      ) : null}

      {mode === 'settings' ? <ProfileAdvanced profile={profile} readOnly={readOnly} open={advanced} /> : null}
    </div>
  )
}
const EMPTY_NAMES: string[] = []

/** The privacy notice key for a profile (wizard records the acknowledgement on Continue). */
export function profileDisclosureKey(p: LlmProfile): string | null {
  const d = disclosure(llmDisclosureId(p.preset, p.baseUrl, p.model))
  return d ? ackKey(d) : null
}

type Tri = 'auto' | 'on' | 'off'
const tri = (v: boolean | undefined): Tri => (v === undefined ? 'auto' : v ? 'on' : 'off')
const fromTri = (v: Tri): boolean | undefined => (v === 'auto' ? undefined : v === 'on')

function ProfileAdvanced({ profile, readOnly, open }: { profile: LlmProfile; readOnly: boolean; open?: boolean }): ReactNode {
  const secretsSet = useStore((s) => s.bootstrap?.secretsSet ?? EMPTY_NAMES)
  const headerName = headerSecretName(profile.id)
  const maxTokens = rangeOf('llm.profiles[].options.maxTokens')
  const temp = rangeOf('llm.profiles[].options.temperature')
  const [tokDraft, setTokDraft] = useState<string | null>(null)
  const [tokErr, setTokErr] = useState<string | null>(null)
  const [ctxDraft, setCtxDraft] = useState<string | null>(null)
  const setOptions = (o: Partial<LlmProfile['options']>): void => updateProfile(profile.id, { options: { ...profile.options, ...o } }, { immediate: true })
  const setCaps = (c: Partial<LlmProfile['capabilities']>): void => {
    const next = { ...profile.capabilities, ...c }
    for (const k of Object.keys(next) as (keyof typeof next)[]) if (next[k] === undefined) delete next[k]
    updateProfile(profile.id, { capabilities: next }, { immediate: true })
  }

  return (
    <SettingsAdvanced open={open}>
      <SettingsGroup title="Request" description="Defaults suit most services.">
        <SettingRow setting="llm.profiles[].authHeader" className="set-row--field">
          <TextField
            label="Custom header name"
            value={profile.authHeader}
            readOnly={readOnly}
            spellCheck={false}
            placeholder="e.g. X-Api-Key"
            hint="For gateways that want an extra header. Its value is kept as a secret."
            onChange={(e) => updateProfile(profile.id, { authHeader: e.target.value.trim() })}
          />
        </SettingRow>
        {profile.authHeader ? (
          <div className="set-row">
            <SecretInput
              label={`Value of ${profile.authHeader}`}
              saved={secretsSet.includes(headerName)}
              disabled={readOnly}
              onSave={async (value) => {
                await flushSettings()
                await api('PUT /api/secrets/:name', { params: { name: headerName }, body: { value, forUrl: profile.baseUrl } })
                useStore.getState().markSecret(headerName, true)
              }}
              onRemove={async () => {
                await api('DELETE /api/secrets/:name', { params: { name: headerName } })
                useStore.getState().markSecret(headerName, false)
              }}
            />
          </div>
        ) : null}
        <SettingRow setting="llm.profiles[].options.maxTokens" className="set-row--field set-row--number">
          <TextField
            label="Longest reply"
            inputMode="numeric"
            value={tokDraft ?? String(profile.options.maxTokens)}
            readOnly={readOnly}
            trailing={<span className="set-row__unit">tokens</span>}
            hint={`${maxTokens.min.toLocaleString('en-US')}–${maxTokens.max.toLocaleString('en-US')}`}
            error={tokErr ?? undefined}
            onFocus={() => setTokDraft(String(profile.options.maxTokens))}
            onChange={(e) => setTokDraft(e.target.value)}
            onBlur={(e) => {
              const n = Number(e.target.value)
              setTokDraft(null)
              if (!Number.isInteger(n) || n < maxTokens.min || n > maxTokens.max) {
                setTokErr(`Enter a whole number from ${maxTokens.min} to ${maxTokens.max}.`)
                return
              }
              setTokErr(null)
              if (n !== profile.options.maxTokens) setOptions({ maxTokens: n })
            }}
          />
        </SettingRow>
        <SettingRow setting="llm.profiles[].options.temperature">
          <Switch
            checked={profile.options.temperature !== undefined}
            disabled={readOnly}
            label="Set the temperature"
            description="Off uses the model's own default."
            onChange={(v) => setOptions({ temperature: v ? 1 : undefined })}
          />
          {profile.options.temperature !== undefined ? (
            <Slider
              label="Temperature"
              value={profile.options.temperature}
              min={temp.min}
              max={temp.max}
              step={0.05}
              format={(v) => v.toFixed(2)}
              hint="Higher is more varied, lower is more focused."
              disabled={readOnly}
              onChange={(v) => updateProfile(profile.id, { options: { ...profile.options, temperature: v } })}
            />
          ) : null}
        </SettingRow>
        <SettingRow setting="llm.profiles[].options.effort" className="set-row--field">
          <Select<string>
            label="Thinking effort"
            value={profile.options.effort ?? 'default'}
            disabled={readOnly}
            hint="For models that think before answering. Higher is slower and costs more."
            options={[{ value: 'default', label: "The model's default" }, ...EFFORTS.map((e) => ({ value: e, label: e === 'xhigh' ? 'Extra high' : e.charAt(0).toUpperCase() + e.slice(1) }))]}
            onChange={(v) => setOptions({ effort: v === 'default' ? undefined : (v as LlmProfile['options']['effort']) })}
          />
        </SettingRow>
        <SettingRow setting="llm.profiles[].options.reasoningDisplay" inline>
          <div className="set-row__text">
            <span className="set-row__label" id={`${profile.id}-rd`}>
              Model's thinking
            </span>
            <span className="set-row__desc">Ask for a readable summary of the model's thinking (where the service offers one).</span>
          </div>
          <Segmented
            aria-labelledby={`${profile.id}-rd`}
            value={profile.options.reasoningDisplay}
            disabled={readOnly}
            options={[
              { value: 'hidden', label: 'Hidden' },
              { value: 'summarized', label: 'Summary' }
            ]}
            onChange={(v) => setOptions({ reasoningDisplay: v })}
          />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="What the model can do" description="Automatic uses what the service reports. Override only if replies with images, PDFs or memory fail.">
        <CapRow setting="llm.profiles[].capabilities.tools" cap="tools" label="Tools" desc="Memory search as native tool calls; otherwise in text." profile={profile} readOnly={readOnly} onChange={setCaps} />
        <CapRow setting="llm.profiles[].capabilities.vision" cap="vision" label="Images" desc="Send pictures to the model." profile={profile} readOnly={readOnly} onChange={setCaps} />
        <CapRow setting="llm.profiles[].capabilities.pdf" cap="pdf" label="PDF documents" desc="Send PDFs as documents; otherwise their text." profile={profile} readOnly={readOnly} onChange={setCaps} />
        <SettingRow setting="llm.profiles[].capabilities.contextWindow" className="set-row--field set-row--number">
          <TextField
            label="Context window"
            inputMode="numeric"
            value={ctxDraft ?? (profile.capabilities.contextWindow ? String(profile.capabilities.contextWindow) : '')}
            placeholder="Automatic"
            readOnly={readOnly}
            trailing={<span className="set-row__unit">tokens</span>}
            hint="Leave empty to use what the service reports."
            onFocus={() => setCtxDraft(profile.capabilities.contextWindow ? String(profile.capabilities.contextWindow) : '')}
            onChange={(e) => setCtxDraft(e.target.value)}
            onBlur={(e) => {
              setCtxDraft(null)
              const raw = e.target.value.trim()
              const n = Number(raw)
              if (!raw) setCaps({ contextWindow: undefined })
              else if (Number.isInteger(n) && n > 0) setCaps({ contextWindow: n })
            }}
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsAdvanced>
  )
}

function CapRow({
  setting,
  cap,
  label,
  desc,
  profile,
  readOnly,
  onChange
}: {
  setting: string
  cap: 'tools' | 'vision' | 'pdf'
  label: string
  desc: string
  profile: LlmProfile
  readOnly: boolean
  onChange(c: Partial<LlmProfile['capabilities']>): void
}): ReactNode {
  const id = `${profile.id}-cap-${cap}`
  return (
    <SettingRow setting={setting} inline>
      <div className="set-row__text">
        <span className="set-row__label" id={id}>
          {label}
        </span>
        <span className="set-row__desc">{desc}</span>
      </div>
      <Segmented<Tri>
        aria-labelledby={id}
        value={tri(profile.capabilities[cap])}
        disabled={readOnly}
        options={[
          { value: 'auto', label: 'Automatic' },
          { value: 'on', label: 'Yes' },
          { value: 'off', label: 'No' }
        ]}
        onChange={(v) => onChange({ [cap]: fromTri(v) })}
      />
    </SettingRow>
  )
}

/** Errors for the profile list (e.g. a refused save) shown above the editors. */
export function ProfilesError(): ReactNode {
  const err = useStore((s) => s.settingsErrors['llm.profiles'])
  return <RowError error={err} />
}

