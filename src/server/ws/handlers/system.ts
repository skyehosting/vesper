/**
 * System module registration (platform-int, 07 D2/D3/D6): game mode, resource use and voice-model unloading, the
 * open-folder set and the global push-to-talk hotkey relay (src/server/system). No client→server WS messages; the
 * module talks to clients through `gamemode.changed` and `hotkey.ptt`.
 */
import type { ServerContext } from '../../services'
import { createSystem } from '../../system'

export function register(ctx: ServerContext): void {
  createSystem(ctx)
}
