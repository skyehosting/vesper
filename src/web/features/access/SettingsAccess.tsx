/**
 * Settings → Access & security (R1; 07 B2/B14–B16, D8, D12). On the PC: where Vesper can be used (This PC / Local
 * network / Tailscale) with the capability matrix, the LAN and Tailscale panels, pause and resume, the password,
 * devices (pairing, approval, revoke) with the activity log, "Open in browser", tray/autostart, and Advanced (ports,
 * idle sign-out, remote settings). Elsewhere (phones, other browsers): the current mode read-only, the password
 * change (current password required), devices and the log (sudo). Live through `network.changed`/`devices.changed`.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, Pause, Play, QrCode, ShieldAlert, Smartphone } from 'lucide-react'
import type { AccessMode, NetworkStatus } from '@shared/types/domain'
import { Banner, Callout } from '../../components/Callout'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { Disclosure } from '../../components/Disclosure'
import { Select } from '../../components/Select'
import { Skeleton } from '../../components/Skeleton'
import { Switch } from '../../components/Switch'
import { TextField } from '../../components/TextField'
import { toast } from '../../components/Toast'
import { toApiError } from '../../lib/errors.logic'
import { useStore } from '../../lib/store'
import type { SettingsSectionProps } from '../settings/sections'
import { AuditLog } from '../devices/AuditLog'
import { DevicesList } from '../devices/DevicesList'
import { firewallSwitchNote, modeInfo, topWarnings, warningTone } from './access.logic'
import { patchSettings, refreshNetwork, updateNetwork } from './data'
import { LanPanel } from './LanPanel'
import { CapabilityMatrix, ModePicker } from './ModePicker'
import { PairDialog } from './PairDialog'
import { PasswordForm } from './PasswordForm'
import { RemotePanel } from './RemotePanel'
import { ThisPcCard } from './ThisPcCard'
import { TrayCallout } from './TrayCallout'
import './access.css'

export default function SettingsAccess({ advanced }: SettingsSectionProps): ReactNode {
  const desktop = useStore((s) => s.bootstrap?.desktop ?? false)
  const network = useStore((s) => s.network)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pairOpen, setPairOpen] = useState(false)

  // Fresh probes on open (Tailscale, firewall; the server caches them for 15 s).
  useEffect(() => {
    const ctrl = new AbortController()
    refreshNetwork(ctrl.signal).catch((e: unknown) => {
      if (!ctrl.signal.aborted) setLoadError(toApiError(e).message)
    })
    return () => ctrl.abort()
  }, [])

  return (
    <div className="acc" data-testid="settings-access">
      <header className="acc-head">
        <h2 className="acc-head__title">Access &amp; security</h2>
        <p className="acc-head__lead">Choose where Vesper can be used from. It always works here on this PC; other devices need a password and your approval.</p>
      </header>

      {network ? <StatusBanners network={network} desktop={desktop} /> : null}

      {!network ? (
        loadError ? (
          <Callout tone="danger" title="Couldn’t read the access status">
            {loadError}
          </Callout>
        ) : (
          <div className="acc-skel" data-loading aria-hidden="true">
            <Skeleton variant="rect" height={132} radius={16} />
            <Skeleton variant="rect" height={220} radius={16} />
          </div>
        )
      ) : desktop ? (
        <DesktopAccess network={network} onPair={() => setPairOpen(true)} />
      ) : (
        <RemoteViewerAccess network={network} />
      )}

      <section className="acc-section" aria-labelledby="acc-devices-h">
        <div className="acc-section__head">
          <div>
            <h3 id="acc-devices-h" className="acc-section__title">
              Devices
            </h3>
            <p className="acc-section__lead">Everything that can open your chats. Revoke anything you don’t recognise.</p>
          </div>
          {desktop ? (
            <Button icon={<QrCode />} onClick={() => setPairOpen(true)}>
              Pair a device
            </Button>
          ) : null}
        </div>
        <DevicesList desktop={desktop} />
        <AuditLog />
      </section>

      {desktop ? (
        <section className="acc-section" aria-label="This PC">
          <ThisPcCard network={network} />
        </section>
      ) : null}

      {desktop && network ? <Advanced network={network} defaultOpen={!!advanced} /> : null}

      {desktop ? <PairDialog open={pairOpen} onClose={() => setPairOpen(false)} network={network} /> : null}
    </div>
  )
}

/** Funnel "Public" (persistent while on, 07 B14), suspended sign-in, paused access, and the remaining warnings. */
function StatusBanners({ network, desktop }: { network: NetworkStatus; desktop: boolean }): ReactNode {
  const [busy, setBusy] = useState(false)
  const run = async (put: Parameters<typeof updateNetwork>[0], done: string): Promise<void> => {
    setBusy(true)
    try {
      await updateNetwork(put)
      toast.success(done)
    } catch (e) {
      toast.error(toApiError(e).message)
    } finally {
      setBusy(false)
    }
  }
  const until = network.tailscale?.funnelUntilUtc
  const untilText = until ? new Date(until).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : null
  return (
    <div className="acc-banners">
      {network.tailscale?.funnel ? (
        <Banner
          tone="danger"
          icon={<ShieldAlert />}
          actions={
            desktop ? (
              <Button size="sm" variant="danger" loading={busy} onClick={() => void run({ funnel: false }, 'Funnel is off.')}>
                Turn off
              </Button>
            ) : undefined
          }
        >
          <b>Public.</b> Anyone on the Internet can reach your sign-in page through Funnel{untilText ? ` until ${untilText}` : ''}.
        </Banner>
      ) : null}
      {network.remote?.loginSuspended ? (
        <Callout
          tone="danger"
          title="Sign-in from other devices is paused"
          actions={
            desktop ? (
              <Button size="sm" loading={busy} onClick={() => void run({ resumeRemoteLogin: true }, 'Sign-in from other devices is back on.')}>
                Resume sign-in
              </Button>
            ) : undefined
          }
        >
          There were too many wrong passwords, so Vesper stopped accepting the password from other devices. Paired devices keep working. If those attempts weren’t yours, change the
          password first.
        </Callout>
      ) : null}
      {network.remote?.paused ? (
        <Callout
          tone="info"
          icon={<Pause />}
          title="Access from other devices is paused"
          actions={
            desktop ? (
              <Button size="sm" icon={<Play />} loading={busy} onClick={() => void run({ paused: false }, 'Access from other devices is back on.')}>
                Resume
              </Button>
            ) : undefined
          }
        >
          Phones and other devices can’t reach Vesper until you resume. This PC is not affected.
        </Callout>
      ) : null}
      {topWarnings(network).map((w) => (
        <Callout key={w.code} tone={warningTone(w.code)}>
          {w.message}
        </Callout>
      ))}
    </div>
  )
}

