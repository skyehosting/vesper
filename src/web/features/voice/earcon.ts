/**
 * Soft start/stop chimes for hands-free listening (research 07 §3.2: on in conversation and push-to-talk, off for
 * dictation; Settings → Voice in → "Sounds"). Two short sine notes on the page's shared AudioContext, through the
 * same test mute as speech (gain 0 in test mode). Every node is disconnected when its note ends.
 */
import { getContextHost } from '../../lib/audio'
import { useStore } from '../../lib/store'

export type EarconKind = 'start' | 'stop'

const NOTES: Record<EarconKind, [number, number]> = { start: [660, 880], stop: [880, 587] }
const NOTE_S = 0.09
let live = 0
let seq = 0

export function earcon(kind: EarconKind): void {
  const s = useStore.getState()
  if (!s.settings?.voice.stt.earcons) return
  const host = getContextHost()
  if (!host.isUnlocked) return
  const owner = `earcon#${++seq}`
  void host.hold(owner).then(() => {
    const ctx = host.peek()
    if (!ctx || ctx.state !== 'running') return host.release(owner)
    const muted = (__VESPER_TEST__ && s.bootstrap?.isTest === true && s.bootstrap.mute !== false) || s.voice.muted
    const peak = muted ? 0 : 0.06 * (s.settings?.voice.tts.volume ?? 0.9)
    const gain = ctx.createGain()
    gain.connect(ctx.destination)
    const t0 = ctx.currentTime + 0.01
    let pending = NOTES[kind].length
    live += 1 + pending
    NOTES[kind].forEach((freq, i) => {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = freq
      const start = t0 + i * NOTE_S
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(peak, start + 0.012)
      gain.gain.linearRampToValueAtTime(0, start + NOTE_S - 0.005)
      osc.connect(gain)
      osc.onended = () => {
        osc.onended = null
        osc.disconnect()
        live--
        if (--pending === 0) {
          gain.disconnect()
          live--
          host.release(owner)
        }
      }
      osc.start(start)
      osc.stop(start + NOTE_S)
    })
  })
}

/** Earcon audio nodes alive (leak checks: back to 0 after the notes end). */
export function earconNodes(): number {
  return live
}
