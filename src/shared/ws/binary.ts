/**
 * Binary WebSocket frames: [kind u8][headerLen u32 BE][header JSON utf-8][payload bytes].
 *   kind 1 = TTS audio chunk (server → client), header = SpeechChunkHeader
 *   kind 2 = microphone PCM (client → server), header = {seq}, payload = Int16 LE mono 16 kHz
 */

export const BIN_KIND = { speechChunk: 1, micPcm: 2 } as const
export type BinKind = (typeof BIN_KIND)[keyof typeof BIN_KIND]

export type SpeechMime = 'audio/mpeg' | 'audio/wav' | `audio/L16;rate=${number}`

/** 07 C14: per-chunk speech document. */
export interface SpeechChunkHeader {
  sessionUid: string
  evSeq: number
  replyId: string
  index: number
  /** [start, end) offsets into the reply's final clean markdown body. */
  src: [number, number]
  /**
   * The markdown of `src` (chunks tile the body in order). In synced-reveal mode the speaking client gets no
   * reply.delta, so this is how its text arrives — held until its audio is ready (R14, 03 §4).
   */
  text: string
  /** What was actually spoken (markdown-free); empty for instant (unspoken) chunks. */
  spoken: string
  /** Per spoken char, relative to this chunk's audio start; null = no timing (estimate client-side). */
  timeline: { startsMs: number[]; endsMs: number[] } | null
  durationMs: number
  mime: SpeechMime
  /** Zero-duration chunk (code fence, table, math, image): reveal instantly when reached. */
  instant: boolean
  final: boolean
}

export interface MicPcmHeader {
  seq: number
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export function encodeBinary(kind: BinKind, header: unknown, payload: Uint8Array): Uint8Array {
  const h = enc.encode(JSON.stringify(header))
  const out = new Uint8Array(5 + h.length + payload.length)
  const view = new DataView(out.buffer)
  out[0] = kind
  view.setUint32(1, h.length, false)
  out.set(h, 5)
  out.set(payload, 5 + h.length)
  return out
}

export function decodeBinary(data: ArrayBuffer | Uint8Array): { kind: BinKind; header: unknown; payload: Uint8Array } {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (bytes.length < 5) throw new Error('binary frame too short')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const kind = bytes[0] as BinKind
  const hl = view.getUint32(1, false)
  if (5 + hl > bytes.length) throw new Error('binary frame header overflow')
  const header = JSON.parse(dec.decode(bytes.subarray(5, 5 + hl))) as unknown
  return { kind, header, payload: bytes.subarray(5 + hl) }
}
