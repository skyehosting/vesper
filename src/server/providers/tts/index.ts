/** TTS provider registry (07 E7: ElevenLabs, OpenAI, OpenAI-compatible, Windows; no Kokoro; Piper not shipped). */
import fs from 'node:fs'
import path from 'node:path'
import { VesperError } from '@shared/errors'
import { TTS_PROVIDERS, type TtsProviderId } from '@shared/settings'
import type { Log, SecretsService, SettingsStore } from '../../services'
import { isTestMode } from '../../testMode'
import { createElevenLabs } from './elevenlabs'
import { createOpenAiTts } from './openai'
import type { TtsProvider } from './types'
import { createWindowsTts } from './windows'
import { WinTtsHost, type HostSpawn } from './winttsHost'

export type { TtsProvider, SynthRequest, SynthResult, VoiceList } from './types'

export interface ProviderDeps {
  secrets: SecretsService
  settings: SettingsStore
  log: Log
  resourcesDir: string
  tempDir: string
  /** Tests: a fake PowerShell runner. */
  spawn?: HostSpawn
  platform?: NodeJS.Platform
  hostIdleMs?: number
}

export interface TtsProviders {
  get(id: string): TtsProvider
  /** The Windows host, if it was ever started (tests and resource stats). */
  host(): WinTtsHost | null
  close(): Promise<void>
}

export function isTtsProvider(id: unknown): id is TtsProviderId {
  return typeof id === 'string' && (TTS_PROVIDERS as readonly string[]).includes(id)
}

/** resources/wintts.ps1 (extraResources when packaged); test runs also look in the working tree. */
export function winttsScript(resourcesDir: string): string {
  const shipped = path.join(resourcesDir, 'wintts.ps1')
  if (fs.existsSync(shipped) || !isTestMode()) return shipped
  return path.resolve('resources', 'wintts.ps1')
}

export function createTtsProviders(d: ProviderDeps): TtsProviders {
  let host: WinTtsHost | null = null
  const getHost = () =>
    (host ??= new WinTtsHost({ script: winttsScript(d.resourcesDir), tempDir: d.tempDir, log: d.log.child('wintts'), spawn: d.spawn, idleMs: d.hostIdleMs }))
  const env = { secrets: d.secrets, settings: d.settings }
  const all = new Map<TtsProviderId, TtsProvider>()
  return {
    get(id) {
      if (!isTtsProvider(id)) throw new VesperError('validation', { message: 'Unknown voice provider.', fields: { provider: 'Unknown voice provider' } })
      let p = all.get(id)
      if (!p) {
        if (id === 'elevenlabs') p = createElevenLabs(env)
        else if (id === 'openai' || id === 'openai-compatible') p = createOpenAiTts(id, env)
        else if (id === 'windows') p = createWindowsTts(getHost, d.platform)
        else throw new VesperError('validation', { message: "Local Piper voices aren't available in this version.", fields: { provider: 'Not available' } })
        all.set(id, p)
      }
      return p
    },
    host: () => host,
    async close() {
      await host?.close()
      host = null
    }
  }
}
