/**
 * PATCH /api/settings rules (07 B1/B2):
 * - non-desktop devices may change only REMOTE_WRITABLE_PREFIXES, and only while access.remoteMayChangeSettings is on;
 * - base URLs must pass baseUrlProblem (https unless loopback; no userinfo/query); Voyage only on its known hosts
 *   unless the desktop ticked "custom endpoint";
 * - a provider key whose base URL moved to another origin is cleared in the same request (secrets.rebind), and the key
 *   of a removed LLM profile is deleted.
 */
import { VesperError } from '@shared/errors'
import { baseUrlProblem, REMOTE_WRITABLE_PREFIXES, type Settings } from '@shared/settings'
import type { SecretsService } from '../services'

export const VOYAGE_HOSTS = ['api.voyageai.com', 'ai.mongodb.com', 'eu.ai.mongodb.com', 'us.ai.mongodb.com'] as const

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Dotted leaf paths of a patch body; arrays are leaves (they replace as a whole). */
export function leafPaths(v: unknown, prefix = ''): string[] {
  if (!isObj(v)) return prefix ? [prefix] : []
  const out: string[] = []
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined) continue
    const p = prefix ? `${prefix}.${k}` : k
    if (isObj(x) && Object.keys(x).length) out.push(...leafPaths(x, p))
    else out.push(p)
  }
  return out
}

const remoteWritable = (p: string) => REMOTE_WRITABLE_PREFIXES.some((pre) => p === pre || p.startsWith(`${pre}.`))

export function assertPatchAllowed(patch: unknown, o: { isDesktop: boolean; settings: Settings }): void {
  if (o.isDesktop) return
  const paths = leafPaths(patch)
  if (!o.settings.access.remoteMayChangeSettings) {
    if (paths.length) throw new VesperError('desktop_only', { message: 'Settings can only be changed in the Vesper app on your PC.' })
    return
  }
  const denied = paths.filter((p) => !remoteWritable(p))
  if (denied.length) {
    const fields: Record<string, string> = {}
    for (const p of denied) fields[p] = 'desktop only'
    throw new VesperError('desktop_only', { fields })
  }
}

/** Validate the base URLs the patch touches (stored legacy values never block unrelated changes). */
export function assertUrls(patch: unknown, next: Settings): void {
  const fields: Record<string, string> = {}
  const p = isObj(patch) ? patch : {}
  const llm = isObj(p.llm) ? p.llm : null
  if (llm && Array.isArray(llm.profiles)) {
    next.llm.profiles.forEach((prof, i) => {
      const problem = prof.baseUrl ? baseUrlProblem(prof.baseUrl) : null
      if (problem) fields[`llm.profiles.${i}.baseUrl`] = problem
    })
  }
  const mem = isObj(p.memory) ? p.memory : null
  if (mem && isObj(mem.voyage) && (mem.voyage.baseUrl !== undefined || mem.voyage.customEndpoint !== undefined)) {
    const url = next.memory.voyage.baseUrl
    const problem = baseUrlProblem(url)
    if (problem) fields['memory.voyage.baseUrl'] = problem
    else if (!next.memory.voyage.customEndpoint && !(VOYAGE_HOSTS as readonly string[]).includes(new URL(url).hostname)) {
      fields['memory.voyage.baseUrl'] = `Use a Voyage AI address (${VOYAGE_HOSTS.join(', ')}) or turn on "custom endpoint"`
    }
  }
  const voice = isObj(p.voice) ? p.voice : null
  if (voice && isObj(voice.tts) && typeof voice.tts.baseUrl === 'string' && voice.tts.baseUrl) {
    const problem = baseUrlProblem(voice.tts.baseUrl)
    if (problem) fields['voice.tts.baseUrl'] = problem
  }
  if (Object.keys(fields).length) throw new VesperError('validation', { fields })
}

/** Clear keys whose destination moved (07 B1). Returns the names that were cleared. */
export async function rebindKeys(prev: Settings, next: Settings, secrets: SecretsService): Promise<string[]> {
  const cleared: string[] = []
  const known = new Set([...(await secrets.list()), ...(await secrets.invalid())])
  const drop = async (name: string) => {
    if (!known.has(name)) return
    await secrets.delete(name)
    cleared.push(name)
  }
  const rebind = async (name: string, url: string) => {
    if (!url) return drop(name)
    if ((await secrets.rebind(name, url)) === 'cleared') cleared.push(name)
  }
  const prevProfiles = new Map(prev.llm.profiles.map((p) => [p.id, p]))
  const nextIds = new Set(next.llm.profiles.map((p) => p.id))
  for (const prof of next.llm.profiles) {
    const old = prevProfiles.get(prof.id)
    if (!old || old.baseUrl === prof.baseUrl) continue
    await rebind(`llm:${prof.id}`, prof.baseUrl)
    await rebind(`llm-header:${prof.id}`, prof.baseUrl)
  }
  for (const id of prevProfiles.keys()) {
    if (nextIds.has(id)) continue
    await drop(`llm:${id}`)
    await drop(`llm-header:${id}`)
  }
  if (prev.memory.voyage.baseUrl !== next.memory.voyage.baseUrl) await rebind('voyage', next.memory.voyage.baseUrl)
  if (prev.voice.tts.baseUrl !== next.voice.tts.baseUrl) await rebind('tts:openai-compatible', next.voice.tts.baseUrl)
  return cleared
}
