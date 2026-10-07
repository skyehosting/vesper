/**
 * Foundation internals that route modules may need beyond the frozen `ServerContext` (auth core, listener registry,
 * network status provider, test clock). Reached through `coreOf(ctx)` so the E1 module signature stays
 * `register(app, ctx: ServerContext)`.
 */
import type { monitorEventLoopDelay } from 'node:perf_hooks'
import type { NetworkStatus } from '@shared/types/domain'
import type { AuthCore } from './auth/core'
import type { ReposImpl } from './db/repos/index'
import type { ListenerRegistry } from './http/listeners'
import type { FileLog } from './log'
import type { ServerContext, StartOptions } from './services'
import type { SecretsServiceImpl } from './settings/secrets'
import type { SettingsStoreImpl } from './settings/store'
import type { HubImpl } from './ws/hub'

export interface ServerCore {
  ctx: ServerContext
  repos: ReposImpl
  settings: SettingsStoreImpl
  secrets: SecretsServiceImpl
  hub: HubImpl
  log: FileLog
  auth: AuthCore
  listeners: ListenerRegistry
  opts: StartOptions
  version: string
  testMode: boolean
  /** Added to platform.now() (POST /api/test/clock). */
  clockOffsetMs: number
  /** Event-loop delay histogram (test stats), test mode only. */
  eventLoopDelay: ReturnType<typeof monitorEventLoopDelay> | null
  /** Loopback URL of Listener A (after binding). */
  loopbackUrl(): string
  /** Network status for bootstrap / GET /api/network; access-server replaces the provider. */
  networkStatus(): NetworkStatus
  setNetworkStatusProvider(fn: () => NetworkStatus): void
}

const cores = new WeakMap<ServerContext, ServerCore>()

export function bindCore(core: ServerCore): void {
  cores.set(core.ctx, core)
}

export function coreOf(ctx: ServerContext): ServerCore {
  const c = cores.get(ctx)
  if (!c) throw new Error('ServerContext was not created by startServer')
  return c
}
