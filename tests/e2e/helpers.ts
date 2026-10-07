/**
 * Shared e2e steps built only on the frozen contracts (src/shared/api.ts, src/shared/ws), so the smoke specs do not
 * depend on any UI detail beyond the routes below and visible text.
 */
import { expect, type Page } from '@playwright/test'
import type { Api } from './launch'

/** Client routes the specs navigate to with `__vesperTest.go()` (web-shell's route table; see docs/requests/test-infra.md). */
export const routes = {
  home: '/',
  chat: (sessionUid: string): string => `/s/${sessionUid}`
}

/** Minimal shapes of the REST payloads the specs read (full types: src/shared/types/domain.ts). */
export interface SessionLite {
  uid: string
  shortId: string
  title: string
}

export interface MessageLite {
  uid: string
  role: 'user' | 'assistant'
  body: string
  status: string
  hidden?: boolean
}

/**
 * Point the default LLM profile at the mock server (OpenAI-compatible "custom" preset: no key needed) and mark the
 * wizard done. Needs a desktop device: settings that name providers and URLs are desktop-only (07 B2).
 */
export async function configureMockLlm(api: Api, mockBase: string, model = 'mock-echo'): Promise<void> {
  const profile = { id: 'mock', label: 'Mock LLM', preset: 'custom', adapter: 'openai', baseUrl: `${mockBase}/v1`, model }
  const r = await api('PATCH', '/api/settings', { llm: { profiles: [profile], defaultProfile: 'mock' }, wizard: { completed: true } })
  expect(r.status, `PATCH /api/settings → ${r.status} ${r.text}`).toBe(200)
}

export async function createSession(api: Api, title: string): Promise<SessionLite> {
  const r = await api<SessionLite>('POST', '/api/sessions', { title })
  expect([200, 201], `POST /api/sessions → ${r.status} ${r.text}`).toContain(r.status)
  expect(r.json.uid).toBeTruthy()
  return r.json
}

export async function latestMessages(api: Api, sessionUid: string, limit = 50): Promise<MessageLite[]> {
  const r = await api<{ items: MessageLite[] }>('GET', `/api/sessions/${sessionUid}/messages?mode=latest&limit=${limit}`)
  expect(r.status, `GET messages → ${r.status} ${r.text}`).toBe(200)
  return r.json.items.filter((m) => !m.hidden)
}

export interface TurnResult {
  /** Final clean body of the assistant message (reply.done). */
  body: string
  /** Concatenated reply.delta text. */
  deltas: string
  /** Every server event type seen, in order. */
  events: string[]
}

/**
 * One chat turn over a second WebSocket opened inside the page (same origin, the page's own cookie):
 * hello → ready → subscribe → subscribed → chat.send → … → reply.done. Proves the WS pipeline end to end without
 * depending on the composer UI; a client showing the session receives the same session events.
 */
export async function wsTurn(page: Page, sessionUid: string, text: string, timeoutMs = 30_000): Promise<TurnResult> {
  return page.evaluate(
    ({ sessionUid: sid, text: msg, timeoutMs: limit }) =>
      new Promise<TurnResult>((resolve, reject) => {
        const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
        const events: string[] = []
        let deltas = ''
        let settled = false
        const finish = (fn: () => void): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          ws.close()
          fn()
        }
        const timer = setTimeout(() => finish(() => reject(new Error(`wsTurn timed out; events: ${events.join(', ')}`))), limit)
        const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone
        const tzOffset = -new Date().getTimezoneOffset()
        const send = (m: Record<string, unknown>): void => ws.send(JSON.stringify(m))
        ws.onopen = () => send({ t: 'hello', protocol: 1, tz: tzName, tzOffset, client: { visible: true, focused: false, audioUnlocked: false }, deviceName: 'e2e' })
        ws.onmessage = (ev: MessageEvent) => {
          if (typeof ev.data !== 'string') return
          const m = JSON.parse(ev.data) as { t: string; [k: string]: unknown }
          events.push(m.t)
          if (m.t === 'ping') send({ t: 'pong', ts: m.ts })
          else if (m.t === 'ready') send({ t: 'subscribe', id: 'e2e-sub', sessionUid: sid })
          else if (m.t === 'subscribed' && m.sessionUid === sid)
            send({ t: 'chat.send', id: 'e2e-send', sessionUid: sid, text: msg, attachments: [], client: { ts: Date.now(), tzOffset, tzName }, speak: false })
          else if (m.t === 'reply.delta') deltas += String(m.text)
          else if (m.t === 'reply.done') finish(() => resolve({ body: String((m.message as { body: string }).body), deltas, events }))
          else if (m.t === 'reply.error' || (m.t === 'error' && (m.id === 'e2e-send' || m.id === 'e2e-sub'))) finish(() => reject(new Error(`chat turn failed: ${JSON.stringify(m)}`)))
        }
        ws.onerror = () => finish(() => reject(new Error(`WebSocket error; events: ${events.join(', ')}`)))
        ws.onclose = (ev: CloseEvent) => finish(() => reject(new Error(`WebSocket closed (${ev.code} ${ev.reason}); events: ${events.join(', ')}`)))
      }),
    { sessionUid, text, timeoutMs }
  )
}
