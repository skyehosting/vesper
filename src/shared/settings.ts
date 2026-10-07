/**
 * Settings schema (03 §2 + 07): the ONLY place defaults and ranges live (07 E12). Shared by the server (validation,
 * persistence in settings.json) and the web client (forms read min/max from here, never literals).
 *
 * Each leaf has a UI control id in `SETTINGS_UI` so a unit test can prove every setting is reachable (07 D12).
 * Secrets are never part of settings (they live in secrets.json, write-only).
 */
import { z } from 'zod'
import { isLoopbackHost } from './loopback'
import { migrateToneSettings, TONE_MODES } from './voiceTone'

export const ACCENTS = ['gold', 'violet', 'rose', 'aurora', 'ice'] as const
export type AccentId = (typeof ACCENTS)[number]

export const PRESET_IDS = ['openai', 'anthropic', 'gemini', 'openrouter', 'groq', 'mistral', 'xai', 'deepseek', 'together', 'ollama', 'lmstudio', 'custom'] as const
export type PresetId = (typeof PRESET_IDS)[number]

export const TTS_PROVIDERS = ['elevenlabs', 'openai', 'windows', 'openai-compatible', 'piper'] as const
export type TtsProviderId = (typeof TTS_PROVIDERS)[number]

export const STT_PROVIDERS = ['local', 'openai', 'groq', 'deepgram', 'elevenlabs'] as const
export type SttProviderId = (typeof STT_PROVIDERS)[number]

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]

/** How often the installed app asks GitHub for a new version (H-v12-updates); 'off' = only when asked (Check now). */
export const UPDATE_INTERVALS = ['off', '5m', '15m', '1h', '1d'] as const
export type UpdateInterval = (typeof UPDATE_INTERVALS)[number]

/**
 * What happens once a new version is found (H-v12-updates): 'install-on-close' downloads quietly and installs when
 * Vesper closes (or on "Restart to update"); 'ask' waits for Download; 'auto' also restarts by itself when idle.
 */
export const UPDATE_MODES = ['install-on-close', 'ask', 'auto'] as const
export type UpdateMode = (typeof UPDATE_MODES)[number]

const id = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/)

/** Base URL rules (07 B1): https unless loopback; no userinfo, no query/fragment. Checked again server-side. */
export function baseUrlProblem(raw: string, allowPlainHttpHosts: readonly string[] = []): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'Not a valid URL'
  }
  if (u.username || u.password) return 'URLs with a user name or password are not allowed'
  if (u.search || u.hash) return 'Remove the ?query or #fragment from the URL'
  if (u.protocol === 'https:') return null
  if (u.protocol !== 'http:') return 'Use an https:// address'
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (isLoopbackHost(host) || allowPlainHttpHosts.includes(host)) return null
  return 'Plain http:// is only allowed for this PC (localhost). Use https://'
}

const llmProfile = z.object({
  id,
  label: z.string().min(1).max(60),
  preset: z.enum(PRESET_IDS),
  adapter: z.enum(['openai', 'anthropic']),
  baseUrl: z.string().max(500),
  model: z.string().max(200).default(''),
  /** Custom auth header NAME (its value is a secret). Empty = the preset default. */
  authHeader: z.string().max(80).default(''),
  options: z
    .object({
      maxTokens: z.number().int().min(256).max(128000).default(16000),
      temperature: z.number().min(0).max(2).optional(),
      effort: z.enum(EFFORTS).optional(),
      reasoningDisplay: z.enum(['hidden', 'summarized']).default('hidden'),
      /** OpenRouter: skip hosts that train on prompts (07 B18). */
      openrouterNoTraining: z.boolean().default(true),
      /** OpenRouter: zero-retention hosts only (many :free models then fail). */
      openrouterZdr: z.boolean().default(false)
    })
    .prefault({}),
  capabilities: z
    .object({
      tools: z.boolean().optional(),
      vision: z.boolean().optional(),
      pdf: z.boolean().optional(),
      contextWindow: z.number().int().positive().optional()
    })
    .default({})
})
export type LlmProfile = z.infer<typeof llmProfile>

