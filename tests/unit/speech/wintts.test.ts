/**
 * Windows voice host lifecycle (07 E5 S2, D2, C19): spawn once and reuse, crash → restart (supervised), idle exit,
 * abort/timeout, close → no orphan powershell.exe. A fake runner drives the edge cases; the real WinRT host runs on
 * this PC when it is Windows (free, offline; it synthesizes to a file and never plays audio). @R12
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, describe, expect, it } from 'vitest'
import { WinTtsHost, type HostProcess, type HostSpawn } from '@server/providers/tts/winttsHost'
import { createWindowsTts, cuesToTimeline } from '@server/providers/tts/windows'
import { readWav } from '@server/speech/audio'
import { encodeWav, synthSpeech } from '../../mocks/audio'
import { fakeLog } from '../../fakes'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-wintts-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

type Behaviour = 'ok' | 'hang' | 'ignore-eof' | 'fail'

class FakeProc extends EventEmitter implements HostProcess {
  static next = 1000
  readonly pid = FakeProc.next++
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  ended = false
  exited = false
  killed = false
  readonly stdin: HostProcess['stdin']
  constructor(public behaviour: () => Behaviour) {
    super()
    this.stdin = {
      write: (s: string) => {
        for (const line of s.split('\n').filter(Boolean)) this.answer(JSON.parse(line) as Record<string, unknown>)
        return true
      },
      end: () => {
        this.ended = true
        if (this.behaviour() !== 'ignore-eof') setTimeout(() => this.exit(0), 5)
      },
      on: () => this.stdin
    }
    setTimeout(() => this.reply({ id: 0, ok: true, ready: true }), 5)
  }
  private reply(o: unknown): void {
    if (!this.exited) this.stdout.write(`${JSON.stringify(o)}\n`)
  }
  private answer(req: Record<string, unknown>): void {
    const b = this.behaviour()
    if (b === 'hang') return
    if (b === 'fail') return this.reply({ id: req.id, ok: false, error: 'boom' })
    setTimeout(() => {
      if (req.op === 'voices') this.reply({ id: req.id, ok: true, voices: [{ id: 'tok\\Zira', name: 'Microsoft Zira', language: 'en-US', gender: 'Female' }] })
      else if (req.op === 'speak') {
        const s = synthSpeech(String(req.text), { sampleRate: 16000 })
        if (!this.exited) fs.writeFileSync(String(req.out), encodeWav(s.pcm, 16000))
        this.reply({ id: req.id, ok: true, out: req.out, words: [{ text: 'Hello', startMs: 0, durMs: 300, pos: 0, end: 4 }] })
      } else this.reply({ id: req.id, ok: true })
    }, 5)
  }
  exit(code: number | null): void {
    if (this.exited) return
    this.exited = true
    this.emit('exit', code)
  }
  kill(): boolean {
    this.killed = true
    setTimeout(() => this.exit(null), 1)
    return true
  }
}

function fakeRunner(behaviour: () => Behaviour = () => 'ok'): { spawn: HostSpawn; procs: FakeProc[] } {
  const procs: FakeProc[] = []
  return {
    procs,
    spawn: (cmd, args) => {
      expect(cmd).toBe('powershell.exe')
      expect(args).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'wintts.ps1'])
      const p = new FakeProc(behaviour)
      procs.push(p)
      return p
    }
  }
}

const host = (spawn: HostSpawn, o: Partial<ConstructorParameters<typeof WinTtsHost>[0]> = {}) => new WinTtsHost({ script: 'wintts.ps1', tempDir: tmp, log: fakeLog(), spawn, ...o })
const speakArgs = { text: 'Hello there', voice: null, rate: 1, pitch: 1, volume: 1 }

describe('WinTtsHost (fake runner)', () => {
  it('starts lazily, once, and reuses the process', async () => {
    const r = fakeRunner()
    const h = host(r.spawn)
    expect(r.procs).toHaveLength(0)
    expect(await h.voices()).toEqual([{ id: 'tok\\Zira', name: 'Microsoft Zira', language: 'en-US', gender: 'Female' }])
    const a = await h.speak(speakArgs)
    const b = await h.speak(speakArgs)
    expect(readWav(a.wav)!.sampleRate).toBe(16000)
    expect(b.words[0]).toEqual({ text: 'Hello', startMs: 0, durMs: 300, pos: 0, end: 4 })
    expect(r.procs).toHaveLength(1)
    expect(fs.readdirSync(tmp)).toEqual([]) // WAVs are read back and removed
    await h.close()
    expect(r.procs[0].ended).toBe(true)
    expect(h.stats()).toMatchObject({ running: false, pending: 0, idleTimer: false })
  })

  it('a crash fails the pending request and the next one restarts the host', async () => {
    let mode: Behaviour = 'hang'
    const r = fakeRunner(() => mode)
    const h = host(r.spawn)
    const pending = h.speak(speakArgs)
    await new Promise((x) => setTimeout(x, 20))
    r.procs[0].exit(1)
    await expect(pending).rejects.toMatchObject({ info: { code: 'tts_failed' } })
    mode = 'ok'
    await h.speak(speakArgs)
    expect(r.procs).toHaveLength(2)
    await h.close()
  })

  it('supervision: at most 3 starts per 5 minutes, then tts_failed until the window passes (07 C19)', async () => {
    let now = 0
    const r = fakeRunner()
    const h = host(r.spawn, { now: () => now })
    for (let i = 0; i < 3; i++) {
      await h.voices()
      r.procs[i].exit(1)
      await new Promise((x) => setTimeout(x, 5))
    }
    await expect(h.voices()).rejects.toMatchObject({ info: { code: 'tts_failed' } })
    now += 5 * 60_000 + 1
    await expect(h.voices()).resolves.toHaveLength(1)
    await h.close()
  })

  it('exits after the idle time (07 D2) and starts again on demand', async () => {
    const r = fakeRunner()
    const h = host(r.spawn, { idleMs: 30 })
    await h.voices()
    expect(h.running).toBe(true)
    await new Promise((x) => setTimeout(x, 80))
    expect(h.running).toBe(false)
    expect(r.procs[0].ended).toBe(true)
    await h.voices()
    expect(r.procs).toHaveLength(2)
    await h.close()
  })

  it('abort rejects at once; a request timeout replaces a stuck host', async () => {
    const r = fakeRunner(() => 'hang')
    const h = host(r.spawn, { requestTimeoutMs: 40 })
    const ac = new AbortController()
    const p = h.speak(speakArgs, ac.signal)
    setTimeout(() => ac.abort(), 15)
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    await expect(h.voices()).rejects.toMatchObject({ info: { code: 'tts_failed' } })
    expect(r.procs[0].killed).toBe(true)
    await new Promise((x) => setTimeout(x, 10))
    expect(h.stats().pending).toBe(0)
    await h.close()
  })

  it('a host error line rejects only that request', async () => {
    let mode: Behaviour = 'fail'
    const r = fakeRunner(() => mode)
    const h = host(r.spawn)
    await expect(h.voices()).rejects.toMatchObject({ info: { code: 'tts_failed' } })
    mode = 'ok'
    await expect(h.voices()).resolves.toHaveLength(1)
    expect(r.procs).toHaveLength(1)
    await h.close()
  })

  it('close kills a host that ignores stdin EOF', async () => {
    const r = fakeRunner(() => 'ignore-eof')
    const h = host(r.spawn)
    await h.voices()
    await h.close()
    expect(r.procs[0].killed).toBe(true)
    expect(r.procs[0].exited).toBe(true)
  }, 10_000)

  it('options left undefined keep their defaults: the host stays up between replies (soak finding)', async () => {
    // createTtsProviders passes `idleMs: d.hostIdleMs` (undefined unless a test sets it); the spread used to turn the
    // 10-minute idle into setTimeout(undefined) — the host quit after every request and the 4th reply in 5 minutes
    // failed with "Windows voices keep failing".
    const r = fakeRunner()
    const h = host(r.spawn, { idleMs: undefined, requestTimeoutMs: undefined })
    for (let i = 0; i < 5; i++) {
      await h.speak(speakArgs)
      await new Promise((x) => setTimeout(x, 30))
    }
    expect(r.procs).toHaveLength(1)
    expect(h.stats()).toMatchObject({ running: true, idleTimer: true })
    await h.close()
  }, 10_000)

  it('stops on purpose (game mode / "Unload voice models now", idle) do not use up the crash budget (soak finding)', async () => {
    // Game mode unloads the voice host every minute while idle; each reply restarts it. Those restarts used to count
    // as crashes, so the 4th reply within 5 minutes failed with "Windows voices keep failing" for 5 minutes.
    const r = fakeRunner()
    const h = host(r.spawn, { now: () => 0 })
    for (let i = 0; i < 5; i++) {
      await h.speak(speakArgs)
      expect(await h.release()).toBe(true)
    }
    await h.speak(speakArgs)
    expect(r.procs).toHaveLength(6)
    await h.close()
  }, 10_000)
})

describe('Windows provider', () => {
  it('word cues → per-char timeline: words spread over their cue, gaps filled, monotonic, within the audio', () => {
    const text = 'Hi there, you.'
    const t = cuesToTimeline(
      text,
      [
        { text: 'Hi', startMs: 100, durMs: 200, pos: 0, end: 1 },
        { text: 'there', startMs: 350, durMs: 250, pos: 3, end: 7 },
        { text: 'you', startMs: 700, durMs: 200, pos: 10, end: 12 }
      ],
      1000
    )
    expect(t.startsMs).toHaveLength(text.length)
    expect(t.startsMs[0]).toBe(100)
    expect(t.startsMs[1]).toBe(200)
    expect(t.startsMs[3]).toBe(350)
    expect(t.startsMs[10]).toBe(700)
    for (let i = 1; i < text.length; i++) expect(t.startsMs[i]).toBeGreaterThanOrEqual(t.startsMs[i - 1])
    expect(Math.max(...t.endsMs)).toBeLessThanOrEqual(1000)
  })

  it('is unavailable off Windows', async () => {
    const p = createWindowsTts(() => host(fakeRunner().spawn), 'linux')
    expect(p.available()).toBe(false)
    expect((await p.list(new AbortController().signal)).voices).toEqual([])
  })
})

const onWindows = process.platform === 'win32'

describe.skipIf(!onWindows)('real WinRT host on this PC', () => {
  const script = path.resolve('resources', 'wintts.ps1')

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it('lists voices, synthesizes with word cues, survives a crash, and leaves no powershell.exe behind', async () => {
    const h = new WinTtsHost({ script, tempDir: tmp, log: fakeLog() })
    const voices = await h.voices()
    if (!voices.length) return // no OneCore voices installed: nothing to test here
    const pid = h.pid!
    const p = createWindowsTts(() => h)
    const a = await p.synthesize({ text: 'Hello there. How are you today?', voiceId: voices[0].name, model: null, tone: null, speed: 1, stability: 0.5, similarity: 0.75 }, new AbortController().signal)
    expect(a.mime).toBe('audio/wav')
    expect(a.timing).toBe('cues')
    expect(a.durationMs).toBeGreaterThan(500)
    expect(a.timeline!.startsMs).toHaveLength('Hello there. How are you today?'.length)
    // Tone → prosody: an excited reading is faster than a sad one.
    const fast = await p.synthesize({ text: 'One two three four five six.', voiceId: null, model: null, tone: 'excited', speed: 1, stability: 0.5, similarity: 0.75 }, new AbortController().signal)
    const slow = await p.synthesize({ text: 'One two three four five six.', voiceId: null, model: null, tone: 'sad', speed: 1, stability: 0.5, similarity: 0.75 }, new AbortController().signal)
    expect(fast.durationMs).toBeLessThan(slow.durationMs)
    expect(h.pid).toBe(pid) // one process for all of it
    expect(h.spawned).toBe(1)

    process.kill(pid) // crash
    // The exit event arrives when Windows reports it (slow under load): wait for it instead of a fixed 300 ms.
    for (let i = 0; i < 100 && h.running; i++) await new Promise((x) => setTimeout(x, 50))
    expect(h.running).toBe(false)
    await h.voices()
    const pid2 = h.pid!
    expect(pid2).not.toBe(pid)
    await h.close()
    await new Promise((x) => setTimeout(x, 200))
    expect(alive(pid)).toBe(false)
    expect(alive(pid2)).toBe(false)
    expect(fs.readdirSync(tmp).filter((f) => f.endsWith('.wav'))).toEqual([])
  }, 30_000)
})
