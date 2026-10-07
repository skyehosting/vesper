/**
 * Settings → Privacy (R21, 07 B9/B13/B17/B18): every disclosure from src/shared/privacy.ts, grouped by the services
 * this setup actually uses (AI profiles, Voyage memory, voice out, voice in, other devices) with "leaves this PC"
 * badges, what is sent, training, retention, how to opt out and the verified sources; OpenRouter routing switches and
 * Deepgram's mip_opt_out state; what stays on this PC; private and temporary chats; notification previews (off by
 * default); update checks (H-v12-updates: GitHub sees the IP address and version); and where the data lives, with
 * "Open folder" on the desktop. Services not in use are listed at the end.
 */
import { useMemo, type ReactNode } from 'react'
import { INTERVAL_LABELS } from '@shared/updater.logic'
import { CheckCircle2, CloudUpload, Copy, FolderOpen, MonitorSmartphone, ShieldCheck } from 'lucide-react'
import type { Disclosure } from '@shared/privacy'
import { disclosure, llmMayForward } from '@shared/privacy'
import { Badge, LeavesPcBadge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { copyText } from '../../components'
import { Disclosure as Expander } from '../../components/Disclosure'
import { EmptyState } from '../../components/EmptyState'
import { Switch } from '../../components/Switch'
import { toast } from '../../components/Toast'
import { useStore } from '../../lib/store'
import { openFolder } from '../settings/folders'
import type { SettingsSectionProps } from '../settings/sections'
import { Group, Page, Row } from '../memory/layout'
import { useCanEdit, useIsDesktop, usePatchSettings, useSettings, voyageKeyKnown } from '../memory/settings'
import { useLive } from '../memory/live'
import { memoryStatus } from '../memory/stores'
import { TEMPORARY_CHAT_TEXT } from '../sessions/temporaryChat.logic'
import { verifiedLabel, VoyagePrivacy } from '../memory/VoyagePrivacy'
import { ExternalLink, sourceLabel } from './ExternalLink'
import { GROUP_LABELS, localOnly, otherDisclosures, privacyHeadline, servicesInUse, trainingLabel, type ServiceInUse } from './privacy.logic'
import '../memory/memory.css'
import './privacy.css'

export default function SettingsPrivacy(_props: SettingsSectionProps): ReactNode {
  const settings = useSettings()
  const secrets = useStore((s) => s.bootstrap?.secretsSet ?? [])
  const paths = useStore((s) => s.bootstrap?.dataPaths ?? null)
  const desktop = useIsDesktop()
  const canPreviews = useCanEdit('chat.notificationPreviews')
  const patch = usePatchSettings()
  const { data: memStatus } = useLive(memoryStatus)
  // A key saved after this page loaded (or on another device) shows in the live memory status.
  const keyKnown = voyageKeyKnown(secrets.includes('voyage'), memStatus?.state)
  const secretNames = useMemo(() => (keyKnown && !secrets.includes('voyage') ? [...secrets, 'voyage'] : secrets), [secrets, keyKnown])
  const inUse = useMemo(() => (settings ? servicesInUse(settings, secretNames) : []), [settings, secretNames])
  const others = useMemo(() => otherDisclosures(inUse), [inUse])
  if (!settings) return null
  const welcome = disclosure('welcome')
  const updatesDisclosure = disclosure('updates')
  const headline = privacyHeadline(inUse)

  const setOpenRouter = (profileId: string, key: 'openrouterNoTraining' | 'openrouterZdr', v: boolean): void => {
    const profiles = settings.llm.profiles.map((p) => (p.id === profileId ? { ...p, options: { ...p.options, [key]: v } } : p))
    void patch({ llm: { profiles } })
  }

  return (
    <Page
      title="Privacy"
      description={welcome?.summary}
      actions={
        <Badge tone={headline.tone} icon={headline.tone === 'success' ? <ShieldCheck /> : <CloudUpload />}>
          {headline.text}
        </Badge>
      }
    >
      <Group
        id="priv-out"
        title="What leaves this PC"
        description="The services this setup uses, what each receives and what it does with it."
      >
        {inUse.length === 0 ? (
          <Row>
            <EmptyState
              size="sm"
              icon={<ShieldCheck />}
              title="No services set up yet"
              description="When you add an AI provider, memory or a voice, what it receives appears here."
              headingLevel={3}
            />
          </Row>
        ) : (
          inUse.map((u) => (
            <Row key={u.key}>
              <ServiceCard u={u} desktop={desktop} onOpenRouter={setOpenRouter} />
            </Row>
          ))
        )}
      </Group>

      <Group id="priv-local" title="Stays on this PC">
        {localOnly(settings).map((l) => (
          <Row
            key={l.key}
            label={
              <span className="plocal">
                {<CheckCircle2 aria-hidden="true" />}
                {l.title}
              </span>
            }
            description={l.detail}
          />
        ))}
      </Group>

      <Group id="priv-chats" title="Private and temporary chats">
        <Row
          label="Private chats"
          description="Never sent to Voyage, never recalled from other chats, and searched only by keywords within themselves. Text sent to Voyage before you made a chat private stays with Voyage."
        />
        <Row
          label="Temporary chats"
          description={TEMPORARY_CHAT_TEXT}
        />
      </Group>

      <Group id="priv-notify" title="Notifications">
        <Row setting="chat.notificationPreviews">
          <Switch
            checked={settings.chat.notificationPreviews}
            disabled={!canPreviews}
            onChange={(v) => void patch({ chat: { notificationPreviews: v } })}
            label="Show message text in notifications"
            description="Off: notifications only say that a reply arrived, so nothing private shows on a lock screen or a shared screen."
          />
        </Row>
      </Group>

      <Group id="priv-updates" title="Update checks">
        <Row
          label={updatesDisclosure?.service}
          description={updatesDisclosure?.summary}
          control={
            <Badge tone="neutral">{settings.updates.checkEvery === 'off' ? 'Off' : INTERVAL_LABELS[settings.updates.checkEvery]}</Badge>
          }
        />
      </Group>

      <Group id="priv-paths" title="Where your data lives">
        {paths ? (
          <>
            <PathRow label="Settings, chats, memory, backups" path={paths.roaming} which="roaming" />
            <PathRow label="Speech models, logs and caches" path={paths.local} which="local" />
          </>
        ) : (
          <Row
            label="Data folders"
            description="Shown only in the Vesper app on your PC."
            control={<MonitorSmartphone className="pmuted" aria-hidden="true" />}
          />
        )}
      </Group>

      {others.length ? (
        <Expander summary={`Other services Vesper can use (${others.length})`} variant="card" headingLevel={3} className="pothers">
          <ul className="pothers__list">
            {others.map((d) => (
              <li key={d.id} className="pothers__item">
                <p className="pothers__name">
                  {d.service} {d.training !== 'local' ? (
                    <Badge tone="neutral">would receive text</Badge>
                  ) : llmMayForward(d.id) ? (
                    <Badge tone="neutral">on this PC, unless it forwards</Badge>
                  ) : (
                    <Badge tone="success">on this PC</Badge>
                  )}
                </p>
                <p className="pothers__text">{d.summary}</p>
                <Sources d={d} />
              </li>
            ))}
          </ul>
        </Expander>
      ) : null}
    </Page>
  )
}

function Sources({ d }: { d: Disclosure }): ReactNode {
  if (!d.sources.length && !d.verified) return null
  return (
    <p className="psources">
      {d.sources.map((s) => (
        <ExternalLink key={s} href={s}>
          {sourceLabel(s)}
        </ExternalLink>
      ))}
      {d.verified ? <span className="psources__checked">Checked {verifiedLabel(d.verified)}</span> : null}
    </p>
  )
}

function ServiceCard({
  u,
  desktop,
  onOpenRouter
}: {
  u: ServiceInUse
  desktop: boolean
  onOpenRouter: (id: string, key: 'openrouterNoTraining' | 'openrouterZdr', v: boolean) => void
}): ReactNode {
  const d = u.disclosure
  const tr = trainingLabel(d.training)
  return (
    <article className="psvc" aria-label={`${d.service}: ${u.use}`} data-testid="privacy-service" data-service={d.id}>
      <header className="psvc__head">
        <div className="psvc__titles">
          <p className="psvc__group">{GROUP_LABELS[u.group]}</p>
          <h4 className="psvc__name">{d.service}</h4>
          <p className="psvc__use">{u.use}</p>
        </div>
        <div className="psvc__badges">
          {u.leaves ? (
            <LeavesPcBadge service={d.service} />
          ) : u.mayLeave ? (
            <Badge tone="neutral" icon={<CloudUpload />}>
              On this PC, unless the program forwards it
            </Badge>
          ) : (
            <Badge tone="success" icon={<ShieldCheck />}>
              Stays on this PC
            </Badge>
          )}
          {d.training !== 'local' ? <Badge tone={tr.tone}>{tr.text}</Badge> : null}
        </div>
      </header>
      {u.key === 'voyage' ? (
        <VoyagePrivacy compact headingLevel={4} />
      ) : (
        <>
          <p className="psvc__summary">{d.summary}</p>
          <dl className="psvc__facts">
            <div>
              <dt>Sends</dt>
              <dd>{d.sends}</dd>
            </div>
            <div>
              <dt>Keeps</dt>
              <dd>{d.retention}</dd>
            </div>
            {d.optOutHow ? (
              <div>
                <dt>Opt out</dt>
                <dd>{d.optOutHow}</dd>
              </div>
            ) : null}
          </dl>
        </>
      )}
      {u.notes.length ? (
        <ul className="psvc__notes">
          {u.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      {u.openrouter && u.profileId ? (
        <div className="psvc__switches">
          <Switch
            size="sm"
            checked={u.openrouter.noTraining}
            disabled={!desktop}
            onChange={(v) => onOpenRouter(u.profileId as string, 'openrouterNoTraining', v)}
            label="Only providers that don’t train on prompts"
            description="Sends provider.data_collection = deny."
          />
          <Switch
            size="sm"
            checked={u.openrouter.zdr}
            disabled={!desktop}
            onChange={(v) => onOpenRouter(u.profileId as string, 'openrouterZdr', v)}
            label="Zero-retention providers only"
            description="Many free models then refuse with an error."
          />
        </div>
      ) : null}
      {u.key !== 'voyage' ? <Sources d={d} /> : null}
    </article>
  )
}

function PathRow({ label, path, which }: { label: string; path: string; which: 'roaming' | 'local' }): ReactNode {
  // Explorer opens on the PC only; other devices can copy the path.
  const desktop = useIsDesktop()
  return (
    <Row
      label={label}
      description={<span className="ppath mono">{path}</span>}
      control={
        <>
          <Button
            size="sm"
            variant="ghost"
            icon={<Copy />}
            aria-label={`Copy the path ${path}`}
            onClick={() => void copyText(path).then((ok) => (ok ? toast.success('Path copied.') : toast.error('Couldn’t copy the path.')))}
          >
            Copy
          </Button>
          {desktop ? (
            <Button size="sm" icon={<FolderOpen />} onClick={() => void openFolder(which)}>
              Open folder
            </Button>
          ) : null}
        </>
      }
    />
  )
}
