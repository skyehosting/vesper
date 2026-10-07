import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DISCLOSURES, disclosure, isLoopbackHost, llmDisclosureId, llmMayForward, llmStaysOnPc, llmPlace } from '../../../src/shared/privacy'
import { defaultSettings, type Settings } from '../../../src/shared/settings'
import { localOnly, privacyHeadline, servicesInUse } from '../../../src/web/features/privacy/privacy.logic'
import { modelChip } from '../../../src/web/features/sessions/chips.logic'

const ROOT = join(__dirname, '../../..')

describe('privacy disclosure sources (07 B13, R21)', () => {
  it('links Voyage to the terms page research 02 verified (F23)', () => {
    expect(disclosure('voyage')!.sources[0]).toBe('https://www.voyageai.com/tos')
  })

  // The research notes are kept with the build history, not in the public repository: this check runs where they are.
  const RESEARCH = join(ROOT, 'docs/research')
  it.skipIf(!existsSync(RESEARCH))('cites only URLs that the research documents list (no unverified links)', () => {
    const dir = RESEARCH
    const research = readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n')
    const missing = DISCLOSURES.flatMap((d) => d.sources.filter((u) => !research.includes(u)).map((u) => `${d.id}: ${u}`))
    expect(missing).toEqual([])
  })
})

describe("'on this PC' depends on the address, not the preset (F19, research 08 §4.2/§4.3)", () => {
  it('Ollama / LM Studio are local only at a loopback address', () => {
    expect(llmDisclosureId('ollama', 'http://127.0.0.1:11434/v1', 'llama3')).toBe('llm.local')
    expect(llmDisclosureId('lmstudio', 'http://localhost:1234/v1', 'qwen')).toBe('llm.local')
    expect(llmDisclosureId('ollama', 'http://[::1]:11434/v1', 'llama3')).toBe('llm.local')
    expect(llmDisclosureId('ollama', 'https://ollama.my-vps.example.com/v1', 'llama3')).toBe('llm.self-hosted')
    expect(llmDisclosureId('lmstudio', 'https://gpu-box.tailnet.ts.net/v1', 'qwen')).toBe('llm.self-hosted')
    expect(llmDisclosureId('ollama', 'http://192.168.1.20:11434/v1', 'llama3')).toBe('llm.self-hosted')
    // Prefix tricks are not loopback.
    expect(llmDisclosureId('ollama', 'http://127.0.0.1.evil.example/v1', 'llama3')).toBe('llm.self-hosted')
    expect(llmDisclosureId('ollama', 'http://localhost.evil.example/v1', 'llama3')).toBe('llm.self-hosted')
    expect(llmDisclosureId('ollama', 'http://127.0.0.1:11434/v1', 'gpt-oss:120b-cloud')).toBe('llm.ollama-cloud')
    expect(llmDisclosureId('ollama', 'not a url', 'llama3')).toBe('llm.self-hosted')
  })

  it('a loopback custom address gets the local text plus "unless that program forwards requests online"', () => {
    const id = llmDisclosureId('custom', 'http://localhost:4000/v1', 'gpt-4o')
    expect(id).toBe('llm.local-custom')
    expect(disclosure(id)!.summary).toContain('unless that program forwards requests online')
    expect(disclosure(id)!.sends).toContain('unless that program forwards requests online')
    expect(llmDisclosureId('custom', 'https://llm.example.com/v1', 'x')).toBe('llm.custom')
  })

  it('the remote entry never claims "this PC"', () => {
    const d = disclosure('llm.self-hosted')!
    expect(d.training).not.toBe('local')
    expect(`${d.summary} ${d.sends}`).not.toMatch(/(leave|stays? on) this (PC|computer)/i)
    expect(llmStaysOnPc('llm.self-hosted')).toBe(false)
    expect(llmStaysOnPc('llm.local')).toBe(true)
    expect(llmStaysOnPc('llm.local-custom')).toBe(true)
  })

  it('loopback hosts', () => {
    for (const h of ['localhost', 'LOCALHOST', 'vesper.localhost', '127.0.0.1', '127.8.9.10', '[::1]', '::1', '[::ffff:7f00:1]', 'localhost.']) expect(isLoopbackHost(h), h).toBe(true)
    for (const h of ['192.168.1.2', '10.0.0.1', 'example.com', '127.0.0.1.nip.io', 'localhost.example', '[::ffff:a00:1]', '0.0.0.0', 'mypc']) expect(isLoopbackHost(h), h).toBe(false)
  })

  it('badges, the privacy page and the chat chip follow (remote Ollama leaves the PC)', () => {
    const s: Settings = defaultSettings()
    const opts = { maxTokens: 1000, reasoningDisplay: 'hidden' as const, openrouterNoTraining: true, openrouterZdr: false }
    s.llm.profiles = [{ id: 'gpu', label: 'GPU box', preset: 'ollama', adapter: 'openai', baseUrl: 'https://gpu-box.tailnet.ts.net/v1', model: 'llama3', authHeader: '', options: opts, capabilities: {} }]
    s.llm.defaultProfile = 'gpu'
    const used = servicesInUse(s, [])
    expect(used[0]).toMatchObject({ leaves: true })
    expect(used[0].disclosure.id).toBe('llm.self-hosted')
    expect(localOnly(s).map((l) => l.key)).not.toContain('llm')
    expect(modelChip(s, null).leavesPc).toBe(true)
    s.llm.profiles[0].baseUrl = 'http://127.0.0.1:11434/v1'
    expect(servicesInUse(s, [])[0].leaves).toBe(false)
    expect(localOnly(s).map((l) => l.key)).toContain('llm')
    expect(modelChip(s, null).leavesPc).toBe(false)
  })
})

