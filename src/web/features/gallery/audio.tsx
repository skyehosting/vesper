/**
 * Gallery harness for audio-core (07 E4, BLD-13): the AudioEngine with a live output meter, MicCapture with an input
 * meter and frame rate (the Chromium fake mic in e2e), and the synced reveal demo with stop / barge-in / show rest.
 * Test hooks: `__vesperTest.audioGallery.*` (playSpeech, revealDemo, startMic, stopMic, peaks, resetPeaks).
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Button } from '../../components/Button'
import { createLevels, getAudioEngine, getMicCapture, getRevealController, type Levels, type LevelSource } from '../../lib/audio'
import { synthReply, toneWav } from '../../lib/audio/synth'
import { ApiErrorException } from '../../lib/errors.logic'
import { registerTestHooks } from '../../lib/testHooks'
import type { SpeechChunkHeader } from '@shared/ws/binary'

const DEMO_SENTENCES = [
  'Hello, I am Vesper. ',
  'Every letter you see here appears in time with my voice, ',
  'and the last one lands exactly as the sound ends.'
]
const DEMO_TEXT = DEMO_SENTENCES.join('')

const SPEECH_TEXTS = [
  'One small chunk. ',
  'Another follows. ',
  'They play back to back. ',
  'No gaps between them. ',
  'The meter moves. ',
  'Onsets pulse. ',
  'Seven of ten. ',
  'Almost there. ',
  'Nine. ',
  'And the final chunk.'
]

let replySeq = 0
const nextReplyId = (p: string): string => `${p}-${++replySeq}-${Date.now().toString(36)}`

/** Peak levels seen by the meters since the last reset (e2e reads them). */
const peaks = { output: 0, input: 0, outputOnset: 0 }

const meterBox: CSSProperties = { display: 'grid', gridTemplateColumns: '64px 1fr 48px', gap: '4px 10px', alignItems: 'center', maxWidth: 520 }
const barTrack: CSSProperties = { height: 8, borderRadius: 4, background: 'var(--bg-3)', overflow: 'hidden' }
const barFill: CSSProperties = { height: '100%', width: '0%', background: 'var(--accent)', transformOrigin: 'left', transition: 'none' }

