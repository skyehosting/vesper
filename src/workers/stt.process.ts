/**
 * The speech-to-text utility process (07 C17, research 05 §4.1): sherpa-onnx (Silero VAD + one offline recognizer)
 * isolated from the server, so a native crash, a 0.7 GB model and onnxruntime's DLL stay out of the main process.
 * Runs as an Electron utilityProcess (packaged and dev) or a Node child (standalone server, tests); the protocol lives
 * in src/server/providers/stt/protocol.ts and the logic in ./engine. Unloading = exiting: native memory is only
 * reliably returned to the OS when the process ends.
 */
import { SttEngine, fakeRecognizer } from '@server/providers/stt/engine'
import type { FromProcess, ToProcess } from '@server/providers/stt/protocol'
import { createRecognizer, createVad, decode } from '@server/providers/stt/sherpa'
import { onParentMessage } from './parentPort'

interface UtilityParentPort {
  postMessage(m: unknown): void
}

const parentPort = (process as unknown as { parentPort?: UtilityParentPort }).parentPort

function send(m: FromProcess): void {
  if (parentPort) parentPort.postMessage(m)
  else process.send?.(m as Parameters<NonNullable<typeof process.send>>[0])
}

let exiting = false
function exitSoon(code: number): void {
  if (exiting) return
  exiting = true
  // Let the last message flush through the IPC channel; the server kills the process if this never happens.
  setTimeout(() => process.exit(code), 50)
}

const engine = new SttEngine({
  post(m) {
    send(m)
    if (m.t === 'unloaded') exitSoon(0)
  },
  createVad,
  async createRecognizer(spec) {
    if (__VESPER_TEST__ && spec.fake) return fakeRecognizer(spec.fakeTexts)
    if (!spec.model) return null
    const rec = await createRecognizer(spec.model.family, spec.model.dir, spec.lang, spec.threads)
    return { decode: (samples) => decode(rec, samples) }
  },
  rssMB: () => Math.round(process.memoryUsage().rss / 1e6)
})

onParentMessage((m) => {
  if (typeof m === 'object' && m !== null && typeof (m as { t?: unknown }).t === 'string') engine.handle(m as ToProcess)
})

// A Node child whose parent died loses its IPC channel: nothing can reach it any more.
if (!parentPort) process.on('disconnect', () => exitSoon(0))

send({ t: 'hello', pid: process.pid })
