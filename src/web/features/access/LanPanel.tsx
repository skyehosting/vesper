/**
 * Local network (Listener B, 07 B2/D8, research 06 §3.2): status, the addresses phones use (copy + QR), the network
 * address choice, the certificate fingerprint to compare on first visit, and Windows Firewall — read-only state plus
 * the manual "Allow in Windows Firewall…" (turning Local network access on adds the rule itself, 07 H-v111-firewall;
 * this button is the fallback when that prompt was cancelled). Each explains up front that Windows asks for admin ONCE.
 */
import { useState, type ReactNode } from 'react'
import { ShieldCheck, ShieldQuestion, ShieldX, Wifi } from 'lucide-react'
import type { NetworkStatus } from '@shared/types/domain'
import { Badge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { Callout } from '../../components/Callout'
import { Card } from '../../components/Card'
import { Checkbox } from '../../components/Checkbox'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { CopyButton } from '../../components/CopyButton'
import { QRCode } from '../../components/QRCode'
import { Select, type SelectOption } from '../../components/Select'
import { StatusDot } from '../../components/StatusDot'
import { toast } from '../../components/Toast'
import { toApiError } from '../../lib/errors.logic'
import { useStore } from '../../lib/store'
import { fingerprintLines, hasWarning, lanAddressForOthers } from './access.logic'
import { allowFirewall, updateNetwork } from './data'

type Lan = NonNullable<NetworkStatus['lan']>

const AUTO = 'auto'

export function LanPanel({ network, desktop }: { network: NetworkStatus; desktop: boolean }): ReactNode {
  const lan = network.lan
  if (!lan) return null
  const primary = lanAddressForOthers(network)
  const others = (lan.urls ?? []).filter((u) => u !== primary)
  return (
    <Card
      as="section"
      className="acc-panel"
      icon={<Wifi />}
      title="Local network"
      description="Devices on the same network open Vesper over HTTPS."
      actions={
        lan.running ? <StatusDot status="online" label="Running" showLabel /> : <StatusDot status={network.passwordSet ? 'warning' : 'offline'} label="Not running" showLabel />
      }
    >
      {primary ? (
        <div className="acc-lan">
          <div className="acc-lan__addrs">
            <p className="acc-lan__open-label" id="acc-lan-addr">
              On your phone, open
            </p>
            <div className="acc-lan__open" role="group" aria-labelledby="acc-lan-addr">
              <span className="acc-mono acc-lan__url">{primary}</span>
              <CopyButton text={primary} label={`Copy ${primary}`} size="sm" />
            </div>
            <p className="acc-lan__cert">Your phone will warn about the certificate the first time — choose Advanced → Proceed.</p>
            <p className="acc-muted">Then sign in with the password. Pairing (below) skips the password.</p>
            {others.length ? (
              <ul className="acc-urls" aria-label="Also works">
                {others.map((u) => (
                  <li key={u}>
                    <span className="acc-mono acc-urls__text">{u}</span>
                    <CopyButton text={u} label={`Copy ${u}`} size="sm" />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <QRCode className="acc-lan__qr" value={primary} label={`Address of Vesper on your network: ${primary}`} size={132} />
        </div>
      ) : (
        <p className="acc-muted">{network.passwordSet ? 'Starting… the address appears here once Vesper is listening.' : 'Set a password below to start Local network access.'}</p>
      )}

      {desktop ? <AddressPicker network={network} /> : null}
      <Certificate lan={lan} />
      {lan.running ? <Firewall network={network} lan={lan} desktop={desktop} /> : null}
    </Card>
  )
}

function AddressPicker({ network }: { network: NetworkStatus }): ReactNode {
  const [busy, setBusy] = useState(false)
  // The setting (null = automatic), not the status: the status reports the address actually in use.
  const chosen = useStore((s) => s.settings?.access.lanAddress ?? null)
  const ifaces = network.interfaces ?? []
  const options: SelectOption[] = [
    { value: AUTO, label: 'Automatic', description: 'The network this PC uses to reach the Internet' },
    ...ifaces.map((i) => ({ value: i.address, label: `${i.address}`, description: `${i.name}${i.recommended ? ' · recommended' : ''}` }))
  ]
  // A chosen address that is not listed (another network now, or a test loopback address) stays visible.
  if (chosen && !options.some((o) => o.value === chosen)) options.push({ value: chosen, label: chosen, description: 'Chosen earlier' })
  const value = chosen ?? AUTO

  const change = async (v: string): Promise<void> => {
    setBusy(true)
    try {
      await updateNetwork({ lanAddress: v === AUTO ? null : v })
    } catch (e) {
      toast.error(toApiError(e).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-setting="access.lanAddress">
      <Select
        label="Network address"
        hint="Vesper listens only on this address, so it stays off VPNs and virtual adapters."
        value={value}
        options={options}
        onChange={(v) => void change(v)}
        disabled={busy}
      />
    </div>
  )
}

function Certificate({ lan }: { lan: Lan }): ReactNode {
  const lines = fingerprintLines(lan.certFingerprint)
  if (!lines.length) return null
  const expires = lan.certExpiresUtc ? new Date(lan.certExpiresUtc).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : null
  return (
    <div className="acc-cert">
      <div className="acc-cert__head">
        <span className="acc-label" id="acc-cert-label">
          Certificate fingerprint (SHA-256)
        </span>
        <CopyButton text={lan.certFingerprint ?? ''} label="Copy fingerprint" size="sm" />
      </div>
      <code className="acc-fp" aria-labelledby="acc-cert-label">
        {lines.map((l) => (
          <span key={l}>{l}</span>
        ))}
      </code>
      <p className="acc-muted">
        Phones warn because this certificate is made by Vesper itself. In the warning’s details, check that the fingerprint matches before you continue.
        {expires ? ` Renews itself before ${expires}.` : ''}
      </p>
    </div>
  )
}

function Firewall({ network, lan, desktop }: { network: NetworkStatus; lan: Lan; desktop: boolean }): ReactNode {
  const [ask, setAsk] = useState(false)
  const [publicToo, setPublicToo] = useState(lan.profile === 'public')
  const publicNet = lan.profile === 'public' || hasWarning(network, 'network_public')

  const state = lan.firewall
  const head =
    state === 'allowed' ? (
      <Badge tone="success" icon={<ShieldCheck />}>
        Allowed in Windows Firewall
      </Badge>
    ) : state === 'not-needed' ? (
      <Badge tone="success" icon={<ShieldCheck />}>
        No firewall rule needed
      </Badge>
    ) : state === 'blocked' ? (
      <Badge tone="danger" icon={<ShieldX />}>
        Blocked by Windows Firewall
      </Badge>
    ) : (
      <Badge tone="warning" icon={<ShieldQuestion />}>
        Windows Firewall may block it
      </Badge>
    )
  const needsRule = state === 'blocked' || state === 'unknown'

  return (
    <div className="acc-fw">
      <div className="acc-fw__head">
        <span className="acc-label">Windows Firewall</span>
        {head}
      </div>
      {needsRule ? (
        <>
          <p className="acc-muted">
            {state === 'blocked'
              ? 'An earlier “Cancel” in the Windows prompt made a rule that blocks Vesper. Other devices can’t connect until it is replaced.'
              : 'Other devices may not reach Vesper until it is allowed through the firewall.'}
            {publicNet ? ' This network is set to Public, where Windows blocks incoming connections; setting it to Private in Windows Settings → Network & internet also works.' : ''}
          </p>
          {desktop ? (
            <div>
              <Button icon={<ShieldCheck />} onClick={() => setAsk(true)}>
                Allow in Windows Firewall…
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      <ConfirmDialog
        open={ask}
        onClose={() => setAsk(false)}
        title="Allow Vesper through Windows Firewall?"
        description="Windows asks for administrator permission once (a User Account Control prompt). Vesper then adds one rule: its own program, this port, devices on your local network only."
        confirmLabel="Continue to Windows"
        onConfirm={async () => {
          await allowFirewall(publicToo)
          toast.success('Windows Firewall now allows Vesper on your network.')
        }}
      >
        <Checkbox
          checked={publicToo}
          onChange={setPublicToo}
          label="Also on Public networks"
          description={publicNet ? 'Needed here: this network is set to Public.' : 'Only if you use Vesper on networks Windows calls Public.'}
        />
        {state === 'blocked' ? (
          <Callout tone="info" className="acc-gap-top">
            The old rule that blocks Vesper is removed in the same step.
          </Callout>
        ) : null}
      </ConfirmDialog>
    </div>
  )
}
