/**
 * Memory (R7–R10; 07 C9–C13, B7, B9, A4). Public surface for other modules:
 *   createMemoryService / memoryOf(ctx)  — the service and its extras (UI search, backfill, manifest, forget, jobs)
 *   untrusted / formatHits               — the 07 B7 renderer for recalled / attachment / recap text
 *   JobSpec / JobResult                  — the db.worker bulk-job protocol (export / import / purge / backup / …)
 */
export { createMemoryService, memoryOf, snippetOf, AUTO_RECALL_BUDGET_MS, SEARCH_BUDGET_MS, type MemoryServiceImpl, type MemoryServiceOptions } from './service'
export { untrusted, neutralize, wrapBlock, formatHits, formatManifest, MEMORY_PREAMBLE } from './format'
export type { JobSpec, JobResult, ExportJobSpec, ImportJobSpec, BackfillEstimate, WorkerStatus } from './engine/protocol'
export type { FactsApi } from './facts'
