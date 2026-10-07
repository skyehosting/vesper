/**
 * "Pair '<device>' from <ip>?" (07 B16) — the desktop's answer to a redeemed LAN/Tailscale pairing code. Shows the
 * oldest waiting device; Allow / Deny post `/api/auth/devices/:id/approve`. Closing it (Esc, ×, "Decide later") only
 * hides the prompt: the device stays pending in Settings → Access & security until it is answered or expires
 * (10 minutes, server side). The countdown is local and approximate. Initial focus is on "Decide later", never on Allow.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ShieldAlert, X } from 'lucide-react'
import { Button } from '../../components/Button'
import { Dialog } from '../../components/Dialog'
import { toApiError } from '../../lib/errors.logic'
import { useStore } from '../../lib/store'
import { countdownWords, formatCountdown } from '../access/access.logic'
import { approveDevice } from '../access/data'
import { PENDING_TTL_MS } from '../login/login.logic'
import './devices.css'

export default function ApprovalDialog(): ReactNode {
  const queue = useStore((s) => s.pendingDevices)
  const head = queue[0]
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // Focus starts on the safe choice: the prompt arrives over WebSocket while the owner may be typing, and a stray
  // Enter or Space must never let a device in (F50). Allow takes a deliberate click or Tab.
  const laterRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const h = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(h)
  }, [])
  useEffect(() => setError(null), [head?.deviceId])

  const left = head ? head.atMs + PENDING_TTL_MS - now : 0
  useEffect(() => {
    if (head && left <= 0) useStore.getState().dropPendingDevice(head.deviceId)
  }, [head, left])

  if (!head) return null

  const answer = async (allow: boolean): Promise<void> => {
    setBusy(allow ? 'allow' : 'deny')
    setError(null)
    try {
      await approveDevice(head.deviceId, allow)
    } catch (e) {
      const err = toApiError(e)
      // Already answered elsewhere or expired: nothing left to decide.
      if (err.code === 'not_found' || err.code === 'conflict') return
      setError(err.message)
      useStore.getState().pushPendingDevice(head)
    } finally {
      setBusy(null)
    }
  }

  const later = (): void => useStore.getState().dropPendingDevice(head.deviceId)

  return (
    <Dialog
      // Re-mount per device, so focus lands on the new prompt's safe button again.
      key={head.deviceId}
      open
      onClose={later}
      size="sm"
      className="dev-approve"
      initialFocus={laterRef}
      title={
        <>
          Pair “<span className="dev-approve__name">{head.name}</span>”{head.ip ? ` from ${head.ip}` : ''}?
        </>
      }
      footer={
        <>
          <Button ref={laterRef} variant="ghost" onClick={later} disabled={busy !== null} className="dev-approve__later">
            Decide later
          </Button>
          <Button variant="danger" icon={<X />} loading={busy === 'deny'} disabled={busy !== null} onClick={() => void answer(false)}>
            Deny
          </Button>
          <Button variant="primary" icon={<Check />} loading={busy === 'allow'} disabled={busy !== null} onClick={() => void answer(true)}>
            Allow
          </Button>
        </>
      }
    >
      <div className="dev-approve__body">
        <span className="dev-approve__icon" aria-hidden="true">
          <ShieldAlert />
        </span>
        <div>
          <p>A device used a pairing code from this PC and wants to use Vesper. Allow it only if it’s yours: it will be able to read and write your chats.</p>
          <p className="dev-approve__meta">
            Denied automatically in{' '}
            <span className="dev-approve__timer" aria-label={countdownWords(left)}>
              {formatCountdown(left)}
            </span>
            {queue.length > 1 ? ` · ${queue.length - 1} more waiting` : ''}
          </p>
          {error ? (
            <p className="dev-approve__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </Dialog>
  )
}