export const settingsSchema = z.object({
  version: z.literal(1).default(1),
  profile: z
    .object({
      userName: z.string().max(60).default(''),
      assistantName: z.string().min(1).max(40).default('Vesper'),
      clock: z.enum(['24h', '12h']).default('24h'),
      /** IANA zone override; empty = the device's own zone. */
      timeZone: z.string().max(64).default('')
    })
    .default({ userName: '', assistantName: 'Vesper', clock: '24h', timeZone: '' }),
  llm: z
    .object({
      profiles: z.array(llmProfile).max(20).default([]),
      defaultProfile: z.string().nullable().default(null),
      /** Profile + model for titles, recaps, summaries (null = the default profile at low effort) — 07 C18. */
      utilityProfile: z.string().nullable().default(null),
      utilityModel: z.string().max(200).default('')
    })
    .default({ profiles: [], defaultProfile: null, utilityProfile: null, utilityModel: '' }),
  chat: z
    .object({
      pageSize: z.number().int().min(20).max(300).default(100),
      sendOnEnter: z.boolean().default(true),
      fontSize: z.number().int().min(13).max(20).default(15),
      autoTitle: z.boolean().default(true),
      showReasoning: z.boolean().default(false),
      contextFill: z.number().min(0.3).max(0.9).default(0.6),
      maxToolCalls: z.number().int().min(0).max(6).default(3),
      attachments: z
        .object({ maxFileMb: z.number().int().min(1).max(100).default(25), maxTextChars: z.number().int().min(1000).max(1_000_000).default(200_000) })
        .default({ maxFileMb: 25, maxTextChars: 200_000 }),
      notifyWhenHidden: z.boolean().default(true),
      notificationPreviews: z.boolean().default(false),
      announceReplies: z.enum(['full', 'notice', 'off']).default('full'),
      loadRemoteImages: z.enum(['ask', 'never']).default('ask')
    })
    .prefault({}),
  memory: z
    .object({
      enabled: z.boolean().default(false),
      scopeDefault: z.enum(['this', 'linked', 'all']).default('linked'),
      autoRecall: z.boolean().default(true),
      autoRecallMinScore: z.number().min(0).max(1).default(0.5),
      searchMinScore: z.number().min(0).max(1).default(0.25),
      maxRecallRounds: z.number().int().min(1).max(20).default(8),
      maxRecallTokens: z.number().int().min(200).max(8000).default(1500),
      voyage: z
        .object({
          baseUrl: z.string().max(200).default('https://api.voyageai.com/v1'),
          embedModel: z.string().max(80).default('voyage-4-lite'),
          rerankModel: z.string().max(80).default('rerank-3-lite'),
          dim: z.union([z.literal(256), z.literal(512), z.literal(1024), z.literal(2048)]).default(1024),
          tier: z.enum(['auto', 'free', 'tier1', 'tier2', 'tier3']).default('auto'),
          customEndpoint: z.boolean().default(false)
        })
        .prefault({})
    })
    .prefault({}),
  voice: z
    .object({
      tts: z
        .object({
          enabled: z.boolean().default(false),
          provider: z.enum(TTS_PROVIDERS).default('windows'),
          baseUrl: z.string().max(500).default(''),
          voiceId: z.string().max(200).nullable().default(null),
          model: z.string().max(80).nullable().default(null),
          fastModelInTalk: z.boolean().default(true),
          reveal: z.enum(['synced', 'text-first']).default('synced'),
          /**
           * How the AI tags its voice tone (H-v11-tone; replaces 1.0.0's `tone: boolean`, read by migrateSettingsInput):
           * 'conversation' = only when the mood of the conversation shifts, 'reply' = every reply, 'off' = never.
           */
          toneMode: z.enum(TONE_MODES).default('conversation'),
          tonePlacement: z.enum(['start', 'end']).default('start'),
          waitForTone: z.boolean().default(false),
          speed: z.number().min(0.7).max(1.3).default(1),
          volume: z.number().min(0).max(1).default(0.9),
          autoSpeak: z.boolean().default(true),
          perDevice: z.enum(['sender', 'all']).default('sender'),
          speakCode: z.enum(['skip', 'announce']).default('skip'),
          stability: z.number().min(0).max(1).default(0.5),
          similarity: z.number().min(0).max(1).default(0.75),
          localUnloadAfterMin: z.number().int().min(0).max(120).default(5)
        })
        .prefault({}),
      stt: z
        .object({
          enabled: z.boolean().default(false),
          provider: z.enum(STT_PROVIDERS).default('local'),
          model: z.string().max(80).default('parakeet-tdt-0.6b-v3-int8'),
          mode: z.enum(['dictate', 'ptt', 'conversation']).default('dictate'),
          silenceMs: z.number().int().min(300).max(5000).default(1200),
          language: z.string().max(10).default('auto'),
          bargeIn: z.enum(['off', 'tap', 'voice']).default('tap'),
          autoSendDictation: z.boolean().default(false),
          vadThreshold: z.number().min(0.1).max(0.95).default(0.5),
          preRollMs: z.number().int().min(0).max(1000).default(400),
          maxUtteranceSec: z.number().int().min(5).max(300).default(60),
          unloadAfterMin: z.number().int().min(0).max(120).default(10),
          headphones: z.boolean().default(false),
          earcons: z.boolean().default(true)
        })
        .prefault({}),
      globalHotkey: z.string().max(40).nullable().default(null)
    })
    .prefault({}),
  appearance: z
    .object({
      theme: z.enum(['dark', 'light', 'system']).default('dark'),
      accent: z.enum(ACCENTS).default('gold'),
      reduceMotion: z.boolean().default(false),
      star: z
        .object({
          // v1.1: Armilla (the armillary with the voice on its horizon) is the default; the 1.0 styles stay selectable.
          style: z.enum(['armilla', 'orb', 'nebula', 'minimal2d', 'off']).default('armilla'),
          quality: z.enum(['low', 'medium', 'high']).default('high'),
          showInChat: z.boolean().default(true),
          pauseWhenUnfocused: z.boolean().default(true),
          maxFps: z.number().int().min(15).max(120).default(60),
          // v1.1.3: how strongly the avatar shows behind the chat (1 = the 1.1 look; the cap over the message column
          // stays within what keeps message text ≥ 4.5:1, backdrop.logic.ts) and how large it is there.
          visibility: z.number().min(0.5).max(2).default(1),
          size: z.number().min(0.8).max(1.2).default(1)
        })
        .prefault({})
    })
    .prefault({}),
  performance: z
    .object({
      gameMode: z.enum(['auto', 'on', 'off']).default('auto')
    })
    .default({ gameMode: 'auto' }),
  access: z
    .object({
      mode: z.enum(['local', 'lan', 'tailscale']).default('local'),
      port: z.number().int().min(1024).max(65535).default(41730),
      lanAddress: z.string().max(64).nullable().default(null),
      lanPort: z.number().int().min(1024).max(65535).default(41731),
      tailnetPort: z.number().int().min(1024).max(65535).default(41732),
      funnel: z.boolean().default(false),
      funnelAutoOffHours: z.number().int().min(0).max(168).default(8),
      keepRemoteWhileClosed: z.boolean().default(false),
      remoteMayChangeSettings: z.boolean().default(false),
      idleTimeoutDays: z.number().int().min(1).max(90).default(7)
    })
    .prefault({}),
  desktop: z
    .object({
      closeToTray: z.boolean().default(false),
      startWithWindows: z.boolean().default(false),
      startInBackground: z.boolean().default(false),
      keepWindowWarmSec: z.number().int().min(-1).max(3600).default(30)
    })
    .prefault({}),
  data: z
    .object({
      backups: z.boolean().default(true),
      backupDaily: z.number().int().min(1).max(30).default(7),
      backupWeekly: z.number().int().min(0).max(52).default(4),
      backupExtraDir: z.string().max(400).default(''),
      diagnosticLogging: z.boolean().default(false)
    })
    .prefault({}),
  /** Auto-updates from GitHub Releases (H-v12-updates; desktop app only, desktop-only to change). */
  updates: z
    .object({
      checkEvery: z.enum(UPDATE_INTERVALS).default('1h'),
      mode: z.enum(UPDATE_MODES).default('install-on-close')
    })
    .prefault({}),
  privacy: z.object({ acknowledged: z.record(z.string(), z.number()).default({}) }).default({ acknowledged: {} }),
  wizard: z
    .object({
      completed: z.boolean().default(false),
      step: z.string().max(40).nullable().default(null),
      path: z.enum(['quick', 'guided']).nullable().default(null),
      /** Steps the owner skipped (07 D11): they feed the first-chat setup checklist (07 D13). */
      skipped: z.array(z.string().max(40)).max(20).default([]),
      /** The owner closed the setup checklist. */
      checklistDismissed: z.boolean().default(false)
    })
    .prefault({})
})

