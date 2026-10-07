/**
 * "Pair a device" (07 B16, research 06 §5.7): the PC mints a one-time code (5 minutes, single use) for a way in —
 * the local network, Tailscale, or a browser on this PC — and shows it as a QR code, a link and the code itself,
 * with a countdown. A phone that redeems a LAN/Tailscale code still has to be allowed here (ApprovalDialog). The
 * code is never put anywhere but this dialog (and the QR's data: image); closing the dialog forgets it.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ExternalLink, Globe, Monitor, RefreshCw, Wifi } from 'lucide-react'
import type { PairTarget } from '@shared/api'
import type { NetworkStatus } from '@shared/types/domain'
import { Button } from '../../components/Button'
import { Callout } from '../../components/Callout'
import { CopyButton } from '../../components/CopyButton'
import { Dialog } from '../../components/Dialog'
import { ProgressRing } from '../../components/Progress'
import { QRCode } from '../../components/QRCode'
import { Segmented, type SegmentedOption } from '../../components/Segmented'
import { Skeleton } from '../../components/Skeleton'
import { toApiError } from '../../lib/errors.logic'
import { useIsPhone, useMediaQuery } from '../../lib/useMediaQuery'
import { countdownWords, fingerprintLines, formatCountdown, groupCode } from './access.logic'
import { createPairing } from './data'
import { openExternal } from './links'

/** Pairing codes live 5 minutes on the server (src/server/auth/pairing.ts PAIR_TTL_MS). */
export const PAIR_TTL_MS = 5 * 60_000

export function availableTargets(n: NetworkStatus | null): PairTarget[] {
  const out: PairTarget[] = []
  if (n?.lan?.running) out.push('lan')
  if (n?.tailscale?.serving) out.push('tailnet')
  out.push('local')
  return out
}

const TARGET_LABEL: Record<PairTarget, string> = { lan: 'Local network', tailnet: 'Tailscale', local: 'This PC' }
const TARGET_ICON: Record<PairTarget, ReactNode> = { lan: <Wifi />, tailnet: <Globe />, local: <Monitor /> }

interface Minted {
  code: string
  url: string
  target: PairTarget
  /** Local clock deadline (the server's TTL from the moment the answer arrived). */
  expiresAt: number
}

export function PairDialog({ open, onClose, network }: { open: boolean; onClose: () => void; network: NetworkStatus | null }): ReactNode {
  if (!open) return null
  return <PairDialogImpl onClose={onClose} network={network} />
}

