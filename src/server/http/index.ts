/**
 * Route module registry (07 E1): a FIXED list, one module per owner. Agents replace the bodies of their modules;
 * nobody edits this list (requests go to docs/requests/<agent>.md). Each module runs in its own encapsulated Fastify
 * scope, so it may add its own plugins (multipart, rate limits) without affecting the others.
 */
import type { FastifyInstance } from 'fastify'
import type { ServerContext } from '../services'
import type { RouteModule } from './route'
import * as attachments from './attachments'
import * as auth from './auth'
import * as bootstrap from './bootstrap'
import * as data from './data'
import * as facts from './facts'
import * as memory from './memory'
import * as messages from './messages'
import * as models from './models'
import * as network from './network'
import * as prompts from './prompts'
import * as protocols from './protocols'
import * as providersLlm from './providers.llm'
import * as providersStt from './providers.stt'
import * as providersTts from './providers.tts'
import * as providersVoyage from './providers.voyage'
import * as search from './search'
import * as secrets from './secrets'
import * as sessions from './sessions'
import * as settings from './settings'
import * as stt from './stt'
import * as system from './system'
import * as test from './test'
import * as tts from './tts'
import * as variants from './variants'

export const ROUTE_MODULES: readonly { name: string; module: RouteModule }[] = [
  { name: 'auth', module: auth },
  { name: 'bootstrap', module: bootstrap },
  { name: 'settings', module: settings },
  { name: 'secrets', module: secrets },
  { name: 'protocols', module: protocols },
  { name: 'sessions', module: sessions },
  { name: 'messages', module: messages },
  { name: 'variants', module: variants },
  { name: 'search', module: search },
  { name: 'memory', module: memory },
  { name: 'facts', module: facts },
  { name: 'prompts', module: prompts },
  { name: 'attachments', module: attachments },
  { name: 'providers.llm', module: providersLlm },
  { name: 'providers.voyage', module: providersVoyage },
  { name: 'providers.tts', module: providersTts },
  { name: 'providers.stt', module: providersStt },
  { name: 'tts', module: tts },
  { name: 'stt', module: stt },
  { name: 'models', module: models },
  { name: 'network', module: network },
  { name: 'data', module: data },
  { name: 'system', module: system },
  { name: 'test', module: test }
]

export async function registerRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  for (const m of ROUTE_MODULES) await app.register(async (scope) => m.module.register(scope, ctx))
}