export type Settings = z.infer<typeof settingsSchema>

export function defaultSettings(): Settings {
  return settingsSchema.parse({})
}

/**
 * Settings written by an older Vesper, or a PATCH from an older client, may still use retired keys:
 * `voice.tts.tone: boolean` (≤ 1.0.0) becomes `voice.tts.toneMode` (false → 'off', true → 'conversation'; an explicit
 * toneMode wins). Returns a copy when something changed; anything that isn't a settings-shaped object passes through.
 */
export function migrateSettingsInput<T>(raw: T): T {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
  const voice = (raw as Record<string, unknown>).voice
  if (typeof voice !== 'object' || voice === null || Array.isArray(voice)) return raw
  const tts = (voice as Record<string, unknown>).tts
  const next = migrateToneSettings(tts)
  if (next === tts) return raw
  return { ...raw, voice: { ...(voice as Record<string, unknown>), tts: next } } as T
}

/**
 * v1.1 (07 H-v11-presence): a settings.json written by 1.0 — it still has 1.0's `voice.tts.tone` boolean (1.0 saved
 * every leaf, defaults included) — that kept 1.0's default avatar style 'orb' moves to Armilla, the new default. Once:
 * the next save writes `toneMode` instead of `tone`, so a later choice of the orb stays. Load path only (not PATCH).
 */
