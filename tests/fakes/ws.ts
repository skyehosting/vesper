/** A `WsClient` that records what the server sends to it (JSON events and binary speech frames). */
import type { WsClient } from '../../src/server/services'
import { AUDIO_BACKPRESSURE_BYTES, type ClientState, type ServerMsg, type SpeechChunkHeader } from '../../src/shared/ws/index'
import type { DeviceKind, Listener } from '../../src/shared/types/domain'

export class FakeWsClient implements WsClient {
  readonly sent: ServerMsg[] = []
  readonly speech: Array<{ header: SpeechChunkHeader; audio: Uint8Array }> = []
  readonly subscriptions = new Set<string>()
  state: ClientState = { visible: true, focused: true, audioUnlocked: true }
  tz: string | null = 'UTC'
  tzOffset = 0
  /** Set above AUDIO_BACKPRESSURE_BYTES to simulate a slow socket. */
  bufferedAmount = 0
  closed: { code: number; reason: string } | null = null
  readonly device: WsClient['device']
  readonly listener: Listener
  readonly isDesktop: boolean

  constructor(
    readonly id = 'client-1',
    o: { deviceId?: string; kind?: DeviceKind; listener?: Listener; name?: string } = {}
  ) {
    this.listener = o.listener ?? 'loopback'
    this.device = { id: o.deviceId ?? 'device-1', kind: o.kind ?? 'desktop', name: o.name ?? 'Test device', listener: this.listener }
    this.isDesktop = this.device.kind === 'desktop'
  }

  send(msg: ServerMsg): void {
    if (!this.closed) this.sent.push(msg)
  }

  sendSpeech(header: SpeechChunkHeader, audio: Uint8Array): boolean {
    if (this.closed || this.bufferedAmount > AUDIO_BACKPRESSURE_BYTES) return false
    this.speech.push({ header, audio })
    return true
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason }
  }

  /** Messages of one type, typed. */
  of<T extends ServerMsg['t']>(t: T): Array<Extract<ServerMsg, { t: T }>> {
    return this.sent.filter((m): m is Extract<ServerMsg, { t: T }> => m.t === t)
  }
}
