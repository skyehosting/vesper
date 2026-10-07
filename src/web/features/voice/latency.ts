/**
 * Voice latency marks (07 D6), test builds only: the server's `reply.timing {marks}` (ms since the turn was received)
 * next to what this client saw (ack → first chunk → first audio), kept for the last few replies and shown by
 * LatencyOverlay. Toggle: `__vesperTest.voice.latency(true)` or Ctrl+Alt+L.
 */
import { BIN_KIND } from '@shared/ws'
import { getAudioEngine } from '../../lib/audio'
import { ws } from '../../lib/ws'

export interface LatencyRow {
  replyId: string
  /** Server marks (ms from receiving the turn). */
  server: Record<string, number>
  /** Client marks (ms from the ack of the request). */
  client: Record<string, number>
}

const MAX_ROWS = 6
const rows: LatencyRow[] = []
const ackAt = new Map<string, number>()
const listeners = new Set<() => void>()
let offs: Array<() => void> = []

function row(replyId: string): LatencyRow {
  let r = rows.find((x) => x.replyId === replyId)
  if (!r) {
    r = { replyId, server: {}, client: {} }
    rows.unshift(r)
    if (rows.length > MAX_ROWS) {
      const gone = rows.pop()
      if (gone) ackAt.delete(gone.replyId)
    }
  }
  return r
}

function mark(replyId: string, k: string): void {
  const t0 = ackAt.get(replyId)
  if (t0 === undefined) return
  const r = row(replyId)
  r.client[k] ??= Math.round(performance.now() - t0)
  emit()
}

let version = 0

function emit(): void {
  version++
  for (const l of [...listeners]) l()
}

export function latencyVersion(): number {
  return version
}

export function installLatencyMarks(): () => void {
  if (!__VESPER_TEST__ || offs.length) return () => undefined
  offs = [
    ws.on('ack', (m) => {
      if (!m.replyId) return
      ackAt.set(m.replyId, performance.now())
      row(m.replyId)
      emit()
    }),
    ws.onBinary(BIN_KIND.speechChunk, (h) => {
      const id = (h as { replyId?: unknown }).replyId
      if (typeof id === 'string') mark(id, 'firstChunk')
    }),
    ws.on('reply.status', (m) => mark(m.replyId, m.state)),
    ws.on('reply.done', (m) => mark(m.replyId, 'done')),
    ws.on('reply.timing', (m) => {
      const r = row(m.replyId)
      // The speech job's marks (speechOpen, firstAudioSent) and the engine's share one origin: merge them.
      r.server = { ...r.server, ...m.marks }
      emit()
    }),
    getAudioEngine().on('chunkStart', (e) => mark(e.replyId, e.index === 0 ? 'firstAudio' : `audio${e.index}`))
  ]
  return () => {
    for (const off of offs) off()
    offs = []
  }
}

export function latencyRows(): LatencyRow[] {
  return rows.map((r) => ({ replyId: r.replyId, server: { ...r.server }, client: { ...r.client } }))
}

export function subscribeLatency(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
