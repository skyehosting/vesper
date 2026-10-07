import { describe, expect, it } from 'vitest'
import type { Message, MessagePage } from '@shared/types/domain'
import type { ServerMsg } from '@shared/ws'
import { appendPage, applyChatEvent, applyPage, chatRows, emptyChat, lastMessageOf, prependPage, startReload, trimWindow, upsertMessage, type ChatView } from '../../../src/web/lib/store/chat.logic'

const S = 'sess'

function msg(seq: number, role: Message['role'] = 'user', extra: Partial<Message> = {}): Message {
  return {
    uid: `m${seq}`,
    sessionUid: S,
    seq,
    role,
    tag: role === 'user' ? 'user response' : 'ai response',
    body: `body ${seq}`,
    tsUtc: 1_700_000_000_000 + seq,
    tzOffsetMin: 0,
    tzName: null,
    device: null,
    status: 'complete',
    attachments: [],
    ...extra
  }
}

function page(items: Message[], lastSeq = items.length ? items[items.length - 1].seq : 0): MessagePage {
  return { items, loSeq: items[0]?.seq ?? 0, hiSeq: items[items.length - 1]?.seq ?? 0, lastSeq, hasBefore: false, hasAfter: false }
}

function apply(view: ChatView, ...events: ServerMsg[]): ChatView {
  return events.reduce(applyChatEvent, view)
}

describe('upsertMessage', () => {
  it('appends, inserts in seq order, replaces by uid and by seq', () => {
    let list = upsertMessage([], msg(1))
    list = upsertMessage(list, msg(3))
    list = upsertMessage(list, msg(2))
    expect(list.map((m) => m.seq)).toEqual([1, 2, 3])
    list = upsertMessage(list, msg(2, 'user', { body: 'edited' }))
    expect(list.map((m) => m.body)).toEqual(['body 1', 'edited', 'body 3'])
    list = upsertMessage(list, msg(3, 'assistant', { uid: 'variant' }))
    expect(list.map((m) => m.uid)).toEqual(['m1', 'm2', 'variant'])
  })

  it('keeps hidden messages in the window (rows skip them)', () => {
    const v = applyPage(emptyChat(), page([msg(1, 'user', { hidden: true }), msg(2, 'assistant')]))
    expect(v.messages.map((m) => m.seq)).toEqual([1, 2])
    expect(chatRows(v).map((r) => r.key)).toEqual(['m2'])
  })
})

