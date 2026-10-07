/**
 * A tiny in-page event bus between the chat's parts that don't share a parent (slash commands → the open chat page,
 * composer ↔ message window). Every subscription returns its unsubscribe; listener counts are exposed for leak checks.
 */

export interface ChatBusEvents {
  /** Start editing the newest user message of the open chat (/edit-last, ↑ in an empty composer). */
  'edit-last': { sessionUid: string }
  /** Open the commands help sheet (/help). */
  'open-help': Record<string, never>
  /** Put text into the composer (and focus it). */
  'insert': { sessionUid: string; text: string }
  /** Move focus to the composer. */
  'focus-composer': { sessionUid: string }
  /** Open in-session search (Ctrl+F). */
  'open-find': { sessionUid: string }
}

type Handler<K extends keyof ChatBusEvents> = (e: ChatBusEvents[K]) => void

const handlers = new Map<keyof ChatBusEvents, Set<Handler<keyof ChatBusEvents>>>()

export function onChat<K extends keyof ChatBusEvents>(type: K, fn: Handler<K>): () => void {
  let set = handlers.get(type)
  if (!set) {
    set = new Set()
    handlers.set(type, set)
  }
  set.add(fn as Handler<keyof ChatBusEvents>)
  return () => {
    set.delete(fn as Handler<keyof ChatBusEvents>)
  }
}

export function emitChat<K extends keyof ChatBusEvents>(type: K, e: ChatBusEvents[K]): boolean {
  const set = handlers.get(type)
  if (!set || set.size === 0) return false
  for (const fn of [...set]) fn(e)
  return true
}

export function chatBusStats(): number {
  let n = 0
  for (const s of handlers.values()) n += s.size
  return n
}
