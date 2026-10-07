/**
 * "Speak replies" — the ONE per-device answer to "should replies started here be spoken?" (07 D8 DevicePrefs
 * `autoSpeak`): the top-bar toggle, `/voice on|off`, the panel, the palette, the composer, Talk mode and the speech
 * client all read and write it here. A phone in a meeting can stay silent while the PC speaks.
 *
 * Stored in the voice device prefs (features/voice/prefs.ts, `autoSpeak`; null = follow the account default
 * `voice.tts.autoSpeak`). It only means anything when voice output is set up (`voice.tts.enabled`) and the device is
 * not muted. The speaker decision must match on both sides of a turn: the composer sends `speak` from
 * `speakRepliesNow()` and the speech client expects audio from the same function, otherwise a synced-reveal reply
 * (no deltas for the speaker) would stay blank.
 */
import { useSyncExternalStore } from 'react'
import type { PublicSettings } from '@shared/settings'
import { useStore } from '../../lib/store'
import { getVoicePrefs, setVoicePrefs, subscribeVoicePrefs } from '../voice/prefs'

const getPref = (): boolean | null => getVoicePrefs().autoSpeak

/** Is voice output configured at all? */
export function voiceAvailable(settings: PublicSettings | null): boolean {
  return !!settings?.voice.tts.enabled
}

export function speakRepliesFor(settings: PublicSettings | null, devicePref: boolean | null): boolean {
  if (!voiceAvailable(settings)) return false
  return devicePref ?? settings?.voice.tts.autoSpeak ?? true
}

/** Current value, for code outside React (send time). Muted devices never ask for speech. */
export function speakRepliesNow(): boolean {
  const s = useStore.getState()
  return speakRepliesFor(s.settings, getPref()) && !s.voice.muted
}

export function useSpeakReplies(): { available: boolean; on: boolean } {
  const settings = useStore((s) => s.settings)
  const p = useSyncExternalStore(subscribeVoicePrefs, getPref, getPref)
  return { available: voiceAvailable(settings), on: speakRepliesFor(settings, p) }
}

export function setSpeakReplies(on: boolean): void {
  setVoicePrefs({ autoSpeak: on })
  // The speech client (lazy chunk) unlocks audio from this gesture, or stops what is playing when turned off.
  void import('../voice/speechClient').then((m) => (on ? m.unlockAudio() : m.interruptSpeech())).catch(() => undefined)
}