describe('chat reducer', () => {
  it('loads a page without hidden turns', () => {
    const v = applyPage(emptyChat(), page([msg(1, 'user', { hidden: true }), msg(2, 'assistant')]))
    expect(v.status).toBe('ready')
    expect(chatRows(v).map((r) => r.message?.seq)).toEqual([2])
    expect(v.lastSeq).toBe(2)
  })

  it('keeps live messages that arrived while the page was loading', () => {
    let v = emptyChat()
    v = apply(v, { t: 'message.created', sessionUid: S, evSeq: 1, message: msg(5), lastSeq: 5 })
    v = applyPage(v, page([msg(3), msg(4)], 4))
    expect(v.messages.map((m) => m.seq)).toEqual([3, 4, 5])
    expect(v.lastSeq).toBe(5)
    expect(v.pending).toEqual([])
  })

  it('does not resurrect old-path messages on a reload', () => {
    let v = applyPage(emptyChat(), page([msg(1), msg(2), msg(3)]))
    v = startReload(v)
    expect(v.messages).toHaveLength(3)
    v = applyPage(v, page([msg(1), msg(2, 'user', { uid: 'edit' })], 2))
    expect(v.messages.map((m) => m.uid)).toEqual(['m1', 'edit'])
  })

  it('streams a reply: status → deltas → done', () => {
    let v = applyPage(emptyChat(), page([msg(1)]))
    v = apply(
      v,
      { t: 'message.created', sessionUid: S, evSeq: 1, message: msg(2, 'assistant', { body: '', status: 'streaming' }), lastSeq: 2 },
      { t: 'reply.status', sessionUid: S, evSeq: 2, replyId: 'r1', messageUid: 'm2', state: 'thinking' },
      { t: 'reply.delta', sessionUid: S, evSeq: 3, replyId: 'r1', text: 'Hel' },
      { t: 'reply.delta', sessionUid: S, evSeq: 4, replyId: 'r1', text: 'lo' }
    )
    expect(v.inflight.r1).toMatchObject({ messageUid: 'm2', state: 'thinking', text: 'Hello' })
    const rows = chatRows(v)
    expect(rows).toHaveLength(2)
    expect(rows[1].message?.uid).toBe('m2')
    expect(rows[1].reply?.text).toBe('Hello')
    v = apply(v, { t: 'reply.done', sessionUid: S, evSeq: 5, replyId: 'r1', message: msg(2, 'assistant', { body: 'Hello' }) })
    expect(v.inflight).toEqual({})
    expect(v.messages.map((m) => m.body)).toEqual(['body 1', 'Hello'])
  })

  it('shows a reply whose message is not known yet at the end', () => {
    const v = apply(applyPage(emptyChat(), page([msg(1)])), { t: 'reply.delta', sessionUid: S, evSeq: 1, replyId: 'r7', text: 'hi' })
    const rows = chatRows(v)
    expect(rows.map((r) => r.key)).toEqual(['m1', 'reply:r7'])
  })

  it('records reply errors and session notices', () => {
    let v = applyPage(emptyChat(), page([]))
    v = apply(v, { t: 'reply.error', sessionUid: S, evSeq: 1, replyId: 'r1', error: { code: 'provider_auth', message: 'bad key', retryable: false } })
    expect(v.inflight.r1).toMatchObject({ state: 'error', error: { code: 'provider_auth' } })
    v = apply(v, { t: 'reply.error', sessionUid: S, evSeq: 2, replyId: null, error: { code: 'session_busy', message: 'busy', retryable: true } })
    expect(v.notice?.code).toBe('session_busy')
  })

  it('seeds in-flight replies from subscribed and snapshots', () => {
    let v = apply(emptyChat(), {
      t: 'subscribed',
      sessionUid: S,
      evSeq: 9,
      replayed: 0,
      inflight: [{ replyId: 'r2', messageUid: 'm4', state: 'writing', text: 'partial', speakingDeviceId: null }]
    })
    expect(v.inflight.r2).toMatchObject({ text: 'partial', messageUid: 'm4' })
    v = apply(v, { t: 'reply.snapshot', sessionUid: S, evSeq: 10, reply: { replyId: 'r2', messageUid: 'm4', state: 'writing', text: 'partial more', speakingDeviceId: null } })
    expect(v.inflight.r2.text).toBe('partial more')
  })

  it('marks deleted messages as tombstones', () => {
    const v = apply(applyPage(emptyChat(), page([msg(1), msg(2)])), { t: 'message.deleted', sessionUid: S, evSeq: 1, messageUid: 'm1' })
    expect(v.messages[0]).toMatchObject({ deleted: true, body: '' })
  })

  it('returns the same view for irrelevant events', () => {
    const v = emptyChat()
    expect(applyChatEvent(v, { t: 'toast', tone: 'info', text: 'x' })).toBe(v)
  })
})

function pg(from: number, to: number, o: Partial<MessagePage> = {}): MessagePage {
  const items: Message[] = []
  for (let k = from; k <= to; k++) items.push(msg(k, k % 2 ? 'user' : 'assistant'))
  return { items, loSeq: from, hiSeq: to, lastSeq: to, hasBefore: from > 1, hasAfter: false, ...o }
}

