/**
 * Fakes of the server service interfaces (src/server/services.ts, 07 E2) so each Phase 2 agent can test its engine
 * without the others: every call is recorded, results are configurable, nothing touches the network or disk.
 */
import type {
  ChatService,
  MemoryQuery,
  MemoryService,
  RecallQuery,
  ScopeCtx,
  SpeechService,
  SpeechSink,
  SpeechTarget,
  SttService,
  WsClient
} from '../../src/server/services'
import type { MemoryHit, MemoryStatus, ModelInfo, Voice } from '../../src/shared/types/domain'
import { STT_MODELS, type SttModelInfo } from '../../src/shared/models'

export interface Call {
  method: string
  args: unknown[]
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

// ── Memory ────────────────────────────────────────────────────────────────────────────────────
export class FakeMemoryService implements MemoryService {
  /** The searchable corpus: search/autoRecall return hits sharing a word with the query, best score first. */
  corpus: MemoryHit[] = []
  calls: Call[] = []
  persisted: bigint[] = []
  mode: 'hybrid' | 'keyword' = 'hybrid'
  /** Make `recall` refuse (e.g. "session #X is private"). */
  recallRefusal: string | null = null
  /** Simulated latency, e.g. to exceed the auto-recall budget. */
  delayMs = 0
  statusValue: MemoryStatus = { state: 'ready', model: 'voyage-4-lite', dim: 1024, indexed: 0, queued: 0, errors: 0, tier: 'unknown', queueEtaSec: null }

  /** Add a corpus entry with sensible defaults. */
  addHit(h: Partial<MemoryHit> & Pick<MemoryHit, 'body'>): MemoryHit {
    const hit: MemoryHit = {
      messageUid: h.messageUid ?? `m-${this.corpus.length + 1}`,
      sessionUid: h.sessionUid ?? 's-1',
      shortId: h.shortId ?? 'K7Q2MX',
      sessionTitle: h.sessionTitle ?? 'Earlier chat',
      tag: h.tag ?? 'user response',
      body: h.body,
      tsUtc: h.tsUtc ?? Date.UTC(2026, 8, 1, 12, 0),
      tzOffsetMin: h.tzOffsetMin ?? 0,
      tzName: h.tzName ?? 'UTC',
      score: h.score ?? 0.8
    }
    this.corpus.push(hit)
    return hit
  }

  private async wait(): Promise<void> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
  }

