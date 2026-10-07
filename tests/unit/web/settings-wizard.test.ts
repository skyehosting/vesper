/**
 * settings-wizard pure logic: dotted paths and the optimistic overlay behind instant save (07 D12), field-error
 * mapping on revert, the remote-write rule (07 B2), schema ranges (07 E12), Settings search, provider profiles and
 * the Test messages (07 D11: 401 = key, 404 = model/address, timeout = network), wizard navigation/resume and the
 * setup checklist (07 D13). @R20 @R3 @R2 @R10
 */
import { describe, expect, it } from 'vitest'
import { defaultSettings, type Settings } from '@shared/settings'
import { applyOverlay, fieldErrorsFor, getAt, isAppearancePath, movesKeys, setAt, settleOverlay, toPatch } from '../../../src/web/lib/store/settings.logic'
import { canWritePath } from '../../../src/web/features/settings/write.logic'
import { choicesOf, maxLengthOf, rangeOf } from '../../../src/web/features/settings/schema.logic'
import { searchSettings } from '../../../src/web/features/settings/catalog.logic'
import { capabilitiesFor, capabilityTags, contextLabel, hostOf, keyRefusal, newProfile, profileReady, testView, uniqueProfileId, withPreset } from '../../../src/web/features/settings/providers/providers.logic'
import { budgetOf, unloadedText } from '../../../src/web/features/settings/pages/performance.logic'
import { presetById } from '@shared/presets'
import { checklistItems, checklistOpen, idsFor, nextStep, prevStep, resumeStep, withSkipped, withoutSkipped } from '../../../src/web/features/wizard/wizard.logic'

describe('settings paths and the optimistic overlay', () => {
  const s = defaultSettings()
  it('reads and writes dotted paths without mutating', () => {
    expect(getAt(s, 'chat.pageSize')).toBe(100)
    expect(getAt(s, 'voice.tts.provider')).toBe('windows')
    expect(getAt(s, 'nope.x')).toBeUndefined()
    const next = setAt(s, 'chat.pageSize', 150)
    expect(next.chat.pageSize).toBe(150)
    expect(s.chat.pageSize).toBe(100)
    expect(next.voice).toBe(s.voice) // untouched branches are shared
    const arr = setAt({ a: [{ x: 1 }, { x: 2 }] }, 'a.1.x', 9)
    expect(arr).toEqual({ a: [{ x: 1 }, { x: 9 }] })
  })
  it('applies the overlay over server truth and builds the PATCH body', () => {
    const shown = applyOverlay(s, { 'chat.pageSize': 120, 'appearance.accent': 'rose' })
    expect(shown.chat.pageSize).toBe(120)
    expect(shown.appearance.accent).toBe('rose')
    expect(toPatch({ 'chat.pageSize': 120, 'chat.sendOnEnter': false, 'appearance.star.style': 'off' })).toEqual({
      chat: { pageSize: 120, sendOnEnter: false },
      appearance: { star: { style: 'off' } }
    })
  })
  it('settles only what the server confirmed unchanged', () => {
    const sent = { 'chat.pageSize': 120 }
    expect(settleOverlay({ 'chat.pageSize': 120, 'chat.fontSize': 16 }, sent)).toEqual({ 'chat.fontSize': 16 })
    // Typed again while the request was in flight: keep the newer value.
    expect(settleOverlay({ 'chat.pageSize': 140 }, sent)).toEqual({ 'chat.pageSize': 140 })
  })
  it('maps a refused save to field messages for every sent path', () => {
    expect(fieldErrorsFor(['llm.profiles'], "Some values aren't valid.", { 'llm.profiles.0.baseUrl': 'Use an https:// address' })).toEqual({
      'llm.profiles.0.baseUrl': 'Use an https:// address'
    })
    expect(fieldErrorsFor(['chat.pageSize', 'chat.autoTitle'], 'Nope.', { 'chat.pageSize': 'Too big' })).toEqual({ 'chat.pageSize': 'Too big', 'chat.autoTitle': 'Nope.' })
    expect(fieldErrorsFor(['access.mode'], 'x', { 'access.mode': 'desktop only' })).toEqual({ 'access.mode': 'Change this in the Vesper app on your PC.' })
  })
  it('knows which paths restyle the page or may move a key', () => {
    expect(isAppearancePath('appearance.theme')).toBe(true)
    expect(isAppearancePath('chat.fontSize')).toBe(true)
    expect(isAppearancePath('chat.pageSize')).toBe(false)
    expect(movesKeys('llm.profiles')).toBe(true)
    expect(movesKeys('memory.voyage.baseUrl')).toBe(true)
    expect(movesKeys('chat.pageSize')).toBe(false)
  })
})

