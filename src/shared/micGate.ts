/**
 * The mic rule both ends apply (07 D6, F36): while a reply's voice plays, mic audio is held back — the client does not
 * send frames and the STT process ignores them — unless barge-in is 'voice' (the mic listens through the reply) or
 * the user is holding push-to-talk (an explicit "I am talking now": the words are captured while Vesper keeps speaking
 * with barge-in 'off', never silently dropped).
 */
export type MicGateMode = 'dictate' | 'ptt' | 'conversation'
export type MicGateBargeIn = 'off' | 'tap' | 'voice'

export function micHeldForTts(o: { mode: MicGateMode; ttsActive: boolean; bargeIn: MicGateBargeIn }): boolean {
  return o.ttsActive && o.bargeIn !== 'voice' && o.mode !== 'ptt'
}
