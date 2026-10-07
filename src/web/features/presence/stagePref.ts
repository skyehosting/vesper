/**
 * The chat stage collapsed on this device (a per-device view choice like the sidebar's, 07 D8): localStorage, guarded —
 * with storage unavailable it is remembered for this page only.
 */
import { useSyncExternalStore } from 'react'

const KEY = 'vesper.chatStageCollapsed'
const listeners = new Set<() => void>()
let collapsed = read()

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function chatStageCollapsed(): boolean {
  return collapsed
}

export function setChatStageCollapsed(on: boolean): void {
  if (on === collapsed) return
  collapsed = on
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    // storage unavailable (private mode): this page only
  }
  for (const l of [...listeners]) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

export function useChatStageCollapsed(): boolean {
  return useSyncExternalStore(subscribe, chatStageCollapsed)
}