  private match(query: string, limit = 8): MemoryHit[] {
    const q = new Set(words(query))
    return this.corpus
      .filter((h) => words(h.body).some((w) => q.has(w)))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  async search(q: MemoryQuery, scope: ScopeCtx, budgetMs: number): Promise<{ hits: MemoryHit[]; mode: 'hybrid' | 'keyword' }> {
    this.calls.push({ method: 'search', args: [q, scope, budgetMs] })
    await this.wait()
    return { hits: this.match(q.query, q.limit), mode: this.mode }
  }

  async recall(r: RecallQuery, scope: ScopeCtx): Promise<{ hits: MemoryHit[]; refused?: string }> {
    this.calls.push({ method: 'recall', args: [r, scope] })
    await this.wait()
    if (this.recallRefusal) return { hits: [], refused: this.recallRefusal }
    let hits = this.corpus.filter((h) => h.shortId === r.shortId.replace(/^#/, ''))
    if (r.query) {
      const q = new Set(words(r.query))
      hits = hits.filter((h) => words(h.body).some((w) => q.has(w)))
    }
    if (r.last) hits = hits.slice(-r.last)
    return { hits }
  }

  async sessions(query: string | undefined, scope: ScopeCtx): Promise<{ text: string }> {
    this.calls.push({ method: 'sessions', args: [query, scope] })
    const ids = [...new Set(this.corpus.map((h) => `#${h.shortId} · ${h.sessionTitle}`))]
    return { text: ids.join('\n') || '(no sessions)' }
  }

  async autoRecall(text: string, scope: ScopeCtx, budgetMs: number): Promise<MemoryHit[]> {
    this.calls.push({ method: 'autoRecall', args: [text, scope, budgetMs] })
    await this.wait()
    return this.match(text, 3)
  }

  /** Deterministic stand-in for the real `untrusted()` rendering (07 B7). */
  formatResult(hits: MemoryHit[], o: { query: string; nowUtc: number; tzName: string | null; tzOffsetMin: number }): string {
    this.calls.push({ method: 'formatResult', args: [hits, o] })
    const lines = hits.map((h) => `#${h.shortId} · ${h.tag} · ${Math.round((o.nowUtc - h.tsUtc) / 86_400_000)} days ago · ${h.body}`)
    return `<memory_result id="r_fake">\n${lines.join('\n') || '(nothing found)'}\n</memory_result id="r_fake">`
  }

  onMessagePersisted(messageId: bigint): void {
    this.calls.push({ method: 'onMessagePersisted', args: [messageId] })
    this.persisted.push(messageId)
  }

  onSessionFlagsChanged(sessionId: bigint): void {
    this.calls.push({ method: 'onSessionFlagsChanged', args: [sessionId] })
  }

  onPathChanged(sessionId: bigint): void {
    this.calls.push({ method: 'onPathChanged', args: [sessionId] })
  }

  onMessagesDeleted(ids: bigint[]): void {
    this.calls.push({ method: 'onMessagesDeleted', args: [ids] })
  }

  status(): MemoryStatus {
    return { ...this.statusValue }
  }

  async reindex(scope: 'all' | 'missing'): Promise<{ queued: number }> {
    this.calls.push({ method: 'reindex', args: [scope] })
    return { queued: this.corpus.length }
  }

  async close(): Promise<void> {
    this.calls.push({ method: 'close', args: [] })
  }

  callsOf(method: string): Call[] {
    return this.calls.filter((c) => c.method === method)
  }
}

// ── Speech out ────────────────────────────────────────────────────────────────────────────────
export type SinkCall =
  | { op: 'push'; text: string }
  | { op: 'tone'; value: string; at: number }
  | { op: 'end'; finalBody: string }
  | { op: 'abort'; reason: 'barge-in' | 'stopped' | 'error' }

export interface SinkResult {
  chunks: number
  spokenChars: number
  interrupted: boolean
  failed: boolean
}

export class FakeSpeechSink implements SpeechSink {
  readonly calls: SinkCall[] = []
  /** Calls made after end/abort (a bug in the caller); recorded instead of thrown. */
  readonly lateCalls: SinkCall[] = []
  state: 'open' | 'ended' | 'aborted' = 'open'
  readonly done: Promise<SinkResult>
  private resolve!: (r: SinkResult) => void

  constructor(readonly target: SpeechTarget) {
    this.done = new Promise((r) => (this.resolve = r))
  }

  /** Concatenation of every pushed text. */
  get text(): string {
    return this.calls.map((c) => (c.op === 'push' ? c.text : '')).join('')
  }

  get tones(): Array<{ value: string; at: number }> {
    return this.calls.flatMap((c) => (c.op === 'tone' ? [{ value: c.value, at: c.at }] : []))
  }

  private record(c: SinkCall): boolean {
    if (this.state !== 'open') {
      this.lateCalls.push(c)
      return false
    }
    this.calls.push(c)
    return true
  }

  push(text: string): void {
    this.record({ op: 'push', text })
  }

  tone(value: string, at: number): void {
    this.record({ op: 'tone', value, at })
  }

  end(finalBody: string): void {
    if (!this.record({ op: 'end', finalBody })) return
    this.state = 'ended'
    this.resolve({ chunks: this.calls.filter((c) => c.op === 'push').length, spokenChars: finalBody.length, interrupted: false, failed: false })
  }

  abort(reason: 'barge-in' | 'stopped' | 'error'): void {
    if (!this.record({ op: 'abort', reason })) return
    this.state = 'aborted'
    this.resolve({ chunks: this.calls.filter((c) => c.op === 'push').length, spokenChars: this.text.length, interrupted: reason === 'barge-in', failed: reason === 'error' })
  }
}

export class FakeSpeechService implements SpeechService {
  readonly opened: Array<{ target: SpeechTarget; opts: Parameters<SpeechService['open']>[1]; sink: FakeSpeechSink }> = []
  readonly cancelled: Array<{ replyId: string; spokenChars?: number }> = []
  readonly replays: Array<{ messageUid: string; clientId: string }> = []
  voicesResult: { voices: Voice[]; models: ModelInfo[]; quota?: { used: number; limit: number } } = {
    voices: [{ id: 'fake-voice', name: 'Fake voice', provider: 'fake', previewable: false }],
    models: [{ id: 'fake-model' }]
  }

  open(target: SpeechTarget, opts: Parameters<SpeechService['open']>[1]): FakeSpeechSink {
    const sink = new FakeSpeechSink(target)
    this.opened.push({ target, opts, sink })
    return sink
  }

  lastSink(): FakeSpeechSink | undefined {
    return this.opened[this.opened.length - 1]?.sink
  }

  sinkFor(replyId: string): FakeSpeechSink | undefined {
    return this.opened.find((o) => o.target.replyId === replyId)?.sink
  }

  async replay(messageUid: string, client: WsClient): Promise<void> {
    this.replays.push({ messageUid, clientId: client.id })
  }

  /** Barge-in: aborts the reply's sink like the real service would. */
  cancel(replyId: string, spokenChars?: number): void {
    this.cancelled.push({ replyId, spokenChars })
    const sink = this.sinkFor(replyId)
    if (sink?.state === 'open') sink.abort('barge-in')
  }

  async voices(provider: string, refresh?: boolean): Promise<{ voices: Voice[]; models: ModelInfo[]; quota?: { used: number; limit: number } }> {
    void provider
    void refresh
    return this.voicesResult
  }

  async close(): Promise<void> {
    for (const o of this.opened) if (o.sink.state === 'open') o.sink.abort('stopped')
  }
}

// ── Speech in ─────────────────────────────────────────────────────────────────────────────────
export class FakeSttService implements SttService {
  readonly installed = new Set<string>()
  readonly calls: Call[] = []
  active: string | null = null
  /** Make the next download reject with this message. */
  failDownload: string | null = null

  async models(): Promise<SttModelInfo[]> {
    this.calls.push({ method: 'models', args: [] })
    return STT_MODELS.map((m) => ({
      id: m.id,
      label: m.label,
      description: m.description,
      languages: m.languages,
      downloadBytes: m.files.reduce((s, f) => s + f.size, 0),
      ramMB: m.ramMB,
      license: m.license,
      attribution: m.attribution,
      state: this.installed.has(m.id) ? 'installed' : 'not-installed',
      recommended: m.recommended,
      active: this.active === m.id
    }))
  }

  async download(id: string): Promise<void> {
    this.calls.push({ method: 'download', args: [id] })
    if (this.failDownload) {
      const msg = this.failDownload
      this.failDownload = null
      throw new Error(msg)
    }
    this.installed.add(id)
  }

  async remove(id: string): Promise<void> {
    this.calls.push({ method: 'remove', args: [id] })
    this.installed.delete(id)
    if (this.active === id) this.active = null
  }

  async unload(): Promise<void> {
    this.calls.push({ method: 'unload', args: [] })
    this.active = null
  }

  async close(): Promise<void> {
    this.calls.push({ method: 'close', args: [] })
  }
}

// ── Chat ──────────────────────────────────────────────────────────────────────────────────────
export class FakeChatService implements ChatService {
  readonly calls: Call[] = []
  readonly busySessions = new Set<string>()
  recapText = 'Earlier you talked about testing Vesper.'
  private epoch = 0

  stop(sessionUid: string): void {
    this.calls.push({ method: 'stop', args: [sessionUid] })
    this.busySessions.delete(sessionUid)
  }

  busy(sessionUid: string): boolean {
    return this.busySessions.has(sessionUid)
  }

  async startContinuation(sessionUid: string, sourceUid: string, client: WsClient | null): Promise<void> {
    this.calls.push({ method: 'startContinuation', args: [sessionUid, sourceUid, client?.id ?? null] })
  }

  async recap(sessionUid: string): Promise<string> {
    this.calls.push({ method: 'recap', args: [sessionUid] })
    return this.recapText
  }

  async newEpoch(sessionUid: string, reason: 'apply-protocols' | 'refresh-context' | 'model-switch' | 'overflow'): Promise<number> {
    this.calls.push({ method: 'newEpoch', args: [sessionUid, reason] })
    return ++this.epoch
  }

  async close(): Promise<void> {
    this.calls.push({ method: 'close', args: [] })
  }
}
