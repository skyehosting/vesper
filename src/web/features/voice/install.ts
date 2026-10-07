/**
 * installVoiceClient() — the voice client's page-lifetime wiring, loaded lazily right after boot (app/boot.ts) so the
 * audio core stays out of the startup bundle: the speech client (synced reveal, barge-in, unlock), the desktop's
 * push-to-talk hotkey, and in test builds the `__vesperTest.voice` hooks and the latency overlay (07 D6).
 */
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getAudioEngine } from '../../lib/audio'
import { registerTestHooks } from '../../lib/testHooks'
import { useStore } from '../../lib/store'
import { ws } from '../../lib/ws'
import { earconNodes } from './earcon'
import { installLatencyMarks, latencyRows } from './latency'
import { activeMicMode, cancelMic, finishMic, micEvents, micSessionStats, simulateMicEnvironment, startMic } from './micSession'
import { voicePrefsListeners } from './prefs'
import { playerStats } from './settings/players'
import { expectSpeech, installSpeechClient, interruptSpeech, speakAgain, speechCancels, speechClientStats, speechFailures, wantSpeech } from './speechClient'

let installed = false

export function installVoiceClient(): void {
  if (installed) return
  installed = true
  installSpeechClient()
  wireHotkey()
  if (__VESPER_TEST__) installVoiceTestHooks()
}

/**
 * The desktop's global push-to-talk hotkey (07 D6, opt-in; main sends `hotkey.ptt {down}`, alternating per press).
 * Down starts push-to-talk in the open chat, up sends.
 */
function wireHotkey(): void {
  ws.on('hotkey.ptt', (msg) => {
    const sessionUid = useStore.getState().activeSessionUid
    if (msg.down) {
      if (!sessionUid || activeMicMode()) return
      startMic({ mode: 'ptt', sessionUid })
    } else if (activeMicMode() === 'ptt') finishMic('released')
  })
}

// ── test builds ───────────────────────────────────────────────────────────────────────────────

let overlayRoot: Root | null = null
let overlayEl: HTMLElement | null = null

async function setLatencyOverlay(on: boolean): Promise<void> {
  if (!__VESPER_TEST__) return
  if (!on) {
    overlayRoot?.unmount()
    overlayEl?.remove()
    overlayRoot = null
    overlayEl = null
    return
  }
  if (overlayRoot) return
  const { LatencyOverlay } = await import('./LatencyOverlay')
  overlayEl = document.createElement('div')
  overlayEl.dataset.voiceLatency = ''
  document.body.append(overlayEl)
  overlayRoot = createRoot(overlayEl)
  overlayRoot.render(createElement(LatencyOverlay, { onClose: () => void setLatencyOverlay(false) }))
}

function installVoiceTestHooks(): void {
  if (!__VESPER_TEST__) return
  installLatencyMarks()
  // Ctrl+Alt+L toggles the latency overlay (test builds only).
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && (e.key === 'l' || e.key === 'L')) void setLatencyOverlay(!overlayRoot)
  })
  registerTestHooks('voice', {
    state: () => useStore.getState().voice,
    speech: (replyId: string) => useStore.getState().speech[replyId] ?? null,
    speechIds: () => Object.keys(useStore.getState().speech),
    replays: () => useStore.getState().replays,
    wantSpeech: () => wantSpeech(),
    expect: (replyId: string) => expectSpeech(replyId),
    interrupt: () => interruptSpeech(),
    speakAgain: (messageUid: string) => speakAgain(messageUid),
    failures: () => speechFailures(),
    cancels: () => speechCancels(),
    /** Every counter the voice client owns; all back to baseline when idle (07 D14). */
    stats: () => ({
      speech: speechClientStats(),
      mic: micSessionStats(),
      prefsListeners: voicePrefsListeners(),
      earconNodes: earconNodes(),
      players: playerStats(),
      engine: getAudioEngine().stats()
    }),
    /** Pretend the page is not a secure context (07 D8 "needs HTTPS" e2e without a LAN listener). */
    simulateInsecure: (on: boolean) => simulateMicEnvironment(on ? { isSecureContext: false, hasGetUserMedia: false, hasAudioWorklet: false } : null),
    cancelMic: () => cancelMic(),
    micEvents: () => micEvents(),
    latency: (on: boolean) => setLatencyOverlay(on),
    latencyRows: () => latencyRows()
  })
}
