/**
 * The updater as the server shows it (H-v12-updates). The Electron main process attaches its updater to the Platform
 * (`platform.updater`, src/main/updater.ts); without one (the standalone server, dev and test runs) the state is
 * 'unsupported'. Every change is broadcast as `update.state` (any device may watch; only the desktop app controls it).
 * `updateActivity()` is what the 'auto' mode asks before restarting by itself.
 */
import type { UpdateStatus } from '@shared/api'
import type { UpdateActivity } from '@shared/updater.logic'
import { sttImpl } from '../providers/stt'
import type { ServerContext } from '../services'

export function updateStatus(ctx: ServerContext): UpdateStatus {
  return ctx.platform.updater?.status() ?? { state: 'unsupported', currentVersion: ctx.platform.version }
}

/** Relays the attached updater's changes to every client; `attach()` again after a (test) updater is swapped in. */
export class UpdateRelay {
  private off: (() => void) | null = null

  constructor(private readonly ctx: ServerContext) {
    this.attach()
  }

  attach(): void {
    this.off?.()
    this.off = null
    const u = this.ctx.platform.updater
    if (!u) return
    this.off = u.onChange((s) => this.ctx.hub.broadcast({ t: 'update.state', ...s }))
  }

  close(): void {
    this.off?.()
    this.off = null
  }
}

/** Is anything going on that an unattended restart would interrupt? (07 D3 game mode comes from the system module.) */
export function updateActivity(ctx: ServerContext, gameActive: boolean): UpdateActivity {
  const engine = ctx.services.chat as { stats?: () => { active: number; starting: number } } | undefined
  let streaming = false
  try {
    const st = engine?.stats?.()
    streaming = !!st && st.active + st.starting > 0
  } catch {
    streaming = true
  }
  let mic = false
  try {
    mic = (sttImpl(ctx)?.streamingDevices().length ?? 0) > 0
  } catch {
    mic = true
  }
  let attended = false
  for (const c of ctx.hub.clients()) if (c.state.visible && c.state.focused) attended = true
  return { streaming, mic, game: gameActive, attended }
}
