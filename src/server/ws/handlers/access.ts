/**
 * Access module registration (access-server): password/pairing/devices auth, Listener B (LAN HTTPS) and C (tailnet),
 * Tailscale lifecycle, the network status provider (07 B2–B4, B14–B16). No client→server WS messages: the module
 * talks to clients through `device.pending`, `devices.changed`, `network.changed` and `notify` broadcasts.
 */
import { createAccess } from '../../net'
import type { ServerContext } from '../../services'

export function register(ctx: ServerContext): void {
  const access = createAccess(ctx)
  ctx.onClose(() => access.close())
}
