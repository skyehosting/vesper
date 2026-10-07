/**
 * WebSocket handler registry (07 E1): a FIXED list of modules, each registering its `hub.on(prefix, …)` /
 * `hub.onBinary(kind, …)` handlers and its service. Owners edit their module, never this list.
 */
import type { ServerContext } from '../../services'
import * as access from './access'
import * as chat from './chat'
import * as content from './content'
import * as memory from './memory'
import * as session from './session'
import * as speech from './speech'
import * as stt from './stt'
import * as system from './system'

export const WS_HANDLER_MODULES: readonly { name: string; register(ctx: ServerContext): void }[] = [
  // Services first (chat reads ctx.services.memory/speech lazily, at call time, so order is not load-bearing).
  { name: 'memory', register: memory.register },
  { name: 'content', register: content.register },
  { name: 'access', register: access.register },
  { name: 'chat', register: chat.register },
  { name: 'speech', register: speech.register },
  { name: 'stt', register: stt.register },
  { name: 'session', register: session.register },
  { name: 'system', register: system.register }
]

export function registerWsHandlers(ctx: ServerContext): void {
  for (const m of WS_HANDLER_MODULES) m.register(ctx)
}
