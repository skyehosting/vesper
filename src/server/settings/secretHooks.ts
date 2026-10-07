/**
 * Per-server hooks around PUT/DELETE /api/secrets/:name (07 C22). Owners register from their own module, so no two
 * agents edit the secrets route: voice-out-server validates TTS keys and broadcasts voices, memory validates the
 * Voyage key, llm-engine may refresh model lists.
 *   validate — runs BEFORE the key is stored; throw a VesperError to refuse it (the key is not saved).
 *   saved / deleted — run AFTER; failures are logged, never undo the save.
 */
import type { ServerContext } from '../services'

export interface SecretHook {
  /** Which secret names this hook handles, e.g. (n) => n.startsWith('tts:'). */
  match(name: string): boolean
  validate?(name: string, value: string, url: string, ctx: ServerContext): Promise<void>
  saved?(name: string, ctx: ServerContext): void | Promise<void>
  deleted?(name: string, ctx: ServerContext): void | Promise<void>
}

const registry = new WeakMap<ServerContext, SecretHook[]>()

export function onSecret(ctx: ServerContext, hook: SecretHook): () => void {
  const list = registry.get(ctx) ?? []
  list.push(hook)
  registry.set(ctx, list)
  return () => {
    const i = list.indexOf(hook)
    if (i >= 0) list.splice(i, 1)
  }
}

export function secretHooks(ctx: ServerContext, name: string): SecretHook[] {
  return (registry.get(ctx) ?? []).filter((h) => h.match(name))
}
