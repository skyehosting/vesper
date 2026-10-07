/**
 * sherpa-onnx-node 1.13.8 glue for the STT process (research 05 §4.4): recognizer configs per model family, Silero VAD
 * and a minimal typed surface of the addon (the package ships JSDoc only). Rules from research: every call that can
 * return audio passes `enableExternalBuffer=false` (Electron forbids external buffers), recognizers are created with
 * `createAsync` and decode with `decodeAsync` so the process keeps answering while a model loads or decodes.
 *
 * This module is imported only by src/workers/stt.process.ts: onnxruntime must never load in the server process.
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { ModelEntry } from '@shared/models'
import type { VadLike } from './endpointer'
import { SAMPLE_RATE, VAD_WINDOW } from './protocol'

interface SherpaVad {
  acceptWaveform(s: Float32Array): void
  isDetected(): boolean
  isEmpty(): boolean
  front(enableExternalBuffer: boolean): { start: number; samples: Float32Array }
  pop(): void
  flush(): void
  reset(): void
}

interface SherpaStream {
  acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void
}

export interface SherpaRecognizer {
  createStream(): SherpaStream
  decodeAsync(s: SherpaStream): Promise<{ text: string; lang?: string }>
}

interface SherpaModule {
  Vad: new (config: Record<string, unknown>, bufferSizeInSeconds: number) => SherpaVad
  OfflineRecognizer: { createAsync(config: Record<string, unknown>): Promise<SherpaRecognizer> }
  version?: string
}

let mod: SherpaModule | null = null

/** The addon, loaded on first use (a missing or broken native module becomes `stt_unavailable`, not a crash). */
export function sherpa(): SherpaModule {
  // The bundled process is CommonJS (a plain require keeps the native package external); vitest runs this as ESM.
  const req = typeof require === 'function' ? require : createRequire(import.meta.url)
  mod ??= req('sherpa-onnx-node') as SherpaModule
  return mod
}

export class ModelFilesMissing extends Error {
  override readonly name = 'ModelFilesMissing'
}

function pick(dir: string, names: string[]): string {
  for (const n of names) {
    const p = path.join(dir, n)
    if (fs.existsSync(p)) return p
  }
  throw new ModelFilesMissing(`missing ${names[0]}`)
}

function pickPattern(dir: string, re: RegExp): string {
  const hit = fs.readdirSync(dir).filter((n) => re.test(n)).sort()[0]
  if (!hit) throw new ModelFilesMissing(`missing ${re.source}`)
  return path.join(dir, hit)
}

/** sherpa `modelConfig` for a model directory (research 05 §2.2 and the validated bench configs). */
export function modelConfig(family: ModelEntry['family'], dir: string, lang: string, threads: number): Record<string, unknown> {
  if (!fs.existsSync(dir)) throw new ModelFilesMissing(`missing model directory`)
  const common = { numThreads: threads, provider: 'cpu', debug: 0 }
  switch (family) {
    case 'nemo-transducer':
      return {
        ...common,
        transducer: {
          encoder: pick(dir, ['encoder.int8.onnx', 'encoder.onnx']),
          decoder: pick(dir, ['decoder.int8.onnx', 'decoder.onnx']),
          joiner: pick(dir, ['joiner.int8.onnx', 'joiner.onnx'])
        },
        tokens: pick(dir, ['tokens.txt']),
        modelType: 'nemo_transducer'
      }
    case 'moonshine': {
      const tokens = pick(dir, ['tokens.txt'])
      // v2 (2026 builds): encoder + merged decoder; v1: four separate graphs.
      if (fs.existsSync(path.join(dir, 'encoder_model.ort')) || fs.existsSync(path.join(dir, 'encoder_model.onnx')))
        return {
          ...common,
          moonshine: { encoder: pick(dir, ['encoder_model.ort', 'encoder_model.onnx']), mergedDecoder: pick(dir, ['decoder_model_merged.ort', 'decoder_model_merged.onnx']) },
          tokens
        }
      return {
        ...common,
        moonshine: {
          preprocessor: pick(dir, ['preprocess.onnx']),
          encoder: pick(dir, ['encode.int8.onnx', 'encode.onnx']),
          uncachedDecoder: pick(dir, ['uncached_decode.int8.onnx', 'uncached_decode.onnx']),
          cachedDecoder: pick(dir, ['cached_decode.int8.onnx', 'cached_decode.onnx'])
        },
        tokens
      }
    }
    case 'sense-voice':
      return {
        ...common,
        senseVoice: { model: pick(dir, ['model.int8.onnx', 'model.onnx']), language: lang === 'auto' ? 'auto' : lang, useInverseTextNormalization: 1 },
        tokens: pick(dir, ['tokens.txt'])
      }
    case 'whisper':
      return {
        ...common,
        whisper: { encoder: pickPattern(dir, /-encoder\.int8\.onnx$/), decoder: pickPattern(dir, /-decoder\.int8\.onnx$/), language: lang === 'auto' ? '' : lang, task: 'transcribe' },
        tokens: pickPattern(dir, /-tokens\.txt$/)
      }
  }
}

export async function createRecognizer(family: ModelEntry['family'], dir: string, lang: string, threads: number): Promise<SherpaRecognizer> {
  return sherpa().OfflineRecognizer.createAsync({ featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 }, modelConfig: modelConfig(family, dir, lang, threads) })
}

export async function decode(rec: SherpaRecognizer, samples: Float32Array): Promise<string> {
  const s = rec.createStream()
  s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
  const r = await rec.decodeAsync(s)
  return (r.text ?? '').trim()
}

export interface VadConfig {
  model: string
  threshold: number
  /** First-stage segmentation silence (seconds). */
  minSilence: number
}

/** Silero VAD with research 05's validated settings (window 512, min speech 0.25 s, max segment 25 s). */
export function createVad(c: VadConfig): VadLike {
  const v = new (sherpa().Vad)(
    {
      sileroVad: { model: c.model, threshold: c.threshold, minSilenceDuration: c.minSilence, minSpeechDuration: 0.25, maxSpeechDuration: 25, windowSize: VAD_WINDOW },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
      provider: 'cpu',
      debug: 0
    },
    30
  )
  return {
    acceptWaveform: (s) => v.acceptWaveform(s),
    isDetected: () => v.isDetected(),
    isEmpty: () => v.isEmpty(),
    front: () => v.front(false),
    pop: () => v.pop(),
    flush: () => v.flush(),
    reset: () => v.reset()
  }
}
