/**
 * WebGL bookkeeping for leak tests and the resource panel (07 D5, D14): contexts created/live, frames rendered,
 * losses/restores, and the live renderer's `info` (geometries, textures, programs back to baseline after style switches).
 */
import type * as THREE from 'three'

export const glCounters = {
  created: 0,
  live: 0,
  rendered: 0,
  lost: 0,
  restored: 0,
  renderer: null as THREE.WebGLRenderer | null
}

export interface GlInfo {
  created: number
  live: number
  rendered: number
  lost: number
  restored: number
  geometries: number
  textures: number
  programs: number
  calls: number
}

export function glInfo(): GlInfo {
  const r = glCounters.renderer
  return {
    created: glCounters.created,
    live: glCounters.live,
    rendered: glCounters.rendered,
    lost: glCounters.lost,
    restored: glCounters.restored,
    geometries: r?.info.memory.geometries ?? 0,
    textures: r?.info.memory.textures ?? 0,
    programs: r?.info.programs?.length ?? 0,
    calls: r?.info.render.calls ?? 0
  }
}

/** Test builds: simulate a GPU reset through WEBGL_lose_context. */
export function loseContext(restoreAfterMs: number): boolean {
  const r = glCounters.renderer
  const ext = r?.getContext().getExtension('WEBGL_lose_context')
  if (!ext) return false
  ext.loseContext()
  window.setTimeout(() => ext.restoreContext(), restoreAfterMs)
  return true
}