function DesktopAccess({ network, onPair }: { network: NetworkStatus; onPair: () => void }): ReactNode {
  const [draft, setDraft] = useState<AccessMode>(network.mode)
  const [applying, setApplying] = useState(false)
  const [modeError, setModeError] = useState<string | null>(null)
  const [wantPassword, setWantPassword] = useState(false)
  const passwordRef = useRef<HTMLElement>(null)
  const current = network.mode
  const changed = draft !== current
  const needsPassword = draft !== 'local' && !network.passwordSet
  const firewallNote = firewallSwitchNote(current, draft, network.lan)

  // Someone else (the tray, another window) changed the mode: follow it unless the owner is mid-choice.
  const lastCurrent = useRef(current)
  useEffect(() => {
    if (lastCurrent.current !== current) {
      lastCurrent.current = current
      setDraft(current)
    }
  }, [current])

  const apply = async (mode: AccessMode): Promise<void> => {
    setApplying(true)
    setModeError(null)
    try {
      await updateNetwork({ mode })
      toast.success(mode === 'local' ? 'Vesper is now available on this PC only.' : `${modeInfo(mode).title} is on.`)
    } catch (e) {
      const err = toApiError(e)
      setModeError(err.fields?.mode ?? err.message)
    } finally {
      setApplying(false)
    }
  }

  const showPassword = (): void => {
    setWantPassword(true)
    passwordRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    window.setTimeout(() => passwordRef.current?.querySelector('input')?.focus(), 250)
  }

  return (
    <>
      <section className="acc-section" aria-labelledby="acc-mode-h">
        <div className="acc-section__head">
          <div>
            <h3 id="acc-mode-h" className="acc-section__title">
              Where you can use Vesper
            </h3>
            <p className="acc-section__lead">Only the devices you sign in or pair can open your chats, whatever you choose.</p>
          </div>
        </div>
        <div data-setting="access.mode">
          <ModePicker value={draft} current={current} onChange={setDraft} portable={network.portable} />
        </div>
        {changed ? (
          <div className="acc-apply" role="group" aria-label="Apply the change">
            {needsPassword ? (
              <p className="acc-apply__text">
                <b>{modeInfo(draft).title}</b> needs a password first, so other devices have to sign in.{firewallNote ? ` ${firewallNote}` : ''}
              </p>
            ) : (
              <p className="acc-apply__text">
                Switch to <b>{modeInfo(draft).title}</b>?{draft === 'local' ? ' Other devices lose access until you turn it back on.' : ''}
                {firewallNote ? ` ${firewallNote}` : ''}
              </p>
            )}
            <div className="acc-apply__buttons">
              <Button variant="ghost" onClick={() => setDraft(current)} disabled={applying}>
                Cancel
              </Button>
              {needsPassword ? (
                <Button variant="primary" iconRight={<ArrowRight />} onClick={showPassword}>
                  Set a password
                </Button>
              ) : (
                <Button variant="primary" loading={applying} onClick={() => void apply(draft)}>
                  Use {modeInfo(draft).title}
                </Button>
              )}
            </div>
          </div>
        ) : null}
        {modeError ? (
          <p className="acc-error" role="alert">
            {modeError}
          </p>
        ) : null}
        <Disclosure summary="What works where" variant="card" defaultOpen={current === 'local'}>
          <CapabilityMatrix selected={draft} />
          <p className="acc-muted acc-gap-top">
            Phones need HTTPS for the microphone. On the local network Vesper makes its own certificate, so each device warns once; Tailscale’s certificate is trusted everywhere.
          </p>
        </Disclosure>
      </section>

      {current !== 'local' ? <TrayCallout /> : null}
      {current === 'lan' ? <LanPanel network={network} desktop /> : null}
      {current === 'tailscale' ? <RemotePanel network={network} desktop /> : null}
      {current !== 'local' ? <RemoteControls network={network} onPair={onPair} /> : null}

      <section className="acc-section" aria-labelledby="acc-pw-h" ref={passwordRef}>
        <PasswordSection
          network={network}
          desktop
          forceOpen={wantPassword}
          onSaved={() => {
            setWantPassword(false)
            if (draft !== current && draft !== 'local') void apply(draft)
          }}
        />
      </section>
    </>
  )
}

