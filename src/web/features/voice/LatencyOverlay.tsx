/**
 * Dev overlay for voice latency (07 D6), test builds only: one row per recent reply with the server's marks and the
 * client's. Mounted into its own root by install.ts when enabled; never part of the release build.
 */
import { useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { latencyRows, latencyVersion, subscribeLatency } from './latency'
import './latency.css'

const ORDER = ['received', 'thinking', 'firstText', 'writing', 'speechOpen', 'firstAudioSent', 'firstChunk', 'firstAudio', 'done']

/** Marks are ms since the turn arrived; absolute epoch values (some server marks) are shown relative to the first. */
function fmt(marks: Record<string, number>): Array<[string, number]> {
  const abs = Object.values(marks).filter((v) => v > 1e11)
  const base = abs.length ? Math.min(...abs) : 0
  const rel = Object.entries(marks).map(([k, v]): [string, number] => [k, v > 1e11 ? Math.round(v - base) : Math.round(v)])
  return rel.sort((a, b) => {
    const ia = ORDER.indexOf(a[0])
    const ib = ORDER.indexOf(b[0])
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a[1] - b[1]
  })
}

export function LatencyOverlay({ onClose }: { onClose: () => void }): ReactNode {
  const v = useSyncExternalStore(subscribeLatency, latencyVersion, latencyVersion)
  const snapshot = useMemo(() => (v >= 0 ? latencyRows() : []), [v])
  return (
    <section className="latency" aria-label="Voice latency marks" data-testid="latency-overlay">
      <header className="latency__head">
        <h2>Voice latency</h2>
        <button type="button" className="latency__close" aria-label="Close latency marks" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      {snapshot.length === 0 ? (
        <p className="latency__empty">No replies yet. Send a message with voice on.</p>
      ) : (
        <ol className="latency__rows">
          {snapshot.map((r) => (
            <li key={r.replyId}>
              <span className="latency__id mono">{r.replyId.slice(0, 10)}</span>
              <span className="latency__marks">
                {fmt(r.server).map(([k, v]) => (
                  <span key={`s${k}`} className="latency__mark">
                    {k} <b className="tabular">{v}</b>
                  </span>
                ))}
                {fmt(r.client).map(([k, v]) => (
                  <span key={`c${k}`} className="latency__mark is-client">
                    {k} <b className="tabular">+{v}</b>
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