describe('who may write (07 B2)', () => {
  it('the desktop writes everything', () => expect(canWritePath('llm.profiles', { desktop: true, remoteMayChangeSettings: false })).toBe(true))
  it('other devices write nothing unless allowed, then only the remote-writable prefixes', () => {
    expect(canWritePath('appearance.theme', { desktop: false, remoteMayChangeSettings: false })).toBe(false)
    expect(canWritePath('appearance.theme', { desktop: false, remoteMayChangeSettings: true })).toBe(true)
    expect(canWritePath('appearance.star.style', { desktop: false, remoteMayChangeSettings: true })).toBe(true)
    expect(canWritePath('llm.profiles', { desktop: false, remoteMayChangeSettings: true })).toBe(false)
    expect(canWritePath('chat.pageSize', { desktop: false, remoteMayChangeSettings: true })).toBe(false)
  })
})

describe('ranges and choices come from the schema (07 E12)', () => {
  it('reads number ranges', () => {
    expect(rangeOf('chat.pageSize')).toEqual({ min: 20, max: 300, int: true })
    expect(rangeOf('voice.stt.silenceMs')).toEqual({ min: 300, max: 5000, int: true })
    expect(rangeOf('chat.contextFill').int).toBe(false)
    expect(rangeOf('llm.profiles[].options.maxTokens')).toMatchObject({ min: 256, max: 128000 })
    expect(rangeOf('llm.profiles[].options.temperature')).toMatchObject({ min: 0, max: 2 })
    expect(() => rangeOf('chat.sendOnEnter')).toThrow()
  })
  it('reads enum and literal-union choices, and string limits', () => {
    expect(choicesOf('appearance.theme')).toEqual(['dark', 'light', 'system'])
    expect(choicesOf('memory.voyage.dim')).toEqual(['256', '512', '1024', '2048'])
    expect(maxLengthOf('profile.userName')).toBe(60)
  })
})

describe('Settings search', () => {
  const titles = { general: 'General', chat: 'Chat', 'voice-in': 'Voice in', appearance: 'Presence & appearance', providers: 'AI providers' }
  it('finds settings by label, help, keywords and section', () => {
    expect(searchSettings('page size', titles)[0]?.entry.path).toBe('chat.pageSize')
    expect(searchSettings('silence', titles)[0]?.entry.path).toBe('voice.stt.silenceMs')
    expect(searchSettings('timezone', titles)[0]?.entry.path).toBe('profile.timeZone')
    expect(searchSettings('dark', titles)[0]?.entry.path).toBe('appearance.theme')
    expect(searchSettings('zdr', titles)[0]?.entry.path).toBe('llm.profiles[].options.openrouterZdr')
  })
  it('needs every word, ignores case/punctuation, and caps the list', () => {
    expect(searchSettings('', titles)).toEqual([])
    expect(searchSettings('zzzz qqq', titles)).toEqual([])
    expect(searchSettings('TIME-ZONE', titles)[0]?.entry.path).toBe('profile.timeZone')
    expect(searchSettings('e', titles, 5).length).toBeLessThanOrEqual(5)
  })
})

describe('AI provider profiles', () => {
  it('makes unique ids', () => {
    expect(uniqueProfileId('openai', [])).toBe('openai')
    expect(uniqueProfileId('openai', ['openai', 'openai-2'])).toBe('openai-3')
    expect(uniqueProfileId('LM Studio!', [])).toBe('lm-studio-')
  })
  it('fills a new profile from the preset and the schema defaults', () => {
    const p = newProfile('anthropic', ['anthropic'])
    expect(p).toMatchObject({ id: 'anthropic-2', preset: 'anthropic', adapter: 'anthropic', baseUrl: 'https://api.anthropic.com', model: '', label: 'Anthropic' })
    expect(p.options.openrouterNoTraining).toBe(true)
    expect(p.options.maxTokens).toBe(16000)
  })
  it('switches preset keeping id and a custom label', () => {
    const p = { ...newProfile('openai', []), label: 'Work', model: 'gpt-x' }
    const q = withPreset(p, 'openrouter')
    expect(q).toMatchObject({ id: 'openai', preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: '', label: 'Work' })
    expect(withPreset(newProfile('openai', []), 'groq').label).toBe('Groq')
  })
  it('is ready with a model and (when needed) a key', () => {
    const p = { ...newProfile('openai', []), model: 'm' }
    expect(profileReady(p, presetById('openai'), false)).toBe(false)
    expect(profileReady(p, presetById('openai'), true)).toBe(true)
    const local = { ...newProfile('ollama', []), model: 'llama' }
    expect(profileReady(local, presetById('ollama'), false)).toBe(true)
  })
  it('summarises model capabilities', () => {
    expect(capabilityTags({ caps: { tools: true, vision: true, reasoning: true }, contextWindow: 200000 })).toEqual(['Tools', 'Vision', 'Reasoning', '200K'])
    expect(contextLabel(1_000_000)).toBe('1M')
    expect(capabilitiesFor({ id: 'x', caps: { tools: false, vision: true }, contextWindow: 8000 })).toEqual({ tools: false, vision: true, contextWindow: 8000 })
    expect(capabilitiesFor(undefined)).toEqual({})
    expect(hostOf('https://api.openai.com/v1')).toBe('api.openai.com')
  })
})

