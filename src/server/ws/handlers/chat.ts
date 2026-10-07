/**
 * chat.* handlers + ctx.services.chat: the production chat engine (src/server/chat/engine.ts) and the LLM provider
 * tester used by the wizard (ctx.services.testers.llm). The engine reads memory/speech lazily at call time.
 * Phase 3 (engine-int): key checks on save for llm:* / stt:* secrets, and the Talk-mode recall prefetch.
 */
import { createChatEngine, type EngineOptions } from '../../chat/engine'
import { registerKeyChecks } from '../../chat/keys'
import { wireRecallPrefetch } from '../../chat/prefetch'
import { createLlmTester } from '../../providers/llm/tester'
import type { ServerContext } from '../../services'
import { testEnv } from '../../testMode'

/** Test builds only (07 B10): shorter engine timings so idle work is testable. */
function testOptions(): EngineOptions {
  const o: EngineOptions = {}
  if (!__VESPER_TEST__) return o
  const n = (name: `VESPER_${string}`): number | undefined => {
    const v = Number(testEnv(name))
    return Number.isFinite(v) && v >= 0 ? v : undefined
  }
  o.summaryIdleMs = n('VESPER_CHAT_SUMMARY_IDLE_MS')
  o.retryDelayMs = n('VESPER_CHAT_RETRY_MS')
  o.saveRetryMs = n('VESPER_CHAT_SAVE_RETRY_MS')
  return o
}

export function register(ctx: ServerContext): void {
  const engine = createChatEngine(ctx, testOptions())
  ctx.services.chat = engine
  ctx.services.testers.llm = createLlmTester(ctx)
  ctx.onClose(() => engine.close())
  registerKeyChecks(ctx)
  // The STT service registers after this module (fixed handler order, 07 E1): wire to it once registration is done.
  queueMicrotask(() => {
    const prefetch = wireRecallPrefetch(ctx)
    ctx.onClose(() => prefetch.close())
  })
}