function PairDialogImpl({ onClose, network }: { onClose: () => void; network: NetworkStatus | null }): ReactNode {
  const targets = availableTargets(network)
  const [target, setTarget] = useState<PairTarget>(targets[0])
  const [minted, setMinted] = useState<Minted | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const phone = useIsPhone()
  // Short windows (the owner's 1138×608): a smaller code keeps the steps and the code in view.
  const short = useMediaQuery('(max-height: 700px)')
  const qrSize = phone ? 200 : short ? 168 : 208
  const seq = useRef(0)

  const mint = useCallback(async (t: PairTarget): Promise<void> => {
    const my = ++seq.current
    setMinted(null)
    setError(null)
    try {
      const r = await createPairing(t)
      if (my !== seq.current) return
      // The server's clock may differ from this one (or be shifted in tests): count the fixed TTL locally.
      const at = Date.now()
      setNow(at)
      setMinted({ code: r.code, url: r.url, target: r.target, expiresAt: at + PAIR_TTL_MS })
    } catch (e) {
      if (my === seq.current) setError(toApiError(e).message)
    }
  }, [])

  useEffect(() => {
    void mint(target)
  }, [mint, target])

  useEffect(() => {
    const h = window.setInterval(() => setNow(Date.now()), 1000)
    return () => {
      window.clearInterval(h)
      // Forget the code (and ignore an answer still on its way).
      seq.current++
    }
  }, [])

  const left = minted ? minted.expiresAt - now : 0
  const expired = minted !== null && left <= 0
  const options: SegmentedOption<PairTarget>[] = targets.map((t) => ({ value: t, label: TARGET_LABEL[t], icon: TARGET_ICON[t] }))

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      className="acc-pair"
      title="Pair a device"
      description={
        target === 'local' ? 'Open the link in a browser on this PC to use Vesper there. It signs in right away.' : 'Scan the code with the phone’s camera, or open the link on the device you want to add.'
      }
      footer={
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      }
    >
      {targets.length > 1 ? <Segmented aria-label="Way in" value={target} onChange={setTarget} options={options} block={phone} size="sm" /> : null}
      {targets.length === 1 ? (
        <Callout tone="info" title="Pairing a phone needs network access">
          Turn on <b>Local network</b> or <b>Tailscale</b> above first. Until then a code works only in a browser on this PC.
        </Callout>
      ) : null}

      <div className="acc-pair__body">
        <div className={expired ? 'acc-pair__qr is-expired' : 'acc-pair__qr'}>
          {error ? (
            <div className="acc-pair__qr-error" role="alert">
              <p>{error}</p>
              <Button size="sm" icon={<RefreshCw />} onClick={() => void mint(target)}>
                Try again
              </Button>
            </div>
          ) : minted ? (
            <>
              <QRCode value={minted.url} label={`Pairing code for ${TARGET_LABEL[minted.target]}`} size={qrSize} level="M" />
              {expired ? (
                <div className="acc-pair__expired">
                  <p>This code expired.</p>
                  <Button size="sm" variant="primary" icon={<RefreshCw />} onClick={() => void mint(target)}>
                    New code
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            <Skeleton variant="rect" width={qrSize} height={qrSize} radius={16} />
          )}
        </div>

        <div className="acc-pair__side">
          {minted && !expired ? (
            <div className="acc-pair__timer">
              <ProgressRing value={left / PAIR_TTL_MS} size={26} thickness={3} label="Time left for this code" valueText={countdownWords(left)} />
              <span>
                Expires in <span className="acc-mono">{formatCountdown(left)}</span>
              </span>
            </div>
          ) : null}
          <ol className="acc-steps">
            {target === 'lan' ? (
              <>
                <li>Connect the phone to the same Wi‑Fi as this PC, then scan the code.</li>
                <li>The browser warns about the certificate once. Compare its SHA-256 fingerprint with the one below, then continue.</li>
                <li>Allow the phone here when Vesper asks.</li>
              </>
            ) : target === 'tailnet' ? (
              <>
                <li>Install Tailscale on the phone and sign in with the same account as this PC.</li>
                <li>Scan the code.</li>
                <li>Allow the phone here when Vesper asks.</li>
              </>
            ) : (
              <>
                <li>Use “Open in browser”, or paste the link into any browser on this PC.</li>
                <li>Sign-in lasts up to 30 days, less if unused.</li>
              </>
            )}
          </ol>
          {minted ? (
            <div className="acc-pair__code">
              <span className="acc-label">Code</span>
              <span className="acc-mono acc-pair__codetext">{groupCode(minted.code)}</span>
            </div>
          ) : null}
          {minted ? (
            <div className="acc-pair__actions">
              <CopyButton variant="button" size="sm" text={minted.url} label="Copy link" />
              {minted.target === 'local' ? (
                <Button size="sm" icon={<ExternalLink />} disabled={expired} onClick={() => openExternal(minted.url)}>
                  Open in browser
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {target === 'lan' && network?.lan?.certFingerprint ? (
        <div className="acc-pair__fp">
          <span className="acc-label">Certificate fingerprint (SHA-256)</span>
          <code className="acc-fp">
            {fingerprintLines(network.lan.certFingerprint).map((l) => (
              <span key={l}>{l}</span>
            ))}
          </code>
        </div>
      ) : null}
    </Dialog>
  )
}
