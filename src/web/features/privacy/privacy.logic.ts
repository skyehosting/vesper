/**
 * Which disclosures apply to this setup (R21, 07 B13/B18): every configured service — AI profiles, Voyage memory,
 * voice out, voice in, remote access — mapped to its entry in src/shared/privacy.ts, with what leaves the PC and the
 * service-specific privacy switches (OpenRouter routing, Deepgram mip_opt_out). Pure; unit-tested.
 */
import { DISCLOSURES, disclosure, llmDisclosureId, llmMayForward, llmStaysOnPc, ttsDisclosure, UNKNOWN_PROVIDER, type Disclosure } from '@shared/privacy'
import type { PublicSettings } from '@shared/settings'

export type ServiceGroup = 'ai' | 'memory' | 'voice-out' | 'voice-in' | 'access'

export interface ServiceInUse {
  key: string
  group: ServiceGroup
  /** What Vesper uses it for, in words. */
  use: string
  disclosure: Disclosure
  /** Text leaves this PC when it's used. */
  leaves: boolean
  /** It stays on this PC unless the local program there forwards it (a loopback custom AI address, F19). */
  mayLeave: boolean
  /** Extra state lines (routing, opt-out flags, "no key yet"). */
  notes: string[]
  /** For AI profiles: the profile id (OpenRouter switches). */
  profileId?: string
  openrouter?: { noTraining: boolean; zdr: boolean }
}

export const GROUP_LABELS: Record<ServiceGroup, string> = {
  ai: 'AI replies',
  memory: 'Memory',
  'voice-out': 'Voice',
  'voice-in': 'Speech recognition',
  access: 'Other devices'
}

function fallback(id: string, service: string): Disclosure {
  return {
    id,
    version: 1,
    service,
    sends: 'Your messages and attachments.',
    summary: UNKNOWN_PROVIDER.summary,
    training: UNKNOWN_PROVIDER.training,
    retention: 'Unknown.',
    optOutHow: null,
    sources: [],
    verified: ''
  }
}

export function servicesInUse(s: PublicSettings, secretsSet: readonly string[]): ServiceInUse[] {
  const out: ServiceInUse[] = []
  for (const p of s.llm.profiles) {
    const id = llmDisclosureId(p.preset, p.baseUrl, p.model)
    const d = disclosure(id) ?? fallback(id, p.label)
    const isDefault = s.llm.defaultProfile === p.id
    const isUtility = s.llm.utilityProfile === p.id
    const roles = [isDefault ? 'default' : '', isUtility ? 'titles and summaries' : ''].filter(Boolean).join(', ')
    const notes: string[] = []
    let openrouter: ServiceInUse['openrouter']
    if (p.preset === 'openrouter') {
      openrouter = { noTraining: p.options.openrouterNoTraining, zdr: p.options.openrouterZdr }
      notes.push(
        p.options.openrouterNoTraining ? 'Vesper asks OpenRouter to skip hosts that train on prompts.' : 'Hosts that may train on your prompts are allowed.'
      )
      if (p.options.openrouterZdr) notes.push('Only zero-retention hosts are used (many free models then refuse).')
    }
    out.push({
      key: `llm:${p.id}`,
      group: 'ai',
      use: `AI profile “${p.label}”${p.model ? ` · ${p.model}` : ''}${roles ? ` (${roles})` : ''}`,
      disclosure: d,
      leaves: d.training !== 'local',
      mayLeave: llmMayForward(d.id),
      notes,
      profileId: p.id,
      openrouter
    })
  }
  if (s.memory.enabled) {
    const d = disclosure('voyage') as Disclosure
    const hasKey = secretsSet.includes('voyage')
    out.push({
      key: 'voyage',
      group: 'memory',
      use: `Memory search · ${s.memory.voyage.embedModel}`,
      disclosure: d,
      leaves: hasKey,
      mayLeave: false,
      notes: hasKey ? ['Private chats are never sent.'] : ['No key saved yet: memory works with keywords only and nothing is sent.']
    })
  }
  if (s.voice.tts.enabled) {
    const p = s.voice.tts.provider
    // One answer for here, Voice settings and the wizard (src/shared/privacy.ts, F20).
    const d = ttsDisclosure(p, s.voice.tts.baseUrl)
    out.push({ key: `tts:${p}`, group: 'voice-out', use: 'Speaking replies', disclosure: d, leaves: d.training !== 'local', mayLeave: false, notes: [] })
  }
  if (s.voice.stt.enabled) {
    const p = s.voice.stt.provider
    const d = (p === 'local' ? disclosure('local-stt') : disclosure(`stt.${p}`)) ?? fallback(`stt.${p}`, p)
    const notes = p === 'deepgram' ? ['mip_opt_out=true is sent with every request, so Deepgram keeps nothing.'] : []
    out.push({ key: `stt:${p}`, group: 'voice-in', use: 'Turning your voice into text', disclosure: d, leaves: d.training !== 'local', mayLeave: false, notes })
  }
  if (s.access.mode !== 'local') {
    const d = disclosure('remote-access') as Disclosure
    out.push({
      key: 'access',
      group: 'access',
      use:
        s.access.mode === 'lan'
          ? 'Access from your local network'
          : s.access.funnel
            ? 'Remote access with Tailscale — Funnel is public'
            : 'Remote access with Tailscale',
      disclosure: d,
      leaves: false,
      mayLeave: false,
      notes: s.access.funnel ? ['Funnel makes Vesper reachable from the whole internet.'] : []
    })
  }
  return out
}

