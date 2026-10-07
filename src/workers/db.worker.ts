/**
 * db.worker (07 C9–C11): a worker_thread inside the main process with its own node:sqlite connection to vesper.db.
 * It hosts the memory Engine (src/server/memory/engine) — vectors, vector_bits, the embed queue and every Voyage
 * call (VoyageScheduler), memory searches over the bit index, FTS maintenance, and bulk jobs (export / import /
 * purge / backup / re-index). The message protocol is documented in src/server/memory/engine/protocol.ts.
 */
import { parentPort } from 'node:worker_threads'
import { Engine } from '../server/memory/engine/engine'
import type { MainToWorker, WorkerToMain } from '../server/memory/engine/protocol'

const port = parentPort
if (port) {
  const engine = new Engine((m: WorkerToMain) => port.postMessage(m))
  port.on('message', (m: MainToWorker) => engine.handle(m))
}
