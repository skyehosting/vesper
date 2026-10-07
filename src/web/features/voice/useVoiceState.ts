/** useVoiceState() — frozen signature (07 E4, BLD-4); voice-client owns the implementation. */
import { useStore, type VoiceState } from '../../lib/store'

export function useVoiceState(): VoiceState {
  return useStore((s) => s.voice)
}