describe('history window (07 D1) @R5', () => {
  it('prepends older pages and appends newer ones, keeping seq contiguous', () => {
    let v = applyPage(emptyChat(), pg(201, 300, { lastSeq: 1000, hasAfter: true }))
    expect([v.loSeq, v.hiSeq, v.hasBefore, v.hasAfter]).toEqual([201, 300, true, true])
    v = prependPage(v, pg(101, 200))
    expect([v.loSeq, v.messages.length, v.hasBefore]).toEqual([101, 200, true])
    v = appendPage(v, pg(301, 400, { lastSeq: 1000, hasAfter: true }))
    expect([v.hiSeq, v.messages.length, v.hasAfter, v.lastSeq]).toEqual([400, 300, true, 1000])
    v = trimWindow(v, 'top', 100)
    expect([v.loSeq, v.messages.length, v.hasBefore]).toEqual([201, 200, true])
    v = trimWindow(v, 'bottom', 100)
    expect([v.hiSeq, v.messages.length, v.hasAfter]).toEqual([300, 100, true])
    expect(v.messages.every((m, i) => i === 0 || m.seq === v.messages[i - 1].seq + 1)).toBe(true)
  })

  it('ignores overlapping rows in older/newer pages', () => {
    let v = applyPage(emptyChat(), pg(50, 60))
    v = prependPage(v, pg(40, 55))
    expect(v.messages.map((m) => m.seq)).toEqual(Array.from({ length: 21 }, (_, i) => 40 + i))
    expect(prependPage(v, pg(1, 0, { items: [], hasBefore: false })).hasBefore).toBe(false)
  })

  it('appends live messages only at the live edge; elsewhere they wait and bump lastSeq', () => {
    let v = applyPage(emptyChat(), pg(1, 10, { lastSeq: 20, hasAfter: true }))
    v = apply(v, { t: 'message.created', sessionUid: S, evSeq: 1, message: msg(21), lastSeq: 21 })
    expect(v.messages).toHaveLength(10)
    expect(v.lastSeq).toBe(21)
    expect(v.pending.map((m) => m.seq)).toEqual([21])
    // The newer page reaches the edge: the waiting message continues it and is merged.
    v = appendPage(v, pg(11, 20, { hasAfter: false }))
    expect(v.messages.map((m) => m.seq).slice(-2)).toEqual([20, 21])
    expect([v.hasAfter, v.pending.length]).toEqual([false, 0])
  })

  it('does not merge waiting messages across a gap', () => {
    let v = applyPage(emptyChat(), pg(1, 10, { lastSeq: 30, hasAfter: true }))
    v = apply(v, { t: 'message.created', sessionUid: S, evSeq: 1, message: msg(31), lastSeq: 31 })
    v = appendPage(v, pg(11, 20, { hasAfter: false, lastSeq: 30 }))
    expect(v.hiSeq).toBe(20)
    expect(v.hasAfter).toBe(true)
  })

  it('updates a message inside the window even away from the edge', () => {
    let v = applyPage(emptyChat(), pg(1, 10, { lastSeq: 50, hasAfter: true }))
    v = apply(v, { t: 'message.updated', sessionUid: S, evSeq: 1, message: msg(5, 'user', { body: 'restored' }) })
    expect(v.messages[4].body).toBe('restored')
  })

  it('hides replies whose message is outside a window away from the edge', () => {
    let v = applyPage(emptyChat(), pg(1, 10, { lastSeq: 50, hasAfter: true }))
    v = apply(v, { t: 'reply.status', sessionUid: S, evSeq: 1, replyId: 'r', messageUid: 'm51', state: 'writing' })
    expect(chatRows(v).some((r) => r.reply)).toBe(false)
  })

  it('remembers which reply wrote a message (synced reveal continues after reply.done) @R14', () => {
    let v = applyPage(emptyChat(), pg(1, 1))
    v = apply(
      v,
      { t: 'reply.status', sessionUid: S, evSeq: 1, replyId: 'r9', messageUid: 'm2', state: 'writing' },
      { t: 'reply.done', sessionUid: S, evSeq: 2, replyId: 'r9', message: msg(2, 'assistant') }
    )
    expect(v.replyOf.m2).toBe('r9')
  })

  it('collects reasoning and memory tool activity of a reply', () => {
    const v = apply(
      applyPage(emptyChat(), pg(1, 1)),
      { t: 'reply.tool', sessionUid: S, evSeq: 1, replyId: 'r', kind: 'search', query: 'lighthouse', count: 3, sessions: [] },
      { t: 'reply.reasoning', sessionUid: S, evSeq: 2, replyId: 'r', text: 'hm' }
    )
    expect(v.inflight.r.tools).toEqual([{ kind: 'search', query: 'lighthouse', count: 3, sessions: [] }])
    expect(v.inflight.r.reasoning).toBe('hm')
  })

  it('marks the newest assistant row and links rows to the previous message', () => {
    const rows = chatRows(applyPage(emptyChat(), pg(1, 4)))
    expect(rows.map((r) => !!r.newestAi)).toEqual([false, false, false, true])
    expect(rows[2].prev?.seq).toBe(2)
    expect(lastMessageOf(applyPage(emptyChat(), pg(1, 4)), 'user')?.seq).toBe(3)
  })
})

describe('reload races', () => {
  it('keeps a reply that finished while a replacing page was in flight', () => {
    let v = applyPage(emptyChat(), pg(1, 2))
    v = startReload(v)
    v = apply(v, { t: 'reply.done', sessionUid: S, evSeq: 1, replyId: 'r', message: msg(2, 'assistant', { body: 'final words' }) })
    // The page was read before the reply finished: it holds the empty placeholder.
    v = applyPage(v, page([msg(1), msg(2, 'assistant', { body: '', status: 'streaming' })]))
    expect(v.messages[1]).toMatchObject({ body: 'final words', status: 'complete' })
    expect(v.pending).toEqual([])
  })
})
