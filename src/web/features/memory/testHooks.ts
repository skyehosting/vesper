/**
 * Test hooks (`__vesperTest.memoryUi`, test builds only — 07 B10): resource counters for the leak checks — live
 * WS listeners and acquired live stores, object URLs, import-preview workers — which return to their baseline when
 * the memory/privacy/data pages are closed; and `runCommand(text, sessionUid)` to drive slash commands without the
 * composer (chat-ui's).
 */
import { toast } from '../../components/Toast'
import { api } from '../../lib/api'
import { runCommand } from '../../lib/commands/registry'
import { navigate } from '../../lib/router'
import { registerTestHooks } from '../../lib/testHooks'
import { ws } from '../../lib/ws'
import { blobUrlsLive } from './download'
import { liveStats } from './live'
import { previewWorkersLive } from '../privacy/importPreview'

if (__VESPER_TEST__) {
  registerTestHooks('memoryUi', {
    stats: () => ({ ...liveStats(), blobUrls: blobUrlsLive(), previewWorkers: previewWorkersLive() }),
    runCommand: (text: string, sessionUid: string | null) => runCommand(text, { sessionUid, navigate, api, ws, toast, setDraft: () => undefined })
  })
}
