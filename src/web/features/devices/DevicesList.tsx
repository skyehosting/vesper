/**
 * Devices that can use Vesper (07 B2/B16, research 06 §5.7): name, how it got in (password / paired / the app), the
 * way in (this PC / local network / Tailscale), last seen and IP; the current device and pending ones first.
 * Revoke signs a device out at once (its sockets close → its login page); it needs a recent password off the PC
 * (sudo → the password prompt). Pending devices can be allowed or denied here too (desktop). Live: `devices.changed`.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Check, Laptop, LogOut, Monitor, Smartphone, Tablet, UserX, X } from 'lucide-react'
import type { DeviceInfo } from '@shared/types/domain'
import { relativeAge, zoneOf } from '@shared/time'
import { Badge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { List, ListItem } from '../../components/List'
import { Skeleton } from '../../components/Skeleton'
import { toast } from '../../components/Toast'
import { signOut } from '../../app/boot'
import { toApiError, type ApiErrorException } from '../../lib/errors.logic'
import { useStore } from '../../lib/store'
import { deviceIcon, kindLabel, listenerLabel, sortDevices } from '../access/access.logic'
import { approveDevice, loadDevices, revokeDevice, watchDevices } from '../access/data'
import './devices.css'

const ICON = { desktop: <Monitor />, phone: <Smartphone />, tablet: <Tablet />, laptop: <Laptop /> }

function localZone(): ReturnType<typeof zoneOf> {
  let name: string | null = null
  try {
    name = Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    name = null
  }
  return zoneOf(name, -new Date().getTimezoneOffset())
}

export function DevicesList({ desktop }: { desktop: boolean }): ReactNode {
  const devices = useStore((s) => s.devices)
  const [error, setError] = useState<ApiErrorException | Error | null>(null)
  const [revoking, setRevoking] = useState<DeviceInfo | null>(null)
  const [answering, setAnswering] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const release = watchDevices()
    loadDevices().catch((e: unknown) => setError(e instanceof Error ? e : new Error(String(e))))
    // "last seen" words age while the page is open.
    const h = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => {
      release()
      window.clearInterval(h)
    }
  }, [])

  const retry = (): void => {
    setError(null)
    loadDevices().catch((e: unknown) => setError(e instanceof Error ? e : new Error(String(e))))
  }

  if (error && !devices) return <ErrorState error={error} compact onRetry={retry} />
  if (!devices) {
    return (
      <div className="dev-skel" aria-hidden="true" data-loading>
        <Skeleton variant="rect" height={60} radius={12} />
        <Skeleton variant="rect" height={60} radius={12} />
      </div>
    )
  }

  const zone = localZone()
  const list = sortDevices(devices)
  const others = list.filter((d) => !d.current)

  const answer = async (d: DeviceInfo, allow: boolean): Promise<void> => {
    setAnswering(d.id)
    try {
      await approveDevice(d.id, allow)
      await loadDevices()
      toast.success(allow ? `“${d.name}” can now use Vesper.` : `“${d.name}” was denied.`)
    } catch (e) {
      toast.error(toApiError(e).message)
    } finally {
      setAnswering(null)
    }
  }

  const describe = (d: DeviceInfo): string => {
    const parts = [listenerLabel(d.listener), kindLabel(d.kind)]
    if (d.pending) parts.push(`asked ${relativeAge(d.createdUtc, now, zone)}`)
    else if (d.lastSeenUtc) parts.push(`seen ${relativeAge(d.lastSeenUtc, now, zone)}`)
    if (d.lastIp && d.listener !== 'loopback') parts.push(d.lastIp)
    return parts.join(' · ')
  }

  return (
    <>
      <List aria-label="Devices" inset dividers className="dev-list">
        {list.map((d) => (
          <ListItem
            key={d.id}
            icon={ICON[deviceIcon(d)]}
            title={
              <span className="dev-title">
                <span className="dev-title__name">{d.name}</span>
                {d.current ? (
                  <Badge tone="accent" size="sm">
                    This device
                  </Badge>
                ) : null}
                {d.pending ? (
                  <Badge tone="warning" size="sm" dot>
                    Waiting for approval
                  </Badge>
                ) : null}
              </span>
            }
            description={describe(d)}
            actionsVisible
            actions={
              d.pending && desktop ? (
                <span className="dev-actions">
                  <Button size="sm" variant="ghost" icon={<X />} disabled={answering === d.id} onClick={() => void answer(d, false)} aria-label={`Deny ${d.name}`}>
                    Deny
                  </Button>
                  <Button size="sm" variant="primary" icon={<Check />} loading={answering === d.id} onClick={() => void answer(d, true)} aria-label={`Allow ${d.name}`}>
                    Allow
                  </Button>
                </span>
              ) : d.kind === 'desktop' ? null : d.current ? (
                <Button size="sm" variant="ghost" icon={<LogOut />} onClick={() => void signOut()}>
                  Sign out
                </Button>
              ) : (
                <Button size="sm" variant="ghost" icon={<UserX />} onClick={() => setRevoking(d)} aria-label={`Revoke ${d.name}`}>
                  Revoke
                </Button>
              )
            }
          />
        ))}
      </List>
      {others.length === 0 ? (
        <EmptyState
          size="sm"
          headingLevel={3}
          icon={<Smartphone />}
          title="No other devices yet"
          description={desktop ? 'Pair a phone or laptop to use Vesper there too.' : 'Devices you sign in on appear here.'}
        />
      ) : null}
      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        tone="danger"
        title={revoking ? `Sign out “${revoking.name}”?` : ''}
        description="It is signed out right away and any open Vesper page on it closes. To come back it needs the password or a new pairing code."
        confirmLabel="Revoke access"
        onConfirm={async () => {
          if (!revoking) return
          const name = revoking.name
          await revokeDevice(revoking.id)
          toast.success(`“${name}” was signed out.`)
        }}
      />
    </>
  )
}
