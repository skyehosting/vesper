/** Talk mode state machine (07 D6) @R19 @R15 */
import { describe, expect, it } from 'vitest'
import { apiError } from '@shared/errors'
import {
  initialTalk,
  primaryAction,
  talkEntry,
  talkErrorWayOut,
  type TalkPlace,
  talkReducer,
  type TalkEvent,
  type TalkState
} from '../../../../src/web/features/presence/talk/talk.logic'

function run(events: TalkEvent[], from: TalkState = initialTalk()): TalkState {
  return events.reduce(talkReducer, from)
}

/** Where Talk mode runs: the desktop app on Windows, a phone or remote browser. */
const PC: TalkPlace = { desktop: true, micAction: () => 'retry' }
const PHONE: TalkPlace = { desktop: false, micAction: () => 'retry' }

const ready: TalkEvent[] = [{ t: 'mic.ready' }, { t: 'stt.state', state: 'listening' }]

describe('talkReducer', () => {
  it('starts, warms up, listens', () => {
    expect(run([{ t: 'stt.state', state: 'warming-up' }, { t: 'mic.ready' }]).phase).toBe('warming-up')
    expect(run([{ t: 'stt.state', state: 'warming-up' }, { t: 'mic.ready' }, { t: 'stt.state', state: 'listening' }]).phase).toBe('listening')
    expect(run(ready).phase).toBe('listening')
  })

  it('a full turn: partial → final → thinking → speaking → listening', () => {
    let s = run([...ready, { t: 'stt.partial', text: 'Hello' }])
    expect(s).toMatchObject({ phase: 'listening', partial: 'Hello' })
    expect(primaryAction(s, PC)).toBe('send')
    s = run(
      [
        { t: 'stt.state', state: 'transcribing' },
        { t: 'stt.final', text: 'Hello Vesper' }
      ],
      s
    )
    expect(s).toMatchObject({ phase: 'thinking', said: 'Hello Vesper' })
    expect(primaryAction(s, PC)).toBe('interrupt')
    s = run(
      [
        { t: 'sent', replyId: 'r1', messageUid: 'm1' },
        { t: 'reply.status', replyId: 'r1', messageUid: 'm1', state: 'writing' }
      ],
      s
    )
    expect(s).toMatchObject({ phase: 'thinking', replyId: 'r1' })
    s = talkReducer(s, { t: 'speech.start', replyId: 'r1' })
    expect(s.phase).toBe('speaking')
    // The text finished first; the audio keeps playing.
    s = talkReducer(s, { t: 'reply.done', replyId: 'r1', spoken: true })
    expect(s.phase).toBe('speaking')
    s = talkReducer(s, { t: 'speech.end', replyId: 'r1' })
    expect(s.phase).toBe('listening')
  })

  it('a reply without voice returns to listening when the text is done', () => {
    const s = run([...ready, { t: 'stt.final', text: 'Hi' }, { t: 'sent', replyId: 'r2', messageUid: null }, { t: 'reply.done', replyId: 'r2', spoken: false }])
    expect(s.phase).toBe('listening')
  })

  it('events of other replies are ignored', () => {
    const s = run([...ready, { t: 'stt.final', text: 'Hi' }, { t: 'sent', replyId: 'mine', messageUid: null }])
    expect(talkReducer(s, { t: 'reply.done', replyId: 'other', spoken: false })).toBe(s)
    expect(talkReducer(s, { t: 'reply.status', replyId: 'other', messageUid: 'x', state: 'writing' })).toBe(s)
  })

  it('interrupt stops an answer and listens again', () => {
    const s = run([...ready, { t: 'stt.final', text: 'Hi' }, { t: 'speech.start', replyId: 'r' }, { t: 'interrupt' }])
    expect(s.phase).toBe('listening')
    // Nothing to interrupt while listening.
    expect(talkReducer(s, { t: 'interrupt' })).toBe(s)
  })

  it('hold pauses everything; partials and finals are ignored until resume', () => {
    let s = run([...ready, { t: 'hold' }])
    expect(s.phase).toBe('held')
    expect(primaryAction(s, PC)).toBe('talk')
    expect(talkReducer(s, { t: 'stt.partial', text: 'x' })).toBe(s)
    s = talkReducer(s, { t: 'stt.final', text: 'not sent' })
    expect(s.phase).toBe('held')
    s = talkReducer(s, { t: 'resume' })
    expect(s.phase).toBe('listening')
  })

  it('muted: the mic stays, nothing is heard; the big button unmutes', () => {
    let s = run([...ready, { t: 'stt.partial', text: 'half' }, { t: 'mute', muted: true }])
    expect(s).toMatchObject({ muted: true, partial: '' })
    expect(primaryAction(s, PC)).toBe('unmute')
    s = talkReducer(s, { t: 'stt.final', text: 'heard while muted' })
    expect(s.phase).toBe('listening')
    s = talkReducer(s, { t: 'mute', muted: false })
    expect(s.muted).toBe(false)
  })

  it('mic errors show and retry starts over', () => {
    let s = run([{ t: 'mic.error', error: apiError('mic_denied') }])
    expect(s).toMatchObject({ phase: 'error' })
    expect(s.error?.code).toBe('mic_denied')
    expect(primaryAction(s, PC)).toBe('retry')
    s = talkReducer(s, { t: 'retry' })
    expect(s.phase).toBe('starting')
  })

  it('a busy session is a notice, not a failure', () => {
    const s = run([...ready, { t: 'stt.final', text: 'Hi' }, { t: 'reply.error', replyId: null, error: apiError('session_busy') }])
    expect(s.phase).toBe('listening')
    expect(s.error?.code).toBe('session_busy')
  })

  it('insecure origins say so (07 D8)', () => {
    expect(run([{ t: 'insecure' }]).phase).toBe('insecure')
  })

  it('ended is final', () => {
    const s = run([...ready, { t: 'end' }])
    expect(talkReducer(s, { t: 'mic.ready' })).toBe(s)
  })

  it('listening with nothing said: the big button pauses (hold)', () => {
    expect(primaryAction(run(ready), PC)).toBe('hold')
    expect(primaryAction(initialTalk(), PC)).toBe('none')
  })

  it('a missing speech model is not retried: the big button leads to setup (07 D13, review F51)', () => {
    const s = run([{ t: 'mic.ready' }, { t: 'stt.state', state: 'error', error: apiError('stt_model_missing') }])
    expect(s.phase).toBe('error')
    expect(primaryAction(s, PC)).toBe('setup')
    expect(talkErrorWayOut(s.error, PC)).toMatchObject({ primary: 'setup', setupLabel: 'Download the speech model' })
    // A crashed or busy recognizer may come back: retry stays first, setup and text are still offered.
    expect(primaryAction(run([{ t: 'stt.state', state: 'error', error: apiError('stt_crashed') }]), PC)).toBe('retry')
    expect(talkErrorWayOut(apiError('stt_unavailable'), PC)).toMatchObject({ primary: 'retry', settings: true, text: true })
    expect(talkErrorWayOut(apiError('mic_denied'), PC)).toMatchObject({ primary: 'retry', text: true })
  })

  it('off the PC, a missing model offers no setup it cannot do there: Try again, the PC hint and text (second pass F51)', () => {
    for (const code of ['stt_model_missing', 'model_checksum', 'model_unsafe']) {
      const s = run([{ t: 'mic.ready' }, { t: 'stt.state', state: 'error', error: apiError(code as 'stt_model_missing') }])
      expect(primaryAction(s, PHONE)).toBe('retry')
      const w = talkErrorWayOut(s.error, PHONE)
      expect(w).toMatchObject({ primary: 'retry', settings: false, windowsSettings: false, text: true })
      expect(w.note).toMatch(/on your PC/)
    }
    // Recognizer trouble: Voice-in settings only where they can help (the PC).
    expect(talkErrorWayOut(apiError('stt_unavailable'), PHONE)).toMatchObject({ primary: 'retry', settings: false, note: null })
    expect(talkErrorWayOut(apiError('stt_model_missing'), PC).note).toBeNull()
  })

  it('a microphone Windows blocks offers "Open Windows settings" on the desktop app, like the composer (second pass F51)', () => {
    const winDesk: TalkPlace = { desktop: true, micAction: (code) => (code === 'mic_os_blocked' ? 'open-windows-privacy' : 'retry') }
    const s = run([{ t: 'mic.error', error: apiError('mic_os_blocked') }])
    expect(primaryAction(s, winDesk)).toBe('retry')
    expect(talkErrorWayOut(s.error, winDesk)).toMatchObject({ primary: 'retry', windowsSettings: true, settings: false, text: true })
    expect(talkErrorWayOut(apiError('mic_denied'), winDesk)).toMatchObject({ windowsSettings: false })
    expect(talkErrorWayOut(s.error, PHONE)).toMatchObject({ windowsSettings: false })
  })
})

describe('talkEntry (second pass F51: Talk mode needs voice input)', () => {
  const on = { voice: { stt: { enabled: true } } }
  const off = { voice: { stt: { enabled: false } } }
  it('opens when voice input is on', () => {
    expect(talkEntry(on, true)).toBeNull()
    expect(talkEntry(on, false)).toBeNull()
  })
  it('voice input off: set it up on the PC (an action there, the way to it elsewhere)', () => {
    expect(talkEntry(off, true)).toEqual({ message: 'Talk mode needs voice input.', setup: true })
    expect(talkEntry(off, false)).toEqual({ message: 'Talk mode needs voice input. Turn it on in Vesper on your PC: Settings → Voice in.', setup: false })
    expect(talkEntry(null, true)).toMatchObject({ setup: true })
  })
})