/** rms/low/mid/high/onset bars driven by rAF; DOM writes only, no React state per frame. */
function LevelMeter({ source, label, onPeak }: { source: LevelSource; label: string; onPeak: (l: Levels) => void }): ReactNode {
  const refs = useRef<Array<HTMLDivElement | null>>([])
  const nums = useRef<Array<HTMLSpanElement | null>>([])
  useEffect(() => {
    const levels = createLevels()
    const keys = ['rms', 'low', 'mid', 'high', 'onset'] as const
    let raf = 0
    const tick = (): void => {
      source.read(levels)
      onPeak(levels)
      keys.forEach((k, i) => {
        const el = refs.current[i]
        if (el) el.style.width = `${Math.round(levels[k] * 100)}%`
        const n = nums.current[i]
        if (n) n.textContent = levels[k].toFixed(2)
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [source, onPeak])
  return (
    <div style={meterBox} aria-label={label} data-testid={`meter-${label}`}>
      {(['rms', 'low', 'mid', 'high', 'onset'] as const).map((k, i) => (
        <div key={k} style={{ display: 'contents' }}>
          <span className="gallery__note">{k}</span>
          <div style={barTrack}>
            <div
              style={barFill}
              ref={(el) => {
                refs.current[i] = el
              }}
            />
          </div>
          <span
            className="gallery__note"
            ref={(el) => {
              nums.current[i] = el
            }}
          >
            0.00
          </span>
        </div>
      ))}
    </div>
  )
}

const onOutputPeak = (l: Levels): void => {
  peaks.output = Math.max(peaks.output, l.rms)
  peaks.outputOnset = Math.max(peaks.outputOnset, l.onset)
}
const onInputPeak = (l: Levels): void => {
  peaks.input = Math.max(peaks.input, l.rms)
}

function enqueueAll(chunks: Array<{ header: SpeechChunkHeader; bytes: ArrayBuffer }>): void {
  const engine = getAudioEngine()
  for (const c of chunks) engine.enqueue(c.header, c.bytes)
}

export default function AudioGallery(): ReactNode {
  const engine = getAudioEngine()
  const mic = getMicCapture()
  const [status, setStatus] = useState('Audio is locked until you press Unlock (browsers need a click first).')
  const [micState, setMicState] = useState('Microphone off.')
  const [lastReply, setLastReply] = useState<string | null>(null)
  const [demoReply, setDemoReply] = useState<string | null>(null)
  const demoRef = useRef<HTMLParagraphElement | null>(null)
  const unbindRef = useRef<(() => void) | null>(null)

  const unlock = async (): Promise<void> => {
    const ok = await engine.unlock()
    setStatus(ok ? 'Audio unlocked.' : 'Audio is still locked (no user gesture).')
  }

  const playTone = (): void => {
    const t = toneWav(440, 600)
    const replyId = nextReplyId('tone')
    engine.enqueue(
      { sessionUid: 'gallery', evSeq: 0, replyId, index: 0, src: [0, 0], text: '', spoken: '', timeline: null, durationMs: t.durationMs, mime: 'audio/wav', instant: false, final: true },
      t.bytes
    )
    setLastReply(replyId)
  }

  const playSpeech = (o: { chunks?: number; format?: 'wav' | 'l16'; charMs?: number } = {}): string => {
    const replyId = nextReplyId('speech')
    const texts = SPEECH_TEXTS.slice(0, Math.max(1, Math.min(SPEECH_TEXTS.length, o.chunks ?? SPEECH_TEXTS.length)))
    enqueueAll(synthReply(replyId, texts, { format: o.format, charMs: o.charMs }))
    setLastReply(replyId)
    return replyId
  }

  /** Play `n` short replies one after another (each waits for the previous replyEnd): the 200-reply leak gate. */
  const playMany = (n: number, o: { format?: 'wav' | 'l16' } = {}): Promise<number> =>
    new Promise((resolve) => {
      let done = 0
      let current = ''
      const off = engine.on('replyEnd', (e) => {
        if (e.replyId !== current) return
        if (++done >= n) {
          off()
          resolve(done)
        } else next()
      })
      const next = (): void => {
        current = nextReplyId('many')
        enqueueAll(synthReply(current, ['Hi.'], { format: done % 2 ? 'l16' : o.format, charMs: 8, gapMs: 8 }))
      }
      next()
    })

  const revealDemo = (o: { format?: 'wav' | 'l16' } = {}): string => {
    const el = demoRef.current
    if (!el) throw new Error('reveal demo not mounted')
    unbindRef.current?.()
    const replyId = nextReplyId('reveal')
    const chunks = synthReply(replyId, DEMO_SENTENCES, { format: o.format })
    // Like chat-ui: bind first (the text goes invisible), then the audio arrives.
    unbindRef.current = getRevealController().bind(
      replyId,
      el,
      chunks.map((c) => c.header)
    )
    enqueueAll(chunks)
    setDemoReply(replyId)
    return replyId
  }

  const startMic = async (): Promise<string> => {
    try {
      await mic.start({ echoCancellation: true, noiseSuppression: true, autoGainControl: true })
      setMicState('Microphone on: 16 kHz frames arriving.')
      return 'ok'
    } catch (e) {
      const code = e instanceof ApiErrorException ? e.code : 'internal'
      setMicState(e instanceof ApiErrorException ? `${e.error.message} (${code})` : 'Microphone failed.')
      return code
    }
  }

  const stopMic = (): void => {
    mic.stop()
    setMicState('Microphone off.')
  }

  // Frame-rate readout, refreshed twice a second while the mic is on.
  const [rate, setRate] = useState('—')
  useEffect(() => {
    const id = setInterval(() => {
      const s = mic.stats()
      if (!s.active || s.frames < 2) return setRate('—')
      const fps = ((s.frames - 1) * 1000) / Math.max(1, s.lastFrameAt - s.firstFrameAt)
      setRate(`${s.frames} frames · ${fps.toFixed(1)} /s`)
    }, 500)
    return () => clearInterval(id)
  }, [mic])

  useEffect(() => {
    const off = registerTestHooks('audioGallery', {
      playSpeech,
      playMany,
      revealDemo,
      startMic,
      stopMic,
      demoText: () => DEMO_TEXT,
      peaks: () => ({ ...peaks }),
      resetPeaks: () => {
        peaks.output = peaks.input = peaks.outputOnset = 0
      }
    })
    return () => {
      off()
      unbindRef.current?.()
      unbindRef.current = null
      mic.stop()
    }
    // The hooks close over stable singletons and refs; registering once per mount is intended.
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }} data-testid="audio-gallery">
      <div>
        <div className="gallery__row">
          <Button variant="primary" onClick={() => void unlock()} data-testid="audio-unlock">
            Unlock audio
          </Button>
          <Button onClick={playTone}>Play tone</Button>
          <Button onClick={() => void playSpeech()}>Play speech (10 chunks)</Button>
          <Button onClick={() => void playSpeech({ format: 'l16' })}>Play speech (raw PCM)</Button>
          <Button variant="danger" onClick={() => (lastReply ? engine.stop(lastReply) : engine.stop())}>
            Stop
          </Button>
        </div>
        <p className="gallery__note" role="status">
          {status}
        </p>
        <LevelMeter source={engine.output} label="output" onPeak={onOutputPeak} />
      </div>

      <div>
        <div className="gallery__row">
          <Button variant="primary" onClick={() => void startMic()} data-testid="mic-start">
            Start microphone
          </Button>
          <Button onClick={stopMic}>Stop microphone</Button>
          <span className="gallery__note">{rate}</span>
        </div>
        <p className="gallery__note" role="status">
          {micState}
        </p>
        <LevelMeter source={mic.input} label="input" onPeak={onInputPeak} />
      </div>

      <div>
        <div className="gallery__row">
          <Button variant="primary" onClick={() => void revealDemo()}>
            Speak with synced reveal
          </Button>
          <Button variant="danger" onClick={() => demoReply && engine.stop(demoReply)}>
            Barge in
          </Button>
          <Button onClick={() => demoReply && getRevealController().finish(demoReply)}>Show rest</Button>
        </div>
        <p
          ref={demoRef}
          data-testid="reveal-demo"
          data-src-start={0}
          data-src-end={DEMO_TEXT.length}
          style={{ maxWidth: 560, fontSize: 'var(--fs-lg, 18px)', lineHeight: 1.6, color: 'var(--text-0)' }}
        >
          {DEMO_TEXT}
        </p>
      </div>
    </div>
  )
}
