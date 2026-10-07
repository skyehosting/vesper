/** voice-out-server entry points (07 E1): the service, its per-context registry, and the pieces tests use. */
import type { ServerContext } from '../services'
import type { SpeechServiceImpl } from './service'

export { createSpeechService, providerOfSecret, type SpeechServiceImpl, type SpeechServiceOptions } from './service'
export { SpeechDocument, CHUNK_RULES, type PlannedChunk } from './segmenter'
export { SpeechJob, type SinkResult } from './job'

const services = new WeakMap<ServerContext, SpeechServiceImpl>()

/** The concrete service behind ctx.services.speech (HTTP routes need its setup endpoints). */
export function speechOf(ctx: ServerContext): SpeechServiceImpl | null {
  return services.get(ctx) ?? null
}

export function bindSpeech(ctx: ServerContext, s: SpeechServiceImpl): void {
  services.set(ctx, s)
}