export function migrateLegacyStarStyle<T>(raw: T): T {
  const r = raw as { voice?: { tts?: Record<string, unknown> }; appearance?: { star?: Record<string, unknown> } } | null
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return raw
  const tts = r.voice?.tts
  const star = r.appearance?.star
  if (!tts || typeof tts !== 'object' || typeof tts.tone !== 'boolean' || tts.toneMode !== undefined) return raw
  if (!star || typeof star !== 'object' || star.style !== 'orb') return raw
  return { ...r, appearance: { ...r.appearance, star: { ...star, style: 'armilla' } } } as T
}

/** Deep partial for PATCH requests. */
export type DeepPartial<T> = T extends readonly (infer U)[] ? U[] : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T

/**
 * Paths a non-desktop device may change when `access.remoteMayChangeSettings` is on (07 B2). Everything else
 * (providers, URLs, access, protocols, data, desktop) is desktop-only. Per-session settings use the sessions API.
 */
export const REMOTE_WRITABLE_PREFIXES = [
  'profile.clock',
  'chat.sendOnEnter',
  'chat.fontSize',
  'chat.showReasoning',
  'chat.announceReplies',
  'chat.notificationPreviews',
  'voice.tts.reveal',
  'voice.tts.speed',
  'voice.tts.volume',
  'voice.tts.autoSpeak',
  'voice.tts.toneMode',
  'voice.stt.mode',
  'voice.stt.silenceMs',
  'voice.stt.bargeIn',
  'appearance'
] as const

/** Settings sent to clients (everything in settings.json is non-secret; this alias documents the boundary). */
export type PublicSettings = Settings
