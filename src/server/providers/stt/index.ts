/**
 * Builds the voice-in services for a ServerContext: the model manager, SttServiceImpl and the 'stt' ProviderTester.
 * Test-build switches (07 B10, 05 §5), all read through testEnv():
 *   VESPER_STT_FAKE=1          scripted recognizer + the real bundled Silero VAD (no model needed)
 *   VESPER_STT_FAKE_TEXT=a|b   the scripted transcripts (default: what tests/fixtures/audio/hello.wav says)
 *   VESPER_STT_MODEL_DIR       pre-extracted real models (by archive directory name) count as installed
 *   VESPER_STT_TEST_CATALOG    a JSON file of extra catalogue entries (the mock GitHub server's archives)
 *   VESPER_STT_IDLE_MS         idle unload delay instead of `voice.stt.unloadAfterMin`
 *   VESPER_MOCK_BASE           cloud providers and model downloads go to the mock server's origin
 */
import fs from 'node:fs'
import path from 'node:path'
import { STT_MODELS, type ModelEntry } from '@shared/models'
import { coreOf } from '../../core'
import { ModelManager } from '../../models/manager'
import type { ServerContext } from '../../services'
import { testEnv } from '../../testMode'
import { SttServiceImpl } from './service'
import { createSttTester } from './tester'

const impls = new WeakMap<ServerContext, SttServiceImpl>()

/** The concrete service (WS handler, routes and tests need more than the SttService interface). */
export function sttImpl(ctx: ServerContext): SttServiceImpl | null {
  return impls.get(ctx) ?? null
}

function testCatalogue(): ModelEntry[] {
  const file = testEnv('VESPER_STT_TEST_CATALOG')
  if (!file) return []
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8')) as ModelEntry[]
    return Array.isArray(list) ? list.filter((e) => typeof e?.id === 'string' && Array.isArray(e.files)) : []
  } catch {
    return []
  }
}

export function createStt(ctx: ServerContext): SttServiceImpl {
  const log = ctx.log.child('stt')
  const mock = testEnv('VESPER_MOCK_BASE')
  const modelDir = testEnv('VESPER_STT_MODEL_DIR')
  const idle = Number(testEnv('VESPER_STT_IDLE_MS') ?? NaN)
  const manager = new ModelManager({
    dir: ctx.paths.models,
    catalogue: [...STT_MODELS, ...testCatalogue()],
    log: log.child('models'),
    emit: (p) => ctx.hub.broadcast(p),
    externalDirs: modelDir ? [modelDir] : [],
    allowedOrigins: mock ? [new URL(mock).origin] : []
  })
  const script = path.join(coreOf(ctx).opts.workersDir, 'stt.process.js')
  const svc = new SttServiceImpl({
    settings: ctx.settings,
    secrets: ctx.secrets,
    log,
    now: () => ctx.clock.now(),
    manager,
    fork: () => ctx.platform.forkWorker(script, [], { name: 'Speech recognition' }),
    vadModel: path.join(ctx.platform.resourcesDir, 'models', 'silero_vad.onnx'),
    fake: testEnv('VESPER_STT_FAKE') === '1' ? { texts: testEnv('VESPER_STT_FAKE_TEXT')?.split('|') } : null,
    ...(Number.isFinite(idle) ? { idleUnloadMs: idle } : {})
  })
  impls.set(ctx, svc)
  ctx.services.stt = svc
  ctx.services.testers.stt = createSttTester({ secrets: ctx.secrets, settings: ctx.settings, manager })
  ctx.onClose(() => svc.close())
  return svc
}
