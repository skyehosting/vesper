/**
 * MemoryService (07 C10–C13): sets ctx.services.memory and the ProviderTester 'voyage'. Memory has no client → server
 * WS messages; it broadcasts `memory.progress {status}` whenever the status changes (≤ 2 per second).
 */
import { createMemoryService } from '../../memory'
import type { ServerContext } from '../../services'

export function register(ctx: ServerContext): void {
  ctx.services.memory = createMemoryService(ctx)
}
