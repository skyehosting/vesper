/**
 * `__vesperTest.presence` (test builds + test mode only, 07 B10): frame counters for the 0-fps gates (07 D4), WebGL
 * bookkeeping for the one-context and no-leak gates (07 D5, D14), focus override (e2e windows never take focus),
 * context loss simulation, and synthetic speech to drive the speaking visuals without a TTS provider.
 */
import { applyAppearance, appearanceOf } from '../../../app/appearance'
import { getAudioEngine } from '../../../lib/audio'
import { useStore } from '../../../lib/store'
import type { PresencePrefs, StarState } from '../../../lib/store/presence'
import { registerTestHooks } from '../../../lib/testHooks'
import { glInfo, loseContext } from '../gl/glStats'
import { activeTarget, targetCount } from '../targets'
import { armillaProbe } from '../gl/avatars/armilla/probe'
import { horizonWave, SCOPE_WINDOW_S } from '../gl/avatars/armilla/armilla.logic'
import { driverStats, forceStarState } from './driver'
import type { FrameScheduler } from './scheduler'

export function installPresenceTestHooks(d: { scheduler: FrameScheduler; host: HTMLElement; setDpr?: (n: number | null) => void }): () => void {
  if (!__VESPER_TEST__) return () => undefined
  let synthSeq = 0
  return registerTestHooks('presence', {
    /** Frames drawn, rAF callbacks, polls, whether the loop runs, and the current budget. */
    frames: () => ({ ...d.scheduler.stats, budget: { ...d.scheduler.stats.budget } }),
    resetFrames: () => d.scheduler.resetStats(),
    budget: () => d.scheduler.current(),
    input: () => d.scheduler.input(),
    /** Where the surface is and what it shows. */
    surface: () => {
      const t = activeTarget()
      return {
        kind: t?.kind ?? null,
        targetId: t?.el.id || null,
        inTarget: !!t && t.el.contains(d.host),
        canvas: d.host.querySelector('canvas') !== null,
        canvasVisible: (() => {
          const c = d.host.querySelector('canvas')
          return !!c && getComputedStyle(c).visibility !== 'hidden'
        })(),
        minimal2d: d.host.querySelector('.m2d') !== null,
        armilla2d: d.host.querySelector('.arm2d') !== null,
        glyph: d.host.querySelector('.presence-glyph') !== null,
        targets: targetCount(),
        state: useStore.getState().presence.star
      }
    },
    gl: () => glInfo(),
    /** Armilla's probe: frames, CPU ms per frame (and GPU ms when timing is on), the last frame's levels and pose. */
    armilla: () => ({ ...armillaProbe, cpuMs: [...armillaProbe.cpuMs], gpuMs: [...armillaProbe.gpuMs] }),
    armillaReset: () => {
      armillaProbe.frames = 0
      armillaProbe.cpuMs.length = 0
      armillaProbe.gpuMs.length = 0
    },
    armillaDebug: (on: boolean) => {
      armillaProbe.debug = on
    },
    armillaTiming: (on: boolean) => {
      armillaProbe.timing = on
    },
    /**
     * The horizon's oscilloscope as drawn now (v1.1.5): `n − 1` heights along its front from the left end to the right
     * end (−1…1 of full swing), the drawn level, whose voice, the latency delay applied and the drawn frame's age (ms),
     * the window (ms) and the texture version. null before Armilla drew.
     */
    armillaWave: (n = 64) => {
      const sc = armillaProbe.scope
      if (!sc) return null
      const heights: number[] = []
      for (let k = 1; k < n; k++) heights.push(horizonWave(sc, Math.acos((2 * k) / n - 1), 1))
      return { heights, level: sc.level, who: sc.who, delayMs: sc.delayS * 1000, ageMs: sc.drawnAge * 1000, windowMs: SCOPE_WINDOW_S * 1000, version: sc.version }
    },
    /** Deterministic stills: override the levels the avatar reads (null = the real LevelSources). */
    armillaInject: (inj: typeof armillaProbe.inject) => {
      armillaProbe.inject = inj
    },
    /** Start/stop the real microphone (the e2e fake mic plays a WAV) so listening reacts to real input levels. */
    mic: async (on: boolean) => {
      const { getMicCapture } = await import('../../../lib/audio')
      if (on) await getMicCapture().start()
      else getMicCapture().stop()
      return getMicCapture().stats()
    },
    driver: () => driverStats(),
    /** Hold the Star in a state over what the driver derives (null = back to derived). */
    forceState: (state: StarState | null) => forceStarState(state),
    /** null = real window focus. */
    /** Render the canvas at exactly this DPR (null = the normal caps): GPU cost at DPR 1.25 / 2 on a DPR-1 test window. */
    setDpr: (n: number | null) => d.setDpr?.(n),
    setFocus: (v: boolean | null) => d.scheduler.setFocusOverride(v),
    /** Adaptive quality (off in test mode by default). */
    watchPace: (on: boolean) => {
      d.scheduler.watchPace = on
    },
    setPrefs: (p: PresencePrefs) => useStore.getState().setPresencePrefs(p),
    setPaused: (v: boolean) => useStore.getState().setStarPaused(v),
    /** Change theme/accent for this page view only (no settings are written). */
    appearance: (p: { theme?: 'dark' | 'light' | 'system'; accent?: 'gold' | 'violet' | 'rose' | 'aurora' | 'ice' }) => {
      const st = useStore.getState()
      if (!st.settings) return
      const next = { ...st.settings, appearance: { ...st.settings.appearance, ...p } }
      st.applySettings(next)
      applyAppearance(appearanceOf(next), { persist: false })
    },
    setGameMode: (active: boolean) => useStore.getState().setGameMode({ active, reason: active ? 'forced' : 'off' }),
    loseContext: (restoreAfterMs = 300) => loseContext(restoreAfterMs),
    /** Pretend WebGL is missing (blocked GPU): the Star falls back to 2D, the Constellation to its list. */
    setWebgl: (status: 'ok' | 'unavailable') => useStore.getState().setWebglStatus(status),
    /** Constellation: the same path as a `reply.tool` event (recalled sources pulse). */
    recalled: async (sessionUid: string, shortIds: string[]) => (await import('../constellation/data')).recalled(sessionUid, shortIds),
    constellation: async () => {
      const m = await import('../constellation/model')
      const st = m.getState()
      return {
        status: st.status,
        edges: st.edges.length,
        hover: st.hover,
        selected: st.selected,
        matches: st.matchCount,
        pulses: st.pulses.size,
        replying: st.replying,
        ...m.modelStats()
      }
    },
    /** Constellation: select a star as a touch tap would (phones open the card sheet). */
    selectStar: async (uid: string) => {
      const m = await import('../constellation/model')
      m.setSelected(m.getState().byUid.get(uid) ?? -1)
    },
    /** Constellation: screen position (stage CSS px + stage offset → page px) of a session's star. */
    starAt: async (uid: string) => {
      const m = await import('../constellation/model')
      const i = m.getState().byUid.get(uid)
      const stage = document.querySelector('.cst__stage')?.getBoundingClientRect()
      if (i === undefined || !stage) return null
      const p = m.view.projected
      return { x: stage.left + p[i * 4], y: stage.top + p[i * 4 + 1], depth: p[i * 4 + 2], r: p[i * 4 + 3] }
    },
    /** Play a real WAV (base64) through the AudioEngine as one spoken chunk (v11 design pass: real speech dynamics). */
    speakWav: async (b64: string, durationMs: number) => {
      const engine = getAudioEngine()
      await engine.unlock()
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const replyId = `presence-wav-${++synthSeq}`
      engine.enqueue(
        {
          sessionUid: 'gallery',
          evSeq: 0,
          replyId,
          index: 0,
          src: [0, 1],
          text: '…',
          spoken: '…',
          timeline: { startsMs: [0], endsMs: [durationMs] },
          durationMs,
          mime: 'audio/wav',
          instant: false,
          final: true
        },
        bytes.buffer
      )
      return replyId
    },
    /** Play a synthetic spoken reply through the real AudioEngine (muted in test mode); resolves with its id. */
    speak: async (text = 'Hello there, it is lovely to hear from you again today.') => {
      const { synthReply } = await import('../../../lib/audio/synth')
      const engine = getAudioEngine()
      await engine.unlock()
      const replyId = `presence-synth-${++synthSeq}`
      const chunks = synthReply(replyId, [text])
      for (const c of chunks) engine.enqueue(c.header, c.bytes.slice(0))
      return replyId
    }
  })
}