describe('Test connection messages (07 D11)', () => {
  const o = { service: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-x' }
  it('401 → the key', () => {
    const v = testView({ ok: false, kind: 'auth', message: 'The AI service rejected the API key.', upstreamStatus: 401 }, o)
    expect(v.tone).toBe('danger')
    expect(v.title).toBe('The key was rejected (401)')
    expect(v.body).toMatch(/copied all of it/)
    expect(testView({ ok: false, kind: 'auth', message: 'No API key is saved for this service.' }, o).title).toBe('No key saved yet')
  })
  it('404 → the model, or the address when no model was asked', () => {
    expect(testView({ ok: false, kind: 'model', message: '', upstreamStatus: 404 }, o).title).toBe('Model not found (404)')
    expect(testView({ ok: false, kind: 'model', message: '', upstreamStatus: 404 }, { ...o, model: '' }).body).toMatch(/\/v1/)
  })
  it('timeout and unreachable → network, with the host', () => {
    expect(testView({ ok: false, kind: 'network', message: 'The AI service did not answer in time.' }, o).title).toBe('No answer within 10 seconds')
    expect(testView({ ok: false, kind: 'network', message: "Can't reach the service." }, o).title).toBe("Can't reach api.openai.com")
    expect(testView({ ok: false, message: '' }, { ...o, timedOut: true }).body).toMatch(/firewall/)
  })
  it('quota, rate, url and success', () => {
    expect(testView({ ok: false, kind: 'quota', message: '' }, o).tone).toBe('warning')
    expect(testView({ ok: false, kind: 'rate', message: '' }, o).title).toMatch(/Too many requests/)
    expect(testView({ ok: false, kind: 'url', message: 'Use an https:// address' }, o).body).toBe('Use an https:// address')
    expect(testView({ ok: true, message: 'Connected.', models: [{ id: 'a' }, { id: 'b' }] }, { ...o, model: '' }).body).toBe('2 models are available. Choose one below.')
    expect(testView({ ok: true, message: '' }, o).title).toBe('Connected — the model answered')
  })
})

describe('wizard navigation (07 D11)', () => {
  it('Quick start is Welcome → AI provider → Hello; Guided has every step', () => {
    expect(idsFor('quick')).toEqual(['welcome', 'provider', 'finale'])
    expect(idsFor('guided')).toHaveLength(10)
    expect(nextStep('quick', 'provider')).toBe('finale')
    expect(nextStep('guided', 'provider')).toBe('you')
    expect(prevStep('guided', 'you')).toBe('provider')
    expect(prevStep('guided', 'welcome')).toBeNull()
    expect(nextStep('guided', 'finale')).toBeNull()
  })
  it('resumes on the saved step after a restart, Welcome on a rerun or an unknown step', () => {
    expect(resumeStep({ step: 'voice-in', path: 'guided', completed: false }, false)).toBe('voice-in')
    expect(resumeStep({ step: 'voice-in', path: 'guided', completed: false }, true)).toBe('welcome')
    expect(resumeStep({ step: 'voice-in', path: 'quick', completed: false }, false)).toBe('welcome')
    expect(resumeStep({ step: null, path: null, completed: false }, false)).toBe('welcome')
  })
  it('keeps the skipped list without duplicates', () => {
    expect(withSkipped(['memory'], 'memory')).toEqual(['memory'])
    expect(withSkipped(['memory'], 'access')).toEqual(['memory', 'access'])
    expect(withoutSkipped(['memory', 'access'], 'memory')).toEqual(['access'])
  })
})

describe('setup checklist (07 D13)', () => {
  const base = (): Settings => defaultSettings()
  it('lists skipped steps, ticks them once set up, and closes when done or dismissed', () => {
    const s = base()
    s.wizard.skipped = ['you', 'memory', 'voice-out', 'look']
    let items = checklistItems(s)
    expect(items.map((i) => i.id)).toEqual(['you', 'memory', 'voice-out', 'look'])
    expect(items.every((i) => !i.done)).toBe(true)
    expect(checklistOpen(items)).toBe(true)
    s.profile.userName = 'Raven'
    s.memory.enabled = true
    s.voice.tts.enabled = true
    s.appearance.accent = 'rose'
    items = checklistItems(s)
    expect(items.every((i) => i.done)).toBe(true)
    expect(checklistOpen(items)).toBe(false)
    s.profile.userName = ''
    s.wizard.checklistDismissed = true
    expect(checklistItems(s)).toEqual([])
  })
  it('points each item at its Settings section', () => {
    const s = base()
    s.wizard.skipped = ['voice-in', 'access']
    expect(checklistItems(s).map((i) => i.section)).toEqual(['voice-in', 'access'])
  })
})

describe('Performance page (07 D2)', () => {
  it('compares memory with the budget that applies now', () => {
    const budgetsMB = { trayOnly: 250, windowIdle: 550, withStt: 850 }
    expect(budgetOf({ totalMB: 412.4, budgetsMB, voice: { sttLoaded: false, winttsRunning: false } })).toMatchObject({ usedMB: 412, budgetMB: 550 })
    expect(budgetOf({ totalMB: 900, budgetsMB, voice: { sttLoaded: true, winttsRunning: false } })).toMatchObject({ budgetMB: 850, label: 'budget with speech recognition' })
    expect(budgetOf({ totalMB: 900, budgetsMB, voice: { sttLoaded: true, winttsRunning: false } })!.share).toBeGreaterThan(1)
    expect(budgetOf({ totalMB: 100 })).toBeNull()
  })
  it('says what "Unload voice models now" freed', () => {
    expect(unloadedText({ stt: true, wintts: true })).toBe('Unloaded speech recognition and the Windows voice host. They load again when next used.')
    expect(unloadedText({ stt: false, wintts: true })).toMatch(/^Unloaded the Windows voice host/)
    expect(unloadedText({ stt: false, wintts: false })).toMatch(/^Nothing was loaded/)
  })
})

describe('LLM key refused on save', () => {
  it('names the service and the upstream status', () => {
    expect(keyRefusal('OpenAI', 401)).toBe('OpenAI rejected this key (401). Check that you copied all of it and that it belongs to OpenAI.')
    expect(keyRefusal('Groq')).toMatch(/^Groq rejected this key\. /)
  })
})

describe('one-model services (fix5-ui P04)', () => {
  const o = { service: 'OpenAI', baseUrl: 'http://127.0.0.1:1234/v1', model: '' }
  it('says "1 model", never "1 models"', async () => {
    const { modelsFrom } = await import('../../../src/web/features/settings/providers/providers.logic')
    expect(testView({ ok: true, message: '', models: [{ id: 'qwen' }] }, o).body).toBe('1 model is available. Choose it below.')
    expect(testView({ ok: true, message: '', models: [{ id: 'qwen' }] }, { ...o, model: 'qwen' }).body).toBe('OpenAI answered with qwen. 1 model is available.')
    expect(testView({ ok: true, message: '', models: [{ id: 'a' }, { id: 'b' }] }, o).body).toBe('2 models are available. Choose one below.')
    expect(modelsFrom(1, 'OpenAI')).toBe('1 model from OpenAI.')
    expect(modelsFrom(3, 'OpenAI')).toBe('3 models from OpenAI.')
  })
  it('the only listed model is picked when none is chosen', async () => {
    const { soleModel } = await import('../../../src/web/features/settings/providers/providers.logic')
    expect(soleModel([{ id: 'qwen' }], '')).toBe('qwen')
    expect(soleModel([{ id: 'qwen' }], 'other')).toBeNull()
    expect(soleModel([{ id: 'a' }, { id: 'b' }], '')).toBeNull()
    expect(soleModel([], '')).toBeNull()
    expect(soleModel(null, '')).toBeNull()
  })
})
