/**
 * What the top bar's chips say (pure, unit-tested): the model chip (which AI profile and model this chat uses, and
 * whether text leaves the PC — 07 B13), and the memory chip ("Memory off", "Keyword only", … — 07 D13).
 */
import { llmDisclosureId, llmMayForward, llmStaysOnPc } from '@shared/privacy'
import type { PublicSettings } from '@shared/settings'
import type { MemoryMode, MemoryScope, MemoryStatusState } from '@shared/types/domain'

export interface ModelChipInfo {
  profileId: string | null
  profileLabel: string | null
  model: string | null
  /** The chat overrides the default model/profile. */
  overridden: boolean
  /** The provider is not on this PC (cloud APIs; Ollama "…cloud" models; a model at another computer's address). */
  leavesPc: boolean
  /** A program at a loopback custom address: on this PC, but it may forward the text online (F19, research 08 §4.2). */
  mayForward: boolean
  /** Name of the service text goes to (for the "leaves this PC" note). */
  service: string | null
}

export function modelChip(settings: PublicSettings | null, session: { llmProfile?: string | null; model?: string | null } | null): ModelChipInfo {
  const profiles = settings?.llm.profiles ?? []
  const profileId = session?.llmProfile ?? settings?.llm.defaultProfile ?? profiles[0]?.id ?? null
  const profile = profiles.find((p) => p.id === profileId) ?? null
  const model = session?.model || profile?.model || null
  const disclosure = profile ? llmDisclosureId(profile.preset, profile.baseUrl, model ?? undefined) : null
  return {
    profileId: profile?.id ?? null,
    profileLabel: profile?.label ?? null,
    model,
    overridden: !!(session?.model || session?.llmProfile),
    leavesPc: disclosure !== null && !llmStaysOnPc(disclosure),
    mayForward: llmMayForward(disclosure),
    service: profile ? profile.label : null
  }
}

/** A short display name for a model id: "anthropic/claude-sonnet-4.5" → "claude-sonnet-4.5". */
export function shortModel(id: string): string {
  const tail = id.split('/').pop() ?? id
  return tail.length > 32 ? `${tail.slice(0, 31)}…` : tail
}

export type MemoryTone = 'off' | 'muted' | 'on' | 'warn'

export interface MemoryChipInfo {
  on: boolean
  label: string
  tone: MemoryTone
  /** One sentence for the tooltip / screen readers. */
  detail: string
}

/**
 * Same rule as the engine (chat/context.ts memoryOn): AI memory is on unless this chat's switch is off. The global
 * switch (`settings.memory.enabled`) is Voyage AI; without it memory works by keywords on this PC (F37).
 */
export function memoryOn(_globalEnabled: boolean, mode: MemoryMode): boolean {
  return mode !== 'off'
}

export function memoryChip(globalEnabled: boolean, mode: MemoryMode, state: MemoryStatusState | null, isPrivate: boolean): MemoryChipInfo {
  if (!memoryOn(globalEnabled, mode)) {
    return {
      on: false,
      label: 'Memory off',
      tone: 'off',
      detail: 'Memory is off for this chat.'
    }
  }
  const scope = isPrivate ? ' This chat is private: it searches only itself.' : ''
  switch (state) {
    case 'ready':
      return { on: true, label: 'Memory', tone: 'on', detail: `Memory is on: the AI can search what it may recall.${scope}` }
    case 'loading':
      return { on: true, label: 'Memory · loading', tone: 'muted', detail: `The memory index is loading; searches use keywords until it is ready.${scope}` }
    case 'degraded':
    case 'error':
      return { on: true, label: 'Memory · limited', tone: 'warn', detail: `Memory can't reach Voyage AI right now; searches use keywords.${scope}` }
    case 'disabled':
      return { on: true, label: 'Keyword only', tone: 'muted', detail: `Memory is on with keyword search on this PC (Voyage AI is off in Settings → Memory).${scope}` }
    case 'keyword-only':
    case null:
    default:
      return { on: true, label: 'Keyword only', tone: 'muted', detail: `Memory is on with keyword search only (no Voyage AI key).${scope}` }
  }
}

/** The scope the engine will use for this chat (session value, else the Settings default). */
export function effectiveScope(sessionScope: MemoryScope | 'inherit' | undefined, scopeDefault: MemoryScope): MemoryScope {
  return !sessionScope || sessionScope === 'inherit' ? scopeDefault : sessionScope
}

export const SCOPE_TEXT: Record<MemoryScope, { label: string; detail: string }> = {
  this: { label: 'This chat only', detail: 'The AI recalls only this conversation.' },
  linked: { label: 'This chat and linked chats', detail: 'The AI may recall this conversation and the chats linked below.' },
  all: { label: 'All chats', detail: 'The AI may recall any chat except private ones.' }
}