function RemoteControls({ network, onPair }: { network: NetworkStatus; onPair: () => void }): ReactNode {
  const keep = useStore((s) => s.settings?.access.keepRemoteWhileClosed ?? false)
  const [busy, setBusy] = useState<string | null>(null)
  const paused = !!network.remote?.paused
  const set = async (key: string, put: Parameters<typeof updateNetwork>[0]): Promise<void> => {
    setBusy(key)
    try {
      await updateNetwork(put)
    } catch (e) {
      toast.error(toApiError(e).message)
    } finally {
      setBusy(null)
    }
  }
  return (
    <Card as="section" className="acc-panel" icon={<Smartphone />} title="Other devices" description="Pair a phone in a few seconds, or pause access when you don’t need it.">
      <div className="acc-row">
        <div className="acc-row__text">
          <span className="acc-row__title">Pair a phone or laptop</span>
          <span className="acc-muted">Scan a code instead of typing the password. You approve each device here.</span>
        </div>
        <Button icon={<QrCode />} onClick={onPair}>
          Pair a device
        </Button>
      </div>
      <div className="acc-switches">
        <Switch
          checked={paused}
          onChange={(v) => void set('paused', { paused: v })}
          disabled={busy === 'paused'}
          label="Pause access from other devices"
          description="Stops the network listeners until you resume. Also in the tray menu."
        />
        {network.mode === 'tailscale' ? (
          <div data-setting="access.keepRemoteWhileClosed">
            <Switch
              checked={keep}
              onChange={(v) => void set('keep', { keepRemoteWhileClosed: v })}
              disabled={busy === 'keep'}
              label="Keep Tailscale access after quitting Vesper"
              description="Off: quitting Vesper also removes it from your tailnet."
            />
          </div>
        ) : null}
      </div>
    </Card>
  )
}

function PasswordSection({ network, desktop, forceOpen, onSaved }: { network: NetworkStatus; desktop: boolean; forceOpen?: boolean; onSaved?: () => void }): ReactNode {
  const [open, setOpen] = useState(false)
  const isSet = network.passwordSet
  const showForm = !isSet || open || !!forceOpen
  return (
    <>
      <div className="acc-section__head">
        <div>
          <h3 id="acc-pw-h" className="acc-section__title">
            Password
          </h3>
          <p className="acc-section__lead">
            {isSet ? 'Other devices sign in with it. The app on this PC never asks for it.' : 'Needed before other devices can use Vesper. The app on this PC never asks for it.'}
          </p>
        </div>
      </div>
      {showForm ? (
        <Card className="acc-pw-card">
          <PasswordForm
            isSet={isSet}
            desktop={desktop}
            onSaved={() => {
              setOpen(false)
              toast.success(isSet ? 'Password changed. Other devices were signed out.' : 'Password set.')
              onSaved?.()
            }}
          />
        </Card>
      ) : (
        <div className="acc-pw-status">
          <p className="acc-status-line">
            <span className="acc-dot acc-dot--ok" aria-hidden="true" />
            A password is set.
          </p>
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            Change password
          </Button>
        </div>
      )}
    </>
  )
}

