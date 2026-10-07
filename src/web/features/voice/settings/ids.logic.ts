/**
 * UI control ids of every voice setting (07 D12: a unit test walks the settings schema and asserts each leaf maps to a
 * control). Settings-wizard can merge this map into its own; each id is the `id` of the control on Settings → Voice
 * out / Voice in. Device-only preferences (mic, echo test, auto-speak on this device) live in DevicePrefs, not here.
 */
export const VOICE_SETTINGS_UI = {
  'voice.tts.enabled': 'vs-tts-enabled',
  'voice.tts.provider': 'vs-tts-provider',
  'voice.tts.baseUrl': 'vs-tts-baseurl',
  'voice.tts.voiceId': 'vs-tts-voice',
  'voice.tts.model': 'vs-tts-model',
  'voice.tts.fastModelInTalk': 'vs-tts-fast-talk',
  'voice.tts.reveal': 'vs-tts-reveal',
  'voice.tts.toneMode': 'vs-tts-tone-mode',
  'voice.tts.tonePlacement': 'vs-tts-tone-placement',
  'voice.tts.waitForTone': 'vs-tts-wait-tone',
  'voice.tts.speed': 'vs-tts-speed',
  'voice.tts.volume': 'vs-tts-volume',
  'voice.tts.autoSpeak': 'vs-tts-autospeak',
  'voice.tts.perDevice': 'vs-tts-per-device',
  'voice.tts.speakCode': 'vs-tts-speak-code',
  'voice.tts.stability': 'vs-tts-stability',
  'voice.tts.similarity': 'vs-tts-similarity',
  'voice.tts.localUnloadAfterMin': 'vs-tts-local-unload',
  'voice.stt.enabled': 'vs-stt-enabled',
  'voice.stt.provider': 'vs-stt-provider',
  'voice.stt.model': 'vs-stt-model',
  'voice.stt.mode': 'vs-stt-mode',
  'voice.stt.silenceMs': 'vs-stt-silence',
  'voice.stt.language': 'vs-stt-language',
  'voice.stt.bargeIn': 'vs-stt-barge-in',
  'voice.stt.autoSendDictation': 'vs-stt-autosend',
  'voice.stt.vadThreshold': 'vs-stt-vad',
  'voice.stt.preRollMs': 'vs-stt-preroll',
  'voice.stt.maxUtteranceSec': 'vs-stt-max-utterance',
  'voice.stt.unloadAfterMin': 'vs-stt-unload',
  'voice.stt.headphones': 'vs-stt-headphones',
  'voice.stt.earcons': 'vs-stt-earcons',
  'voice.globalHotkey': 'vs-global-hotkey'
} as const

export type VoiceSettingPath = keyof typeof VOICE_SETTINGS_UI

export function controlId(path: VoiceSettingPath): string {
  return VOICE_SETTINGS_UI[path]
}
