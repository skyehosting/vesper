/**
 * Global push-to-talk hotkey (07 D6, opt-in: `voice.globalHotkey`, default null). The main process registers the
 * accelerator with Electron's globalShortcut while it is set and hands every press to the server, which relays
 * `hotkey.ptt` to the focused (else last used) desktop client (src/server/system). globalShortcut reports presses
 * only (no key-up), so the hotkey TOGGLES, as 07 D6 specifies. Pure logic with an injectable shortcut API, so tests
 * never grab a real system-wide key (tests/unit/main/hotkey.test.ts).
 *
 * F73: a press needs a loaded desktop window. While the hotkey is registered the shell keeps its hidden window loaded
 * in the tray (`active(true)`: no warm-destroy, 07 D2) and loads one, hidden, when there is none (`wake()`: a "Start
 * with Windows" launch never opens a window). A press that still finds no desktop client wakes the window and is
 * queued until its client connects; a second press meanwhile cancels it (toggle). Only if that fails does the owner get
 * a native notification (throttled) — never a silent drop.
 */

/** The part of Electron's globalShortcut this module uses. */
export interface ShortcutApi {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

const MODIFIERS = new Set(['command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl', 'alt', 'option', 'altgr', 'shift', 'super', 'meta'])
const NAMED_KEYS = new Set([
  'plus', 'space', 'tab', 'capslock', 'numlock', 'scrolllock', 'backspace', 'delete', 'insert', 'return', 'enter', 'up', 'down', 'left', 'right',
  'home', 'end', 'pageup', 'pagedown', 'escape', 'esc', 'printscreen', 'pause',
  'volumeup', 'volumedown', 'volumemute', 'medianexttrack', 'mediaprevioustrack', 'mediastop', 'mediaplaypause',
  'numdec', 'numadd', 'numsub', 'nummult', 'numdiv'
])

/** A key that may be used without a modifier (it types nothing): F1–F24, media keys, Pause, ScrollLock. */
function bareAllowed(key: string): boolean {
  return /^f([1-9]|1\d|2[0-4])$/.test(key) || /^media|^volume/.test(key) || key === 'pause' || key === 'scrolllock'
}

/**
 * Electron accelerator syntax ("Ctrl+Shift+Space", "F13"), strictly: modifiers + exactly one key, no repeats. A bare
 * key is accepted only when it types nothing (F-keys, media keys) — a global "A" would eat every typed A.
 */
export function isValidAccelerator(raw: string | null | undefined): boolean {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 40) return false
  const parts = raw.split('+').map((p) => p.trim().toLowerCase())
  // "Ctrl++" (the plus key) is spelled "Plus" in Electron.
  if (parts.some((p) => !p)) return false
  const key = parts[parts.length - 1]
  const mods = parts.slice(0, -1)
  if (mods.some((m) => !MODIFIERS.has(m)) || new Set(mods).size !== mods.length) return false
  const isKey = /^[a-z0-9]$/.test(key) || /^f([1-9]|1\d|2[0-4])$/.test(key) || /^num[0-9]$/.test(key) || NAMED_KEYS.has(key) || /^[`\-=[\]\\;',./)!@#$%^&*(:<>_|"{}~?]$/.test(key)
  if (!isKey || MODIFIERS.has(key)) return false
  return mods.length > 0 || bareAllowed(key)
}

export type HotkeyStatus = 'off' | 'registered' | 'invalid' | 'taken'

export class GlobalHotkey {
  private current: string | null = null

  constructor(
    private readonly api: ShortcutApi,
    private readonly onPress: () => void
  ) {}

  /** The registered accelerator, or null. */
  get accelerator(): string | null {
    return this.current
  }

  /** Register `accel` (null = none), replacing the previous one. 'taken' = another app owns it. */
  set(accel: string | null): HotkeyStatus {
    const next = accel?.trim() || null
    if (next === this.current) return next ? 'registered' : 'off'
    this.clear()
    if (!next) return 'off'
    if (!isValidAccelerator(next)) return 'invalid'
    let ok = false
    try {
      ok = this.api.register(next, () => this.onPress())
    } catch {
      return 'invalid'
    }
    if (!ok) return 'taken'
    this.current = next
    return 'registered'
  }

  clear(): void {
    if (!this.current) return
    try {
      this.api.unregister(this.current)
    } catch {
      /* already gone */
    }
    this.current = null
  }
}

export interface HotkeyDeps {
  api: ShortcutApi
  /** Current `voice.globalHotkey`. */
  setting(): string | null
  /** Subscribe to voice settings changes; returns an unsubscribe. */
  subscribe(fn: () => void): () => void
  /** Deliver a press (server relay); false when no desktop client took it. */
  press(): boolean
  /** Tell the owner something about the hotkey (a toast on the desktop client). */
  notice(text: string): void
  /** The hotkey is (or is no longer) registered: the shell keeps its window loaded while it is (F73). */
  active?(on: boolean): void
  /** A press found no Vesper window to deliver to: tell the owner outside the app (a native notification). */
  unavailable?(text: string): void
  /**
   * Make sure a Vesper window is loaded (created hidden if there is none); resolves true once it has loaded, false if
   * it cannot be (quitting, still starting, load failed). Called when the hotkey is registered and on a press that
   * found no desktop client (F73).
   */
  wake?(): Promise<boolean>
  /** Timers for retrying a queued press while the woken window's client connects. */
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
  /** Clock for throttling `unavailable` (ms). */
  now?(): number
  log(msg: string): void
}

/** At most one "no window" notification per this long, however often the key is pressed. */
export const UNAVAILABLE_NOTICE_EVERY_MS = 60_000

/** A queued press is retried this often while the woken window's client connects… */
export const PRESS_RETRY_MS = 250
/** …this many times (10 s) before the owner is told. */
export const PRESS_RETRIES = 40

const NO_WINDOW = 'Open Vesper once from the tray, then push-to-talk works while it stays in the tray.'
const NOT_READY = "Vesper's window didn't load in time for push-to-talk. Open it from the tray and try again."

/** Keep the registration in line with the setting; returns the disposer (unregisters). */
export function installGlobalHotkey(d: HotkeyDeps): () => void {
  let lastNotice = Number.NEGATIVE_INFINITY
  const tell = (text: string): void => {
    const now = d.now?.() ?? Date.now()
    if (now - lastNotice < UNAVAILABLE_NOTICE_EVERY_MS) return
    lastNotice = now
    d.unavailable?.(text)
  }
  // A press waiting for a woken window (one at most); `gen` invalidates callbacks of a cancelled one.
  let queued = false
  let gen = 0
  let retry: unknown = null
  const dropQueued = (): void => {
    queued = false
    gen++
    if (retry !== null) d.clearTimer?.(retry)
    retry = null
  }
  const deliverWhenReady = (my: number): void => {
    let left = PRESS_RETRIES
    const attempt = (): void => {
      retry = null
      if (my !== gen) return
      if (d.press()) {
        dropQueued()
        d.log('queued push-to-talk press delivered')
        return
      }
      if (--left <= 0 || !d.setTimer) {
        dropQueued()
        d.log('push-to-talk: the woken window never connected')
        tell(NOT_READY)
        return
      }
      retry = d.setTimer(attempt, PRESS_RETRY_MS)
    }
    attempt()
  }
  const hk = new GlobalHotkey(d.api, () => {
    if (queued) {
      // Pressed again before the window could take the first press: that was "talk" then "send" with nothing said.
      dropQueued()
      d.log('push-to-talk pressed again while Vesper was loading: queued press cancelled')
      return
    }
    if (d.press()) return
    if (!d.wake) {
      d.log('push-to-talk hotkey pressed with no Vesper window open')
      tell(NO_WINDOW)
      return
    }
    d.log('push-to-talk hotkey pressed with no Vesper window loaded: loading it')
    queued = true
    const my = ++gen
    const failed = (): void => {
      if (my !== gen) return
      dropQueued()
      tell(NO_WINDOW)
    }
    d.wake().then((ok) => (ok ? my === gen && deliverWhenReady(my) : failed()), failed)
  })
  let lastWanted: string | null | undefined
  let on = false
  const setActive = (next: boolean): void => {
    if (next === on) return
    on = next
    d.active?.(next)
    // Load the window now (hidden), so a press in the middle of a game finds it (F73).
    if (next) d.wake?.().catch(() => undefined)
  }
  const apply = (): void => {
    const want = d.setting()?.trim() || null
    // Other voice settings changed: nothing to do (and nothing to report again).
    if (want === lastWanted) return
    lastWanted = want
    dropQueued()
    const status = hk.set(want)
    setActive(status === 'registered')
    if (status === 'registered' || status === 'off') {
      d.log(`global push-to-talk hotkey ${status === 'off' ? 'off' : 'registered'}`)
      return
    }
    d.log(`global push-to-talk hotkey ${status}`)
    d.notice(status === 'taken' ? `Another app already uses ${want} as a shortcut. Pick a different push-to-talk key.` : `"${want}" isn't a key combination Vesper can use for push-to-talk.`)
  }
  apply()
  const off = d.subscribe(apply)
  return () => {
    off()
    dropQueued()
    hk.clear()
    setActive(false)
  }
}
