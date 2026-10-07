/** Voice feature barrel — cross-feature exports with frozen signatures (07 E4). voice-client owns the bodies. */
export { MicControl, type MicControlProps, type MicMode } from './MicControl'
export { useVoiceState } from './useVoiceState'
export type { VoiceState } from '../../lib/store'
export { useReplySpeech, useMessageReplay, type ReplySpeech, type ReplySpeechState } from './replySpeech'
// Additive (voice-client, Phase 3): what chat-ui / Talk mode / the top bar call.
export { speakFlag, expectSpeech, interruptSpeech, speakAgain, setAutoSpeak, wantSpeech, unlockAudio } from './speechClient'
export { startMic, finishMic, cancelMic, cancelMicOf, cancelAutoSend, micActive, prewarmStt, micPreflight, holdMic, resumeMic, type MicStartOptions, type MicSessionEvent } from './micSession'
// Additive (fix-presence-soak, second pass F51): Talk mode maps a mic error to the same action as the composer's help.
export { micHelp } from './mic.logic'
export { micPlaceOf } from './micSession'
