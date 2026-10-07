/**
 * Two privacy switches that used to do nothing (phase 4b F21), both fed by the chat events the server sends:
 *
 *  - Reply notifications (07 B17, chat.notifyWhenHidden, default on): when a reply finishes and no desktop window is
 *    visible and focused (closed to the tray, minimised, behind other windows), the PC shows a notification. It never
 *    contains message text unless "Show message text in notifications" (chat.notificationPreviews, default off) is
 *    on — and never for a temporary chat (Windows keeps notifications in its notification centre). Game mode holds it
 *    like every other notification (notifyGate).
 *  - Diagnostic logging (07 B10, data.diagnosticLogging, desktop toggle): while on, message text (user turns and
 *    finished replies, never temporary chats) is added to the local log, still through the log's redaction. It turns
 *    itself off 24 hours after it was turned on — on a timer and at start (the time it was turned on is kept in kv).
 *
 * The events are observed by wrapping `ctx.hub.emit` (like notifyGate wraps platform.notify): no chat module needs to
 * know. `close()` puts the original back.
 */
import type { Message } from '@shared/types/domain'
import type { ServerMsg } from '@shared/ws'
import { isTemporarySession } from '../chat/temporary'
import type { Hub, ServerContext } from '../services'

/** Diagnostic logging turns itself off this long after it was turned on (07 B10). */
export const DIAGNOSTIC_TTL_MS = 24 * 60 * 60_000
export const DIAG_SINCE_KV = 'diag.enabledUtc'
const PREVIEW_CHARS = 180
const DIAG_TEXT_CHARS = 4000

/** Markdown → one plain line for a notification preview. */
export function previewText(body: string, max = PREVIEW_CHARS): string {
  const plain = body
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(\S[^\n]*?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain
}

type SessionMsg = Extract<ServerMsg, { sessionUid: string; evSeq: number }>

export class ReplyEvents {
  private readonly original: Hub['emit']
  private readonly wrapper: Hub['emit']
  private timer: NodeJS.Timeout | null = null
  private readonly unsubscribe: () => void
  private closed = false

  constructor(private readonly ctx: ServerContext) {
    const hub = ctx.hub
    this.original = hub.emit
    this.wrapper = (sessionUid, msg, opts) => {
      this.original.call(hub, sessionUid, msg, opts)
      try {
        this.observe(sessionUid, msg as SessionMsg)
      } catch (e) {
        ctx.log.warn('reply observer failed', { error: e })
      }
    }
    hub.emit = this.wrapper
    this.unsubscribe = ctx.settings.subscribe('data', () => this.diagnosticsChanged())
    this.diagnosticsChanged()
  }

  private observe(sessionUid: string, msg: SessionMsg): void {
    if (msg.t === 'reply.done') {
      this.diagnostic(sessionUid, msg.message)
      this.notifyReply(sessionUid, msg.message)
    } else if (msg.t === 'message.created' && msg.message.role === 'user') {
      this.diagnostic(sessionUid, msg.message)
    }
  }

  // ── Reply notifications ───────────────────────────────────────────────────────────────────────
  /** A desktop window is on screen and has focus: the owner sees the reply arrive. */
  private watched(): boolean {
    for (const c of this.ctx.hub.clients()) if (c.isDesktop && c.state.visible && c.state.focused) return true
    return false
  }

  private notifyReply(sessionUid: string, m: Message): void {
    const chat = this.ctx.settings.get().chat
    if (!this.ctx.platform.isDesktop || !chat.notifyWhenHidden) return
    if (m.status !== 'complete' || m.hidden || !m.body.trim()) return
    if (this.watched()) return
    const temporary = isTemporarySession(this.ctx, sessionUid)
    let title = 'Vesper'
    let body = 'A reply is ready.'
    if (chat.notificationPreviews && !temporary) {
      const s = this.ctx.repos.sessions.byUid(sessionUid)
      title = s?.title?.trim() ? s.title.trim() : 'Vesper'
      body = previewText(m.body) || body
    }
    this.ctx.platform.notify(title, body)
  }

  // ── Diagnostic logging ───────────────────────────────────────────────────────────────────────
  private get diagnosticsOn(): boolean {
    return this.ctx.settings.get().data.diagnosticLogging
  }

  private diagnostic(sessionUid: string, m: Message): void {
    if (!this.diagnosticsOn || isTemporarySession(this.ctx, sessionUid)) return
    this.ctx.log.child('diagnostic').info('message text', {
      session: sessionUid,
      message: m.uid,
      role: m.role,
      status: m.status,
      text: m.body.length > DIAG_TEXT_CHARS ? `${m.body.slice(0, DIAG_TEXT_CHARS)}…` : m.body
    })
  }

  /** The switch changed (or at start): keep its start time, schedule (or apply) the 24-hour auto-off. */
  private diagnosticsChanged(): void {
    if (this.closed) return
    const kv = this.ctx.repos.kv
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.diagnosticsOn) {
      if (kv.get(DIAG_SINCE_KV) !== null) kv.delete(DIAG_SINCE_KV)
      return
    }
    const now = this.ctx.clock.now()
    let since = kv.get<number>(DIAG_SINCE_KV)
    if (typeof since !== 'number' || since > now) {
      since = now
      kv.set(DIAG_SINCE_KV, since)
      this.ctx.log.info('diagnostic logging on: message text is added to the log for 24 hours')
    }
    const left = since + DIAGNOSTIC_TTL_MS - now
    if (left <= 0) {
      void this.turnDiagnosticsOff()
      return
    }
    this.timer = setTimeout(() => void this.turnDiagnosticsOff(), Math.min(left, 2 ** 31 - 1))
    this.timer.unref()
  }

  private async turnDiagnosticsOff(): Promise<void> {
    this.timer = null
    if (this.closed || !this.diagnosticsOn) return
    const since = this.ctx.repos.kv.get<number>(DIAG_SINCE_KV)
    // The timer may fire early (clock changes, huge delays are capped): re-check the deadline.
    if (typeof since === 'number' && since + DIAGNOSTIC_TTL_MS > this.ctx.clock.now()) return this.diagnosticsChanged()
    this.ctx.log.info('diagnostic logging turned itself off after 24 hours')
    await this.ctx.settings.patch({ data: { diagnosticLogging: false } }, { by: 'system' }).catch((e: unknown) => this.ctx.log.warn('could not turn diagnostic logging off', { error: e }))
  }

  /** Leak checks: the auto-off timer. */
  stats(): { diagnosticTimer: boolean } {
    return { diagnosticTimer: this.timer !== null }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.unsubscribe()
    if (this.ctx.hub.emit === this.wrapper) this.ctx.hub.emit = this.original
  }
}
