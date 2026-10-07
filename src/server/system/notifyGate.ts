/**
 * Holds desktop notifications while game mode is on (07 D3) and delivers them, summarised, when it ends. It wraps
 * `ctx.platform.notify` (every server module notifies through it), so callers need no game-mode awareness. The held
 * list is bounded; `close()` drops what is held and puts the original function back.
 */
import type { Platform } from '../platform'

/** At most this many notifications are kept while held (the summary still counts every one). */
export const MAX_HELD = 50

export interface NotifyGate {
  hold(on: boolean): void
  readonly held: number
  close(): void
}

export function installNotifyGate(platform: Platform): NotifyGate {
  const original = platform.notify
  const deliver = (title: string, body: string) => original.call(platform, title, body)
  let holding = false
  let held: { title: string; body: string }[] = []
  let count = 0
  let closed = false

  platform.notify = (title, body) => {
    if (!holding) return deliver(title, body)
    count++
    if (held.length < MAX_HELD) held.push({ title: String(title), body: String(body) })
  }

  const flush = () => {
    const list = held
    const n = count
    held = []
    count = 0
    if (!n) return
    if (n === 1 && list[0]) return deliver(list[0].title, list[0].body)
    const titles = [...new Set(list.map((x) => x.title))]
    const shown = titles.slice(0, 3).join(' · ')
    deliver(`${n} notifications while you were playing`, titles.length > 3 ? `${shown} · and ${titles.length - 3} more` : shown)
  }

  return {
    hold(on) {
      if (closed || on === holding) return
      holding = on
      if (!on) flush()
    },
    get held() {
      return count
    },
    close() {
      if (closed) return
      closed = true
      // Quitting mid-game: held notifications are dropped (a burst of popups at exit would help nobody).
      holding = false
      held = []
      count = 0
      platform.notify = original
    }
  }
}
