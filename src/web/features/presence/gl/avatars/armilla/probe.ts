/**
 * Test builds only: what the Armilla renderers did (frames, per-frame CPU time, optional GPU timer results, the last
 * frame's levels/pose) and an optional level injection for deterministic stills. Read via `__vesperTest.presence`.
 */
import type { Levels } from '../../../../../lib/audio'
import type { ArmLook, Scope } from './armilla.logic'

export interface ArmillaProbe {
  frames: number
  cpuMs: number[]
  gpuMs: number[]
  timing: boolean
  debug: boolean
  inject: { out?: Partial<Levels>; mic?: Partial<Levels> } | null
  last: Record<string, number | ArmLook> | null
  /** The horizon's oscilloscope (the renderer that drew last). */
  scope: Scope | null
}

export const armillaProbe: ArmillaProbe = { frames: 0, cpuMs: [], gpuMs: [], timing: false, debug: false, inject: null, last: null, scope: null }