describe('a loopback custom address makes no absolute "stays on this PC" claim (F19 second pass, research 08 §4.2)', () => {
  const opts = { maxTokens: 1000, reasoningDisplay: 'hidden' as const, openrouterNoTraining: true, openrouterZdr: false }
  const withProfile = (preset: 'custom' | 'ollama', baseUrl: string): Settings => {
    const s: Settings = defaultSettings()
    s.llm.profiles = [{ id: 'p', label: 'Local proxy', preset, adapter: 'openai', baseUrl, model: 'gpt-4o', authHeader: '', options: opts, capabilities: {} }]
    s.llm.defaultProfile = 'p'
    return s
  }

  it('the shared rules: listed as on this PC, but it may forward', () => {
    expect(llmStaysOnPc('llm.local-custom')).toBe(true)
    expect(llmMayForward('llm.local-custom')).toBe(true)
    expect(llmMayForward('llm.local')).toBe(false)
    expect(llmMayForward(null)).toBe(false)
    expect(llmPlace('llm.local')).toBe('pc')
    expect(llmPlace('llm.local-custom')).toBe('pc-may-forward')
    expect(llmPlace('llm.self-hosted')).toBe('leaves')
    expect(llmPlace('llm.openai')).toBe('leaves')
  })

  it('servicesInUse, the header, localOnly and the model chip carry the caveat', () => {
    const custom = withProfile('custom', 'http://localhost:4000/v1')
    const used = servicesInUse(custom, [])
    expect(used[0]).toMatchObject({ leaves: false, mayLeave: true })
    expect(privacyHeadline(used)).toEqual({ tone: 'neutral', text: 'Stays on this PC unless your local program forwards it' })
    const item = localOnly(custom).find((l) => l.key === 'llm')!
    expect(item.title).toBe('A program on this PC')
    expect(item.detail).toContain('unless that program forwards requests online')
    expect(modelChip(custom, null)).toMatchObject({ leavesPc: false, mayForward: true })

    const ollama = withProfile('ollama', 'http://127.0.0.1:11434/v1')
    const local = servicesInUse(ollama, [])
    expect(local[0]).toMatchObject({ leaves: false, mayLeave: false })
    expect(privacyHeadline(local)).toEqual({ tone: 'success', text: 'Nothing leaves this PC' })
    expect(localOnly(ollama).find((l) => l.key === 'llm')!.title).toBe('A local AI model')
    expect(modelChip(ollama, null)).toMatchObject({ leavesPc: false, mayForward: false })

    expect(privacyHeadline([])).toEqual({ tone: 'success', text: 'Nothing leaves this PC' })
    const remote = servicesInUse(withProfile('custom', 'https://llm.example.com/v1'), [])
    expect(remote[0]).toMatchObject({ leaves: true, mayLeave: false })
    expect(privacyHeadline([...used, ...remote])).toEqual({ tone: 'warning', text: '1 service receives text' })
  })
})

describe('Deepgram is shown as opted out (fix5-ui P35)', () => {
  it('Vesper always sends mip_opt_out, so the entry says it is not trained on and the badge is not a warning', async () => {
    const { trainingLabel } = await import('../../../src/web/features/privacy/privacy.logic')
    const d = disclosure('stt.deepgram')!
    expect(d.training).toBe('no')
    expect(trainingLabel(d.training).tone).toBe('success')
    expect(d.summary).toMatch(/mip_opt_out/)
    expect(d.summary).not.toMatch(/keeps audio to train/)
    // Changed wording is shown again (acknowledgements are stored as id@version).
    expect(d.version).toBeGreaterThan(1)
  })
})
