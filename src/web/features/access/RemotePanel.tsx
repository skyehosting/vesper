/**
 * Remote via Tailscale (07 B3/B14, research 06 §3.3): a checklist of what Tailscale needs on this PC (installed,
 * running, signed in, HTTPS certificates), the served address, Tailscale's consent link, and Funnel — public access
 * from the whole Internet — behind a warning, with its auto-off timer. Vesper never installs or signs in to Tailscale
 * itself; the owner does that in Tailscale's own app.
 */
import { useState, type ReactNode } from 'react'
import { Globe, RefreshCw, TriangleAlert } from 'lucide-react'
import type { NetworkStatus } from '@shared/types/domain'
import { Button } from '../../components/Button'
import { Callout } from '../../components/Callout'
import { Card } from '../../components/Card'
import { CopyButton } from '../../components/CopyButton'
import { Disclosure } from '../../components/Disclosure'
import { Select } from '../../components/Select'
import { StatusDot, type Status } from '../../components/StatusDot'
import { Switch } from '../../components/Switch'
import { toast } from '../../components/Toast'
import { toApiError } from '../../lib/errors.logic'
import { useStore } from '../../lib/store'
import { FUNNEL_HOURS } from './access.logic'
import { refreshNetwork, updateNetwork } from './data'
import { ExtLink } from './links'

const DOWNLOAD = 'https://tailscale.com/download'
const ADMIN_DNS = 'https://login.tailscale.com/admin/dns'

interface Step {
  id: string
  label: string
  ok: boolean | null
  help?: ReactNode
}

function stepsOf(ts: NetworkStatus['tailscale']): Step[] {
  const installed = ts ? ts.installed : null
  return [
    {
      id: 'installed',
      label: 'Tailscale installed on this PC',
      ok: installed,
      help: <ExtLink href={DOWNLOAD}>Download Tailscale</ExtLink>
    },
    { id: 'running', label: 'Tailscale running', ok: ts && installed ? ts.running : installed === false ? false : null, help: 'Start Tailscale from the Start menu.' },
    {
      id: 'signed-in',
      label: ts?.dnsName ? `Signed in as ${ts.dnsName.replace(/\.$/, '')}` : 'Signed in to your tailnet',
      ok: ts && ts.running ? ts.signedIn : installed === false || ts?.running === false ? false : null,
      help: 'Sign in from the Tailscale icon in the taskbar.'
    },
    {
      id: 'https',
      label: 'HTTPS certificates turned on for your tailnet',
      ok: ts?.signedIn ? (ts.httpsEnabled ?? null) : ts ? false : null,
      help: <ExtLink href={ADMIN_DNS}>Open DNS settings in the Tailscale admin console</ExtLink>
    },
    { id: 'serving', label: 'Vesper available on your tailnet', ok: ts ? ts.serving : null }
  ]
}

function stepStatus(ok: boolean | null): Status {
  return ok === true ? 'online' : ok === false ? 'offline' : 'idle'
}

export function RemotePanel({ network, desktop }: { network: NetworkStatus; desktop: boolean }): ReactNode {
  const ts = network.tailscale
  const [checking, setChecking] = useState(false)
  const steps = stepsOf(ts)
  const firstOpen = steps.findIndex((s) => s.ok !== true)

  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      await refreshNetwork()
    } catch (e) {
      toast.error(toApiError(e).message)
    } finally {
      setChecking(false)
    }
  }

  return (
    <Card
      as="section"
      className="acc-panel"
      icon={<Globe />}
      title="Tailscale"
      description="Your own devices reach Vesper from anywhere, through your private Tailscale network."
      actions={
        ts?.serving ? (
          <StatusDot status="online" label="Available" showLabel />
        ) : (
          <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={checking} onClick={() => void check()}>
            Check again
          </Button>
        )
      }
    >
      {ts?.serving && ts.url ? (
        <div className="acc-served">
          <span className="acc-label">Address on your tailnet</span>
          <div className="acc-urls">
            <span className="acc-mono acc-urls__text">{ts.url}</span>
            <CopyButton text={ts.url} label="Copy the Tailscale address" size="sm" />
          </div>
          <p className="acc-muted">Install Tailscale on your phone, sign in with the same account, then open this address. On a phone you can add it to the home screen.</p>
        </div>
      ) : null}

      <ol className="acc-checklist" aria-label="What Tailscale needs">
        {steps.map((s, i) => (
          <li key={s.id} className={s.ok ? 'is-done' : i === firstOpen ? 'is-next' : undefined}>
            <StatusDot status={stepStatus(s.ok)} label={s.ok === true ? 'Done' : s.ok === false ? 'Not yet' : 'Unknown'} />
            <div className="acc-checklist__text">
              <span>{s.label}</span>
              {i === firstOpen && s.ok === false && s.help ? <span className="acc-checklist__help">{s.help}</span> : null}
            </div>
          </li>
        ))}
      </ol>

      {ts?.consentUrl ? (
        <Callout
          tone="warning"
          title="Tailscale needs your approval"
          learnMore={{ href: ts.consentUrl, label: 'Open the Tailscale admin console' }}
        >
          Tailscale asked you to allow this in its admin console. Open the link on this PC, approve it, then choose Check again.
        </Callout>
      ) : null}

      {desktop ? <Funnel network={network} /> : null}
    </Card>
  )
}

/** Funnel: public access through Tailscale's relays (07 B14). Strong warning, persistent banner, auto-off timer. */
function Funnel({ network }: { network: NetworkStatus }): ReactNode {
  const ts = network.tailscale
  const hours = useStore((s) => s.settings?.access.funnelAutoOffHours ?? 8)
  const [busy, setBusy] = useState(false)
  const on = !!ts?.funnel

  const set = async (put: Parameters<typeof updateNetwork>[0]): Promise<void> => {
    setBusy(true)
    try {
      await updateNetwork(put)
    } catch (e) {
      toast.error(toApiError(e).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Disclosure summary="Public access (Funnel)" meta={on ? 'On' : 'Off'} variant="card" defaultOpen={on}>
      <div className="acc-funnel">
        <Callout tone="danger" icon={<TriangleAlert />} title="Anyone on the Internet could reach your sign-in page">
          Funnel publishes Vesper beyond your tailnet. Your password is then all that protects your chats, and this PC’s Tailscale name appears in public certificate logs. Use it only
          for a short time, for a device that can’t run Tailscale.
        </Callout>
        <div data-setting="access.funnel">
          <Switch checked={on} onChange={(v) => void set({ funnel: v })} disabled={busy || !ts?.serving} label="Turn on Funnel" description={ts?.serving ? undefined : 'Available once Vesper is on your tailnet.'} />
        </div>
        <div data-setting="access.funnelAutoOffHours">
          <Select
            label="Turn Funnel off automatically"
            value={String(hours)}
            options={FUNNEL_HOURS.map((h) => ({ value: h.value, label: h.label }))}
            onChange={(v) => void set({ funnelAutoOffHours: Number(v) })}
            disabled={busy}
          />
        </div>
      </div>
    </Disclosure>
  )
}
