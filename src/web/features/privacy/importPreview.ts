/** Run the import preview in a one-shot worker (terminated after its answer or after 60 s). */
import type { PreviewReply } from './importPreview.worker'

const TIMEOUT_MS = 60_000
let liveWorkers = 0

/** Preview workers alive (leak check: back to 0 after every preview). */
export function previewWorkersLive(): number {
  return liveWorkers
}

export function previewImport(file: File, signal?: AbortSignal): Promise<PreviewReply> {
  return new Promise((resolve) => {
    const w = new Worker(new URL('./importPreview.worker.ts', import.meta.url), { type: 'module', name: 'vesper-import-preview' })
    liveWorkers++
    let done = false
    const finish = (r: PreviewReply): void => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      w.terminate()
      liveWorkers--
      resolve(r)
    }
    const onAbort = (): void => finish({ ok: false, message: 'Cancelled.' })
    const timer = window.setTimeout(() => finish({ ok: false, message: 'Reading the file took too long.' }), TIMEOUT_MS)
    signal?.addEventListener('abort', onAbort, { once: true })
    w.onmessage = (e: MessageEvent<PreviewReply>) => finish(e.data)
    w.onerror = () => finish({ ok: false, message: 'The file could not be read.' })
    w.postMessage(file)
  })
}
