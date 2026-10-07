/**
 * Global push-to-talk hotkey registration (07 D6) with a fake globalShortcut — no test ever grabs a real system-wide
 * key. Opt-in (null = nothing registered), strict accelerator syntax, replace on change, "taken" reported to the owner,
 * unregistered on dispose. @R19
 */
import { describe, expect, it } from 'vitest'
import { GlobalHotkey, installGlobalHotkey, isValidAccelerator, UNAVAILABLE_NOTICE_EVERY_MS, type ShortcutApi } from '../../../src/main/hotkey'

class FakeShortcuts implements ShortcutApi {
  readonly registered = new Map<string, () => void>()
  taken = new Set<string>()
  register(accel: string, cb: () => void): boolean {
    if (this.taken.has(accel) || this.registered.has(accel)) return false
    this.registered.set(accel, cb)
    return true
  }
  unregister(accel: string): void {
    this.registered.delete(accel)
  }
  press(accel: string): void {
    this.registered.get(accel)?.()
  }
}

describe('accelerators', () => {
  it('accepts modifier+key and bare keys that type nothing; refuses the rest', () => {
    for (const ok of ['Ctrl+Shift+Space', 'CommandOrControl+Alt+K', 'Alt+F1', 'F13', 'F24', 'Shift+Plus', 'Ctrl+num5', 'MediaPlayPause', 'Ctrl+`']) expect(isValidAccelerator(ok), ok).toBe(true)
    for (const bad of ['', '  ', 'A', 'Space', 'Ctrl+', 'Ctrl+Shift', 'Ctrl+Ctrl+A', 'Hyper+A', 'Ctrl+A+B', 'F25', 'Ctrl++', null, undefined, 'Ctrl+Alt+Shift+Super+Meta+Insert+X'])
      expect(isValidAccelerator(bad as string), String(bad)).toBe(false)
  })
})