/** Phones and other browsers: what's on (read-only), this device, and the password change. */
function RemoteViewerAccess({ network }: { network: NetworkStatus }): ReactNode {
  const device = useStore((s) => s.bootstrap?.device)
  const m = modeInfo(network.mode)
  return (
    <>
      <section className="acc-section" aria-labelledby="acc-mode-h">
        <h3 id="acc-mode-h" className="acc-section__title">
          Where you can use Vesper
        </h3>
        <Card tone="muted" className="acc-viewer">
          <p className="acc-row__title">{m.title}</p>
          <p className="acc-muted">{m.summary}</p>
          {device ? (
            <p className="acc-muted">
              You’re using <b>{device.name}</b> through {device.listener === 'loopback' ? 'this PC' : device.listener === 'lan' ? 'the local network' : 'Tailscale'}.
            </p>
          ) : null}
          <p className="acc-muted">Access settings can only be changed in Vesper on the PC.</p>
        </Card>
      </section>
      <section className="acc-section" aria-labelledby="acc-pw-h">
        <PasswordSection network={network} desktop={false} />
      </section>
    </>
  )
}

const IDLE_DAYS = ['1', '3', '7', '14', '30', '90']

function Advanced({ network, defaultOpen }: { network: NetworkStatus; defaultOpen: boolean }): ReactNode {
  const access = useStore((s) => s.settings?.access)
  const [ports, setPorts] = useState(() => ({
    port: String(access?.port ?? network.loopback.port),
    lanPort: String(access?.lanPort ?? 41731),
    tailnetPort: String(access?.tailnetPort ?? 41732)
  }))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  if (!access) return null

  const dirty = ports.port !== String(access.port) || ports.lanPort !== String(access.lanPort) || ports.tailnetPort !== String(access.tailnetPort)

  const savePorts = async (): Promise<void> => {
    const n = { port: Number(ports.port), lanPort: Number(ports.lanPort), tailnetPort: Number(ports.tailnetPort) }
    const bad: Record<string, string> = {}
    for (const [k, v] of Object.entries(n)) if (!Number.isInteger(v) || v < 1024 || v > 65535) bad[k] = 'Use a port between 1024 and 65535.'
    setErrors(bad)
    if (Object.keys(bad).length) return
    setSaving(true)
    try {
      await updateNetwork(n)
      toast.success(n.port !== access.port ? 'Saved. The new port for this PC applies the next time Vesper starts.' : 'Ports saved.')
    } catch (e) {
      const err = toApiError(e)
      if (err.fields) setErrors(err.fields)
      else toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  const set = async (patch: Parameters<typeof patchSettings>[0]): Promise<void> => {
    try {
      await patchSettings(patch)
    } catch (e) {
      toast.error(toApiError(e).message)
    }
  }

  return (
    <Disclosure summary="Advanced" variant="card" defaultOpen={defaultOpen} className="acc-advanced">
      <div className="acc-adv">
        <fieldset className="acc-ports">
          <legend className="acc-label">Ports</legend>
          <div className="acc-ports__grid">
            <div data-setting="access.port">
              <TextField label="This PC" inputMode="numeric" value={ports.port} onChange={(e) => setPorts({ ...ports, port: e.target.value })} error={errors.port} hint="Applies after a restart" />
            </div>
            <div data-setting="access.lanPort">
              <TextField label="Local network (HTTPS)" inputMode="numeric" value={ports.lanPort} onChange={(e) => setPorts({ ...ports, lanPort: e.target.value })} error={errors.lanPort} />
            </div>
            <div data-setting="access.tailnetPort">
              <TextField label="Tailscale" inputMode="numeric" value={ports.tailnetPort} onChange={(e) => setPorts({ ...ports, tailnetPort: e.target.value })} error={errors.tailnetPort} />
            </div>
          </div>
          <div>
            <Button size="sm" variant="secondary" disabled={!dirty} loading={saving} onClick={() => void savePorts()}>
              Save ports
            </Button>
          </div>
        </fieldset>
        <div data-setting="access.idleTimeoutDays">
          <Select
            label="Sign out devices that haven’t been used for"
            value={String(access.idleTimeoutDays)}
            options={IDLE_DAYS.map((d) => ({ value: d, label: d === '1' ? '1 day' : `${d} days` }))}
            onChange={(v) => void set({ access: { idleTimeoutDays: Number(v) } })}
          />
        </div>
        <div data-setting="access.remoteMayChangeSettings">
          <Switch
            checked={access.remoteMayChangeSettings}
            onChange={(v) => void set({ access: { remoteMayChangeSettings: v } })}
            label="Let other devices change appearance, voice and chat settings"
            description="Keys, providers, access and protocols can only ever be changed on this PC."
          />
        </div>
      </div>
    </Disclosure>
  )
}
