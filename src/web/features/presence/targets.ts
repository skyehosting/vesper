/**
 * Stage targets (07 D5): places the one presence surface may live — the chat backdrop behind the messages
 * (ChatBackdrop, v1.1; it replaced 1.0's top-bar slot and stage band), Settings' live preview of that look
 * (AvatarPreview, v1.1.3), Talk mode's stage, the Constellation map, or a sized <Star> (wizard, galleries, the presence
 * lab). The host moves its single
 * element (holding the one canvas) into the winning target; nothing is ever remounted.
 *
 * Winner: highest priority, newest registration on a tie. Targets that are not connected to the document are skipped.
 * No three.js here: this module is in the initial bundle.
 */
export type TargetKind = 'compact' | 'backdrop' | 'preview' | 'stage' | 'header' | 'constellation' | 'custom'

export interface StarTarget {
  id: number
  el: HTMLElement
  kind: TargetKind
  priority: number
}

// A sized <Star> on a page (finale, galleries) beats the chat backdrop; Talk mode and the Constellation beat both.
const PRIORITY: Record<TargetKind, number> = { constellation: 40, stage: 30, custom: 20, preview: 18, backdrop: 16, compact: 10, header: 10 }

let seq = 0
const targets = new Map<number, StarTarget>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of [...listeners]) l()
}

/** Register an element as a stage; returns the unregister function (call it on unmount). */
export function registerTarget(el: HTMLElement, kind: TargetKind): () => void {
  const id = ++seq
  targets.set(id, { id, el, kind, priority: PRIORITY[kind] })
  emit()
  return () => {
    if (targets.delete(id)) emit()
  }
}

/** Something about the targets changed (registered, removed, or a known element was replaced). */
export function subscribeTargets(cb: () => void): () => void {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

/** Ask the host to re-resolve (e.g. a target element was re-rendered). */
export function targetsChanged(): void {
  emit()
}

export function activeTarget(): StarTarget | null {
  let best: StarTarget | null = null
  for (const t of targets.values()) {
    if (!t.el.isConnected) continue
    if (!best || t.priority > best.priority || (t.priority === best.priority && t.id > best.id)) best = t
  }
  return best
}

export function targetCount(): number {
  return targets.size
}
