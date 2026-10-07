/**
 * The sudo prompt's state (07 B2: "password within 10 min" for revoking devices, the audit log, export…). The api
 * client calls `requestSudo()` on `sudo_required`; every request that needs it while the prompt is open shares the
 * same answer, and each is retried once after a successful confirmation (lib/api.ts).
 */
import { useSyncExternalStore } from 'react'

let current: { promise: Promise<boolean>; resolve: (ok: boolean) => void } | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of [...listeners]) l()
}

/** Ask for the password; resolves true once confirmed, false when the user cancels. */
export function requestSudo(): Promise<boolean> {
  if (current) return current.promise
  let resolve!: (ok: boolean) => void
  const promise = new Promise<boolean>((r) => (resolve = r))
  current = { promise, resolve }
  emit()
  return promise
}

export function resolveSudo(ok: boolean): void {
  const c = current
  if (!c) return
  current = null
  emit()
  c.resolve(ok)
}

export function sudoOpen(): boolean {
  return current !== null
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

export function useSudoOpen(): boolean {
  return useSyncExternalStore(subscribe, sudoOpen, sudoOpen)
}

/** Leak checks: live subscribers. */
export function sudoListeners(): number {
  return listeners.size
}
