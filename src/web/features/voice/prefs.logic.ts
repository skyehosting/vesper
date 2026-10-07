/**
 * Per-device voice preferences (07 D8 DevicePrefs: client-side, per origin). They describe this device's speakers and
 * microphone, so they never go to the server: auto-speak, the chosen mic and its processing, the echo self-test.
 * Pure (no DOM) so it is unit-tested; prefs.ts stores it in localStorage.
 */

export interface VoiceDevicePrefs {
  /** Speak replies on this device (the top-bar toggle). null = follow `voice.tts.autoSpeak`. */
  autoSpeak: boolean | null
  /** `MediaDeviceInfo.deviceId` of the chosen microphone (null = the system default). */
  micDeviceId: string | null
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
  /** Result of the echo self-test on this device (07 C15: voice barge-in is offered only after it passed). */
  echoTest: { passed: boolean; at: number; ratio: number } | null
}

export const DEFAULT_VOICE_PREFS: VoiceDevicePrefs = {
  autoSpeak: null,
  micDeviceId: null,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  echoTest: null
}

export const VOICE_PREFS_KEY = 'vesper.device.voice.v1'

const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)

/** Parse stored JSON defensively: anything unknown or malformed falls back to the defaults, field by field. */
export function parseVoicePrefs(raw: string | null): VoiceDevicePrefs {
  if (!raw) return { ...DEFAULT_VOICE_PREFS }
  let o: Record<string, unknown>
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...DEFAULT_VOICE_PREFS }
    o = v as Record<string, unknown>
  } catch {
    return { ...DEFAULT_VOICE_PREFS }
  }
  const et = o.echoTest as Record<string, unknown> | null | undefined
  return {
    autoSpeak: typeof o.autoSpeak === 'boolean' ? o.autoSpeak : null,
    micDeviceId: typeof o.micDeviceId === 'string' && o.micDeviceId.length > 0 && o.micDeviceId.length < 512 ? o.micDeviceId : null,
    echoCancellation: bool(o.echoCancellation, true),
    noiseSuppression: bool(o.noiseSuppression, true),
    autoGainControl: bool(o.autoGainControl, true),
    echoTest:
      et && typeof et === 'object' && typeof et.passed === 'boolean' && typeof et.at === 'number'
        ? { passed: et.passed, at: et.at, ratio: typeof et.ratio === 'number' ? et.ratio : 0 }
        : null
  }
}

/** Effective "speak replies on this device". */
export function effectiveAutoSpeak(prefs: Pick<VoiceDevicePrefs, 'autoSpeak'>, settingAutoSpeak: boolean): boolean {
  return prefs.autoSpeak ?? settingAutoSpeak
}