/**
 * The Privacy page's headline badge: how many services receive text; otherwise "Nothing leaves this PC" — but only when
 * nothing in use may forward it (a loopback custom AI address gets the qualified text, F19).
 */
export function privacyHeadline(inUse: readonly ServiceInUse[]): { tone: 'warning' | 'neutral' | 'success'; text: string } {
  const leaving = inUse.filter((u) => u.leaves).length
  if (leaving) return { tone: 'warning', text: `${leaving} service${leaving === 1 ? '' : 's'} receive${leaving === 1 ? 's' : ''} text` }
  if (inUse.some((u) => u.mayLeave)) return { tone: 'neutral', text: 'Stays on this PC unless your local program forwards it' }
  return { tone: 'success', text: 'Nothing leaves this PC' }
}

/** Disclosures with a place of their own on the Privacy page: the page's intro and its "Update checks" group. */
export const PAGE_DISCLOSURES: readonly string[] = ['welcome', 'updates']

/** Disclosures for services not in use (so every disclosure stays readable, 07 B13). */
export function otherDisclosures(inUse: readonly ServiceInUse[]): Disclosure[] {
  const used = new Set(inUse.map((u) => u.disclosure.id))
  return DISCLOSURES.filter((d) => !PAGE_DISCLOSURES.includes(d.id) && !used.has(d.id))
}

export interface LocalItem {
  key: string
  title: string
  detail: string
}

/** What stays on this PC in this setup. */
export function localOnly(s: PublicSettings): LocalItem[] {
  const items: LocalItem[] = [
    { key: 'chats', title: 'Your chats and attachments', detail: 'Stored in your data folder; nothing is uploaded to Vesper (it has no servers).' },
    {
      key: 'memory',
      title: 'Memory, the timeline and the search index',
      detail: 'Messages, tags, timestamps, the chat list and every search vector live in the local database.'
    },
    { key: 'keys', title: 'Your API keys', detail: 'Encrypted with your Windows account and only ever sent to the service they belong to.' }
  ]
  // Only profiles whose address is this PC (F19): Ollama on another machine is not "on this PC".
  const localIds = s.llm.profiles.map((p) => llmDisclosureId(p.preset, p.baseUrl, p.model)).filter(llmStaysOnPc)
  if (localIds.length)
    items.push({
      key: 'llm',
      title: localIds.some(llmMayForward) ? 'A program on this PC' : 'A local AI model',
      detail: localIds.every((id) => id === 'llm.local')
        ? 'Replies from Ollama or LM Studio are generated on this PC.'
        : 'Replies come from a program on this PC (unless that program forwards requests online).'
    })
  if (s.voice.tts.enabled && (s.voice.tts.provider === 'windows' || s.voice.tts.provider === 'piper'))
    items.push({ key: 'tts', title: 'Speech', detail: 'Voices are generated on this PC.' })
  if (s.voice.stt.enabled && s.voice.stt.provider === 'local')
    items.push({ key: 'stt', title: 'Speech recognition', detail: 'Your microphone audio is transcribed on this PC and not stored.' })
  return items
}

export type TrainingTone = 'success' | 'warning' | 'neutral' | 'danger'

export function trainingLabel(t: Disclosure['training']): { text: string; tone: TrainingTone } {
  switch (t) {
    case 'no':
      return { text: 'Not used for training', tone: 'success' }
    case 'local':
      return { text: 'Stays on this PC', tone: 'success' }
    case 'yes-by-default':
      return { text: 'May train on it unless you opt out', tone: 'warning' }
    case 'tier-dependent':
      return { text: 'Training depends on your plan', tone: 'warning' }
    default:
      return { text: 'Unknown', tone: 'neutral' }
  }
}