describe('GlobalHotkey', () => {
  it('registers, replaces, reports taken/invalid, clears', () => {
    const api = new FakeShortcuts()
    let presses = 0
    const hk = new GlobalHotkey(api, () => presses++)
    expect(hk.set(null)).toBe('off')
    expect(api.registered.size).toBe(0)
    expect(hk.set('Ctrl+Shift+Space')).toBe('registered')
    api.press('Ctrl+Shift+Space')
    expect(presses).toBe(1)
    expect(hk.set('Ctrl+Shift+Space')).toBe('registered')
    expect(hk.set('F13')).toBe('registered')
    expect([...api.registered.keys()]).toEqual(['F13'])
    api.taken.add('Alt+K')
    expect(hk.set('Alt+K')).toBe('taken')
    expect(api.registered.size).toBe(0)
    expect(hk.accelerator).toBeNull()
    expect(hk.set('K')).toBe('invalid')
    expect(hk.set('F14')).toBe('registered')
    hk.clear()
    expect(api.registered.size).toBe(0)
  })

  it('follows the setting; tells the owner when another app holds the key; unregisters on dispose', () => {
    const api = new FakeShortcuts()
    let setting: string | null = null
    const subs = new Set<() => void>()
    const notices: string[] = []
    let delivered = 0
    let target = true
    const dispose = installGlobalHotkey({
      api,
      setting: () => setting,
      subscribe: (fn) => {
        subs.add(fn)
        return () => subs.delete(fn)
      },
      press: () => {
        delivered++
        return target
      },
      notice: (t) => notices.push(t),
      log: () => undefined
    })
    const change = () => subs.forEach((fn) => fn())
    // Default null: nothing is registered (opt-in).
    expect(api.registered.size).toBe(0)
    setting = 'Ctrl+Alt+Space'
    change()
    api.press('Ctrl+Alt+Space')
    expect(delivered).toBe(1)
    target = false
    api.press('Ctrl+Alt+Space')
    expect(delivered).toBe(2)
    // Unrelated voice changes don't re-register or re-notify.
    change()
    expect(notices).toEqual([])
    api.taken.add('Ctrl+Alt+V')
    setting = 'Ctrl+Alt+V'
    change()
    expect(notices[0]).toMatch(/Another app already uses Ctrl\+Alt\+V/)
    setting = 'Q'
    change()
    expect(notices[1]).toMatch(/isn't a key combination/)
    setting = 'F15'
    change()
    expect([...api.registered.keys()]).toEqual(['F15'])
    dispose()
    expect(api.registered.size).toBe(0)
    expect(subs.size).toBe(0)
  })
  it('F73: while registered the shell keeps its window loaded; a press with no window tells the owner (throttled)', () => {
    const api = new FakeShortcuts()
    let setting: string | null = null
    const subs = new Set<() => void>()
    const active: boolean[] = []
    const notes: string[] = []
    let now = 1_000_000
    const dispose = installGlobalHotkey({
      api,
      setting: () => setting,
      subscribe: (fn) => {
        subs.add(fn)
        return () => subs.delete(fn)
      },
      press: () => false,
      notice: () => undefined,
      active: (on) => active.push(on),
      unavailable: (t) => notes.push(t),
      now: () => now,
      log: () => undefined
    })
    const change = () => subs.forEach((fn) => fn())
    expect(active).toEqual([])
    setting = 'Ctrl+Alt+Space'
    change()
    expect(active).toEqual([true])
    // No window to take the press: not dropped silently, but not a notification per press either.
    api.press('Ctrl+Alt+Space')
    api.press('Ctrl+Alt+Space')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatch(/Open Vesper once/)
    now += UNAVAILABLE_NOTICE_EVERY_MS
    api.press('Ctrl+Alt+Space')
    expect(notes).toHaveLength(2)
    // A key another app holds is not registered: nothing to keep the window for.
    api.taken.add('Ctrl+Alt+V')
    setting = 'Ctrl+Alt+V'
    change()
    expect(active).toEqual([true, false])
    setting = 'F15'
    change()
    expect(active).toEqual([true, false, true])
    dispose()
    expect(active).toEqual([true, false, true, false])
  })
})

describe('F73: no window at all (Start with Windows → tray → game)', () => {
  function rig(o: { wakeOk?: boolean } = {}) {
    const api = new FakeShortcuts()
    const subs = new Set<() => void>()
    const notes: string[] = []
    const delivered: number[] = []
    let clients = 0
    let wakes = 0
    let resolveWake: ((ok: boolean) => void) | null = null
    const timers = new Map<number, () => void>()
    let seq = 0
    let now = 5_000_000
    const dispose = installGlobalHotkey({
      api,
      setting: () => 'Ctrl+Alt+Space',
      subscribe: (fn) => {
        subs.add(fn)
        return () => subs.delete(fn)
      },
      // The server relay: delivered only when a desktop client is connected.
      press: () => {
        if (!clients) return false
        delivered.push(now)
        return true
      },
      notice: () => undefined,
      active: () => undefined,
      unavailable: (t) => notes.push(t),
      wake: () => {
        wakes++
        return new Promise<boolean>((r) => {
          resolveWake = r
        })
      },
      setTimer: (fn) => {
        const id = ++seq
        timers.set(id, fn)
        return id
      },
      clearTimer: (h) => void timers.delete(h as number),
      now: () => now,
      log: () => undefined
    })
    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve()
    }
    return {
      api,
      notes,
      delivered,
      timers,
      dispose,
      get wakes() {
        return wakes
      },
      connect: () => void clients++,
      async wakeDone(ok = o.wakeOk ?? true) {
        resolveWake?.(ok)
        resolveWake = null
        await flush()
      },
      tick(ms: number) {
        now += ms
        for (const [id, fn] of [...timers]) {
          timers.delete(id)
          fn()
        }
      },
      press: () => api.press('Ctrl+Alt+Space')
    }
  }

  it('registering the hotkey loads the window (hidden) right away, so the first press finds it', async () => {
    const r = rig()
    // installGlobalHotkey registered the key from the setting: the shell is asked to load its window now.
    expect(r.wakes).toBe(1)
    await r.wakeDone()
    r.connect()
    r.press()
    expect(r.delivered).toHaveLength(1)
    expect(r.notes).toEqual([])
    r.dispose()
  })

  it('a press with no window loads one hidden and delivers the press once its desktop client connects', async () => {
    const r = rig()
    await r.wakeDone(false) // the proactive load failed (e.g. still starting): no window yet
    r.press()
    expect(r.wakes).toBe(2)
    expect(r.delivered).toEqual([])
    await r.wakeDone(true)
    // Loaded but the page's client is not connected yet: retried, not dropped.
    r.tick(250)
    r.tick(250)
    expect(r.delivered).toEqual([])
    r.connect()
    r.tick(250)
    expect(r.delivered).toHaveLength(1)
    expect(r.notes).toEqual([])
    expect(r.timers.size).toBe(0)
    r.dispose()
  })

  it('a second press while the window loads cancels the queued one (press to talk, press again to send)', async () => {
    const r = rig()
    await r.wakeDone(false)
    r.press()
    r.press()
    await r.wakeDone(true)
    r.connect()
    r.tick(250)
    expect(r.delivered).toEqual([])
    expect(r.timers.size).toBe(0)
    expect(r.notes).toEqual([])
    r.dispose()
  })

  it('the notification stays only as the fallback: the window cannot load, or its client never connects', async () => {
    const r = rig()
    await r.wakeDone(false)
    r.press()
    await r.wakeDone(false)
    expect(r.notes).toHaveLength(1)
    r.tick(UNAVAILABLE_NOTICE_EVERY_MS)
    r.press()
    await r.wakeDone(true)
    for (let i = 0; i < 100 && r.timers.size; i++) r.tick(250)
    expect(r.delivered).toEqual([])
    expect(r.notes).toHaveLength(2)
    expect(r.notes[1]).toMatch(/push-to-talk/i)
    r.dispose()
  })

  it('dispose drops a queued press and its timer', async () => {
    const r = rig()
    await r.wakeDone(false)
    r.press()
    await r.wakeDone(true)
    expect(r.timers.size).toBe(1)
    r.dispose()
    expect(r.timers.size).toBe(0)
  })
})
