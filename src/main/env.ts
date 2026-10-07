/**
 * Test-mode switches of the desktop shell (05 §4, 07 B10). Every VESPER_* switch is read only through `testEnv()`,
 * which returns null unless the build has `__VESPER_TEST__` AND the process runs with VESPER_TEST=1 — so in the
 * release build the whole object is dead code and no environment variable can change the app's behaviour.
 * The parsers are pure (unit-tested in tests/unit/main/env.test.ts).
 */

export interface Size {
  width: number
  height: number
}

export type WindowPos = { kind: 'point'; x: number; y: number } | { kind: 'corner' }

export interface TestEnv {
  /** Roaming data dir (Electron userData) instead of %APPDATA%\Vesper. */
  dataDir: string | null
  /** Local data dir instead of %LOCALAPPDATA%\Vesper. */
  localDir: string | null
  /** Loopback port (0 = random). */
  port: number | null
  windowSize: Size | null
  windowPos: WindowPos | null
  clickThrough: boolean
  /** Fixed clock (ms since epoch). */
  fakeNow: number | null
  /** WAV file fed to getUserMedia through Chromium's fake capture device. */
  fakeMic: string | null
  /** Window audio muted (default in test mode; VESPER_MUTE=0 turns it off). */
  mute: boolean
  /** Button index (or label) given to native dialogs instead of showing them (default: the cancel button). */
  dialogAnswer: string | null
}

type Env = Record<string, string | undefined>

/** `1440x900` → size; anything else → null. */
export function parseSize(raw: string | undefined): Size | null {
  const m = raw?.trim().match(/^(\d{2,5})x(\d{2,5})$/)
  if (!m) return null
  const width = Number(m[1])
  const height = Number(m[2])
  return width > 0 && height > 0 ? { width, height } : null
}

/** `x,y` (may be negative: displays left of / above the primary) or `corner`. */
export function parseWindowPos(raw: string | undefined): WindowPos | null {
  const v = raw?.trim()
  if (!v) return null
  if (v === 'corner') return { kind: 'corner' }
  const m = v.match(/^(-?\d{1,6}),(-?\d{1,6})$/)
  return m ? { kind: 'point', x: Number(m[1]), y: Number(m[2]) } : null
}

/** A TCP port, 0 meaning "any free port". */
export function parsePort(raw: string | undefined): number | null {
  if (raw == null || !/^\d{1,5}$/.test(raw.trim())) return null
  const n = Number(raw.trim())
  return n <= 65535 ? n : null
}

export function parseFakeNow(raw: string | undefined): number | null {
  if (raw == null || !/^\d{1,15}$/.test(raw.trim())) return null
  return Number(raw.trim())
}

/** The switches as given in `env` (assumes test mode is already established). */
export function parseTestEnv(env: Env): TestEnv {
  const nonEmpty = (v: string | undefined): string | null => (v && v.trim() ? v.trim() : null)
  return {
    dataDir: nonEmpty(env.VESPER_DATA_DIR),
    localDir: nonEmpty(env.VESPER_LOCAL_DIR),
    port: parsePort(env.VESPER_PORT),
    windowSize: parseSize(env.VESPER_WINDOW_SIZE),
    windowPos: parseWindowPos(env.VESPER_WINDOW_POS),
    clickThrough: env.VESPER_CLICK_THROUGH === '1',
    fakeNow: parseFakeNow(env.VESPER_FAKE_NOW),
    fakeMic: nonEmpty(env.VESPER_FAKE_MIC),
    mute: env.VESPER_MUTE !== '0',
    dialogAnswer: nonEmpty(env.VESPER_DIALOG_ANSWER)
  }
}

let cached: TestEnv | null | undefined

/** The test switches, or null outside test builds / test mode. */
export function testEnv(): TestEnv | null {
  if (cached !== undefined) return cached
  cached = __VESPER_TEST__ && process.env.VESPER_TEST === '1' ? parseTestEnv(process.env) : null
  return cached
}

export function isTestMode(): boolean {
  return testEnv() !== null
}
