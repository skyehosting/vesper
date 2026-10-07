/**
 * Talk-mode recall prefetch (07 D6: "start the Voyage query embedding on the first ≥ 4-word stt.partial"). While the
 * user is still speaking, the memory query embedding for what they said so far starts in db.worker; the final
 * transcript is prefetched too, so the auto-recall of the turn it becomes (the same text) finds its embedding ready
 * and stays inside Talk mode's 300 ms cap.
 *
 * Only for voice-first mics (conversation / push-to-talk — dictation fills the composer and is often edited), only
 * for stored sessions with memory and auto-recall on, and only where memory says the search would reach Voyage (it
 * skips the free tier). Partials are throttled per client (one per PARTIAL_EVERY_MS, at most MAX_PER_UTTERANCE).
 */
import { memoryOf } from '../memory/service'
import { sttImpl } from '../providers/stt'
import type { ServerContext } from '../services'
import { memoryOn } from './context'
import { storeOf } from './temporary'

const MIN_WORDS = 4
const PARTIAL_EVERY_MS = 1_000
const MAX_PER_UTTERANCE = 4

interface ClientState {
  lastAt: number
  count: number
  lastText: string
}

export interface PrefetchWiring {
  /** Clients with prefetch state (leak checks). */
  readonly size: number
  close(): void
}

export function wireRecallPrefetch(ctx: ServerContext): PrefetchWiring {
  const state = new Map<string, ClientState>()
  const stt = sttImpl(ctx)
  ctx.hub.onDisconnect((c) => state.delete(c.id))
  const off = stt
    ? stt.onTranscript((e) => {
        if (!e.sessionUid || e.mode === 'dictate') return
        const text = e.text.trim()
        const words = text.split(/\s+/).filter(Boolean).length
        const now = Date.now()
        let st = state.get(e.clientId)
        if (!st) {
          st = { lastAt: 0, count: 0, lastText: '' }
          state.set(e.clientId, st)
        }
        if (e.kind === 'partial') {
          if (words < MIN_WORDS || st.count >= MAX_PER_UTTERANCE || now - st.lastAt < PARTIAL_EVERY_MS) return
        } else if (words < 3) {
          // The engine auto-recalls only for ≥ 3 words; a shorter final needs no embedding.
          state.delete(e.clientId)
          return
        }
        if (text === st.lastText) {
          if (e.kind === 'final') state.delete(e.clientId)
          return
        }
        st.lastAt = now
        st.count++
        st.lastText = text
        // A new utterance starts counting again after its final.
        if (e.kind === 'final') state.delete(e.clientId)
        void prefetch(ctx, e.sessionUid, text)
      })
    : () => undefined
  return {
    get size() {
      return state.size
    },
    close() {
      off()
      state.clear()
    }
  }
}

async function prefetch(ctx: ServerContext, sessionUid: string, text: string): Promise<void> {
  const st = storeOf(ctx, sessionUid)
  // A temporary chat never reaches Voyage (07 B9).
  if (st.temporary) return
  const s = st.repos.sessions.byUid(sessionUid)
  const settings = ctx.settings.get()
  if (!s || s.deletedUtc !== null || !settings.memory.autoRecall || !memoryOn(settings, s)) return
  try {
    await memoryOf(ctx).prefetchQuery(text, { sessionUid })
  } catch {
    /* memory unavailable: the turn's auto-recall simply embeds on its own */
  }
}
