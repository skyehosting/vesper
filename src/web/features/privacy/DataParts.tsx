/**
 * Settings → Data sections (07 A4, C9, C20, E8): storage use, export (Markdown per chat / everything as a ZIP; Vesper
 * JSON with attachments) with `job.progress`, import (Vesper JSON/ZIP, ChatGPT conversations.json or its ZIP, Claude
 * export) with a preview of what the file holds before anything is sent, upload + import progress and a result
 * summary, and backups (settings, list, back up now, restore → restart). All bulk routes are sudo (07 B2).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArchiveRestore, DatabaseBackup, Download, FileJson, FileText, FolderOpen, HardDrive, Upload, X } from 'lucide-react'
import type { ImportResult } from '@shared/api'
import type { DataUsage } from '@shared/types/domain'
import type { ApiError } from '@shared/errors'
import { formatShortId } from '@shared/ids'
import { formatDate } from '@shared/time'
import { Button } from '../../components/Button'
import { Callout } from '../../components/Callout'
import { Combobox } from '../../components/Combobox'
import { useConfirm } from '../../components/ConfirmDialog'
import { FileDrop } from '../../components/FileDrop'
import { ProgressBar } from '../../components/Progress'
import { Segmented } from '../../components/Segmented'
import { Skeleton } from '../../components/Skeleton'
import { toast } from '../../components/Toast'
import { api } from '../../lib/api'
import { isApiError, toApiError } from '../../lib/errors.logic'
import { navigate } from '../../lib/router'
import { ws } from '../../lib/ws'
import { Row } from '../memory/layout'
import { useLive } from '../memory/live'
import { manifest } from '../memory/stores'
import { byActivity } from '../memory/manifest.logic'
import { errorText, formatCount, formatSize, plural } from '../memory/format.logic'
import { useViewerZone } from '../memory/zone'
import { startExport, uploadImport, ensureSudo } from './dataApi'
import { previewImport } from './importPreview'
import { MAX_IMPORT_BYTES, SOURCE_LABELS, type ImportPreview } from './importPreview.logic'
import { openFolder } from '../settings/folders'

type Job = 'export' | 'import' | 'backup'
export interface JobState {
  phase: string
  done: number
  total: number | null
}

/** Progress of this device's bulk job (`job.progress` goes to the requesting device only). */
export function useJobProgress(job: Job, active: boolean): JobState | null {
  const [st, setSt] = useState<JobState | null>(null)
  useEffect(() => {
    if (!active) {
      setSt(null)
      return
    }
    return ws.on('job.progress', (m) => {
      if (m.job === job) setSt({ phase: m.phase, done: m.done, total: m.total })
    })
  }, [job, active])
  return st
}

// ── storage ───────────────────────────────────────────────────────────────────────────────────
const PARTS: { key: keyof DataUsage; label: string; tone: string }[] = [
  { key: 'database', label: 'Chats & memory', tone: 'var(--accent)' },
  { key: 'attachments', label: 'Attachments', tone: '#7dd3fc' },
  { key: 'backups', label: 'Backups', tone: '#a78bfa' },
  { key: 'models', label: 'Speech models', tone: '#34d399' },
  { key: 'logs', label: 'Logs & exports', tone: 'var(--text-2)' }
]

export function StorageUsage({ desktop }: { desktop: boolean }): ReactNode {
  const [usage, setUsage] = useState<DataUsage | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const load = useCallback(() => {
    const ctl = new AbortController()
    api('GET /api/data/usage', { signal: ctl.signal }).then(setUsage, (e: unknown) => {
      if (!(e instanceof DOMException)) setError(toApiError(e))
    })
    return ctl
  }, [])
  useEffect(() => {
    const ctl = load()
    return () => ctl.abort()
  }, [load])
  if (error && !usage) return <p className="mnote">{`Couldn’t measure the data folders: ${error.message}`}</p>
  if (!usage) return <Skeleton variant="rect" height={56} />
  const value = (k: keyof DataUsage): number =>
    k === 'database' ? usage.database + usage.wal : k === 'logs' ? usage.logs + usage.exports : (usage[k] as number)
  const total = PARTS.reduce((n, p) => n + value(p.key), 0)
  return (
    <div className="dusage" data-testid="data-usage">
      <div className="dusage__head">
        <span className="dusage__total">{formatSize(total)}</span>
        <span className="dusage__free">{usage.freeDisk !== null ? `${formatSize(usage.freeDisk)} free on this drive` : ''}</span>
      </div>
      <div className="dusage__bar" role="img" aria-label={PARTS.map((p) => `${p.label} ${formatSize(value(p.key))}`).join(', ')}>
        {PARTS.map((p) => {
          const v = value(p.key)
          return v > 0 && total > 0 ? <span key={p.key} style={{ width: `${Math.max(1.5, (v / total) * 100)}%`, background: p.tone }} /> : null
        })}
      </div>
      <ul className="dusage__legend">
        {PARTS.map((p) => (
          <li key={p.key}>
            <span className="dusage__swatch" style={{ background: p.tone }} aria-hidden="true" />
            <span>{p.label}</span>
            <span className="dusage__size tabular">{formatSize(value(p.key))}</span>
          </li>
        ))}
      </ul>
      {desktop ? (
        <div className="dusage__actions">
          <Button size="sm" icon={<FolderOpen />} onClick={() => void openFolder('roaming')}>
            Open data folder
          </Button>
          <Button size="sm" variant="ghost" icon={<FolderOpen />} onClick={() => void openFolder('exports')}>
            Exports folder
          </Button>
        </div>
      ) : null}
    </div>
  )
}

// ── export ────────────────────────────────────────────────────────────────────────────────────
export function ExportSection(): ReactNode {
  const [format, setFormat] = useState<'md' | 'json'>('json')
  const [one, setOne] = useState<string | null>(null)
  const [oneFormat, setOneFormat] = useState<'md' | 'json'>('md')
  const [running, setRunning] = useState(false)
  const progress = useJobProgress('export', running)
  const { data } = useLive(manifest)
  const sessions = useMemo(() => [...(data?.sessions ?? [])].sort(byActivity), [data])
  const finished = progress !== null && progress.total !== null && progress.done >= progress.total

  useEffect(() => {
    if (!finished) return
    const t = window.setTimeout(() => setRunning(false), 2500)
    return () => window.clearTimeout(t)
  }, [finished])
  // A one-chat export sends little or no progress: stop showing "preparing" after a while.
  useEffect(() => {
    if (!running) return
    const t = window.setTimeout(() => setRunning(false), 120_000)
    return () => window.clearTimeout(t)
  }, [running])

  const go = async (o: { format: 'md' | 'json'; session?: string }): Promise<void> => {
    try {
      await startExport(o)
      setRunning(true)
      toast.info(o.session ? 'Preparing the export…' : 'Preparing the export — the download starts when it’s ready.')
    } catch (e) {
      if (!isApiError(e, 'sudo_required')) toast.error(toApiError(e).message)
    }
  }

  return (
    <>
      <Row
        stack
        label="Everything"
        description={
          format === 'json'
            ? 'A ZIP with every chat, attachments, prompts and pinned facts in Vesper’s format — it can be imported back.'
            : 'A ZIP with one Markdown file per chat, easy to read anywhere.'
        }
      >
        <div className="dexport-one">
          <Segmented
            aria-label="Export format"
            size="sm"
            value={format}
            onChange={setFormat}
            options={[
              { value: 'json', label: 'Vesper JSON', icon: <FileJson /> },
              { value: 'md', label: 'Markdown', icon: <FileText /> }
            ]}
          />
          <Button size="sm" variant="primary" icon={<Download />} disabled={running} onClick={() => void go({ format })}>
            Export all
          </Button>
        </div>
      </Row>
      <Row label="One chat" description="Just this conversation, as a single file.">
        <div className="dexport-one">
          <Combobox
            label="Chat to export"
            labelHidden
            size="sm"
            placeholder="Choose a chat…"
            value={one}
            onChange={setOne}
            options={sessions.map((s) => ({
              value: s.uid,
              label: s.title || 'New chat',
              description: `${formatShortId(s.shortId)} · ${plural(s.messageCount, 'message')}`,
              keywords: [s.shortId]
            }))}
            wrapClassName="dexport-one__pick"
          />
          <Segmented
            aria-label="Format for one chat"
            size="sm"
            value={oneFormat}
            onChange={setOneFormat}
            options={[
              { value: 'md', label: 'Markdown' },
              { value: 'json', label: 'JSON' }
            ]}
          />
          <Button size="sm" icon={<Download />} disabled={!one || running} onClick={() => one && void go({ format: oneFormat, session: one })}>
            Export
          </Button>
        </div>
      </Row>
      {running ? (
        <Row>
          <ProgressBar
            label={finished ? 'Done — your download is starting' : 'Preparing the export'}
            value={progress && progress.total ? progress.done / progress.total : undefined}
            valueText={progress && progress.total ? `${formatCount(progress.done)} of ${plural(progress.total, 'chat')}` : undefined}
            tone={finished ? 'success' : 'accent'}
          />
        </Row>
      ) : null}
    </>
  )
}

// ── import ────────────────────────────────────────────────────────────────────────────────────
type ImportStep =
  | { k: 'idle' }
  | { k: 'reading'; file: File }
  | { k: 'preview'; file: File; preview: ImportPreview }
  | { k: 'uploading'; file: File; preview: ImportPreview; loaded: number; total: number }
  | { k: 'done'; result: ImportResult }
  | { k: 'error'; message: string; file?: File }

export function ImportSection({ memoryOn }: { memoryOn: boolean }): ReactNode {
  const [step, setStep] = useState<ImportStep>({ k: 'idle' })
  const ctl = useRef<AbortController | null>(null)
  const progress = useJobProgress('import', step.k === 'uploading')
  const { zone } = useViewerZone()

  useEffect(() => () => ctl.current?.abort(), [])

  const pick = async (file: File): Promise<void> => {
    ctl.current?.abort()
    if (file.size > MAX_IMPORT_BYTES) {
      setStep({
        k: 'error',
        message: `That file is ${formatSize(file.size)}; imports can be up to 200 MB. For a bigger ChatGPT export, unzip it and choose conversations.json.`
      })
      return
    }
    const c = new AbortController()
    ctl.current = c
    setStep({ k: 'reading', file })
    const r = await previewImport(file, c.signal)
    if (c.signal.aborted) return
    setStep(r.ok ? { k: 'preview', file, preview: r.preview } : { k: 'error', message: r.message, file })
  }

  const run = async (file: File, preview: ImportPreview): Promise<void> => {
    try {
      await ensureSudo()
    } catch (e) {
      if (!isApiError(e, 'sudo_required')) setStep({ k: 'error', message: toApiError(e).message, file })
      return
    }
    const c = new AbortController()
    ctl.current = c
    setStep({ k: 'uploading', file, preview, loaded: 0, total: file.size })
    try {
      const result = await uploadImport(file, {
        signal: c.signal,
        onProgress: (loaded, total) => setStep((s) => (s.k === 'uploading' ? { ...s, loaded, total } : s))
      })
      setStep({ k: 'done', result })
    } catch (e) {
      if (c.signal.aborted) setStep({ k: 'preview', file, preview })
      else setStep({ k: 'error', message: errorText(toApiError(e)), file })
    }
  }

  const range = (p: ImportPreview): string => {
    if (p.firstUtc === null || p.lastUtc === null) return ''
    const a = formatDate(zone.partsAt(p.firstUtc)).split(' ').slice(2).join(' ')
    const b = formatDate(zone.partsAt(p.lastUtc)).split(' ').slice(2).join(' ')
    return a === b ? `, from ${a}` : `, ${a} – ${b}`
  }

  return (
    <Row stack>
      <div className="dimport">
        {step.k === 'idle' || step.k === 'error' ? (
          <>
            <FileDrop
              accept=".json,.zip,application/json,application/zip"
              maxFiles={1}
              multiple={false}
              maxBytes={MAX_IMPORT_BYTES}
              label="Drop an export here, or browse"
              hint="ChatGPT (conversations.json or the whole ZIP), Claude (conversations.json) or a Vesper export. Up to 200 MB."
              onFiles={(ok) => ok[0] && void pick(ok[0])}
            />
            {step.k === 'error' ? (
              <Callout tone="danger" title="That file can’t be imported">
                {step.message}
              </Callout>
            ) : null}
            <p className="mnote">
              Imported chats keep their original dates, so memory and time awareness work from day one. Chats imported before are skipped. Nothing is sent to an
              AI or to Voyage by importing.
            </p>
          </>
        ) : step.k === 'reading' ? (
          <div className="dimport__reading" data-loading>
            <ProgressBar label={`Reading ${step.file.name}…`} />
            <Button size="sm" variant="ghost" icon={<X />} onClick={() => (ctl.current?.abort(), setStep({ k: 'idle' }))}>
              Cancel
            </Button>
          </div>
        ) : step.k === 'preview' || step.k === 'uploading' ? (
          <div className="dimport__preview" data-testid="import-preview">
            <p className="dimport__title">
              <Upload aria-hidden="true" />
              {`Import ${plural(step.preview.conversations, 'conversation')} (~${plural(step.preview.messages, 'message')}) from ${SOURCE_LABELS[step.preview.source]}${range(step.preview)}?`}
            </p>
            <p className="mnote">
              {step.file.name} · {formatSize(step.file.size)}
              {step.preview.prompts || step.preview.facts
                ? ` · also ${plural(step.preview.prompts, 'saved prompt')} and ${plural(step.preview.facts, 'pinned fact')}`
                : ''}
            </p>
            {step.preview.titles.length ? (
              <ul className="dimport__titles" aria-label="Some of the conversations">
                {step.preview.titles.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
                {step.preview.conversations > step.preview.titles.length ? (
                  <li className="dimport__more">{`and ${formatCount(step.preview.conversations - step.preview.titles.length)} more`}</li>
                ) : null}
              </ul>
            ) : null}
            {step.k === 'uploading' ? (
              <ProgressBar
                label={progress ? 'Importing conversations' : step.loaded < step.total ? 'Uploading' : 'Reading the file on your PC'}
                value={
                  progress && progress.total ? progress.done / progress.total : step.loaded < step.total ? step.loaded / Math.max(1, step.total) : undefined
                }
                valueText={
                  progress && progress.total
                    ? `${formatCount(progress.done)} of ${formatCount(progress.total)}`
                    : step.loaded < step.total
                      ? `${formatSize(step.loaded)} of ${formatSize(step.total)}`
                      : undefined
                }
              />
            ) : null}
            <div className="dimport__actions">
              <Button onClick={() => (step.k === 'uploading' ? ctl.current?.abort() : setStep({ k: 'idle' }))}>Cancel</Button>
              <Button
                variant="primary"
                icon={<Upload />}
                loading={step.k === 'uploading'}
                disabled={step.preview.conversations === 0}
                onClick={() => step.k === 'preview' && void run(step.file, step.preview)}
              >
                Import
              </Button>
            </div>
          </div>
        ) : (
          <ImportDone result={step.result} memoryOn={memoryOn} onAgain={() => setStep({ k: 'idle' })} />
        )}
      </div>
    </Row>
  )
}

function ImportDone({ result, memoryOn, onAgain }: { result: ImportResult; memoryOn: boolean; onAgain: () => void }): ReactNode {
  const nothing = result.sessions === 0
  return (
    <div className="dimport__done" data-testid="import-result" role="status">
      <Callout
        tone={nothing ? 'info' : 'success'}
        title={nothing ? 'Nothing new to import' : `Imported ${plural(result.sessions, 'conversation')} from ${SOURCE_LABELS[result.source]}`}
      >
        <ul className="dimport__stats">
          <li>{plural(result.messages, 'message')}</li>
          {result.attachments ? <li>{plural(result.attachments, 'attachment')}</li> : null}
          {result.skipped ? <li>{`${plural(result.skipped, 'conversation')} skipped (already imported, empty or unreadable)`}</li> : null}
        </ul>
        {!nothing ? <p>They appear in your chat list marked “Imported”, with their original dates.</p> : null}
        {!nothing && memoryOn ? <p>To let the AI recall them by meaning, index them in Settings → Memory → Past conversations.</p> : null}
      </Callout>
      <div className="dimport__actions">
        <Button onClick={onAgain}>Import another file</Button>
        {!nothing ? (
          <Button variant="primary" onClick={() => navigate('/memory/sessions')}>
            See the chats
          </Button>
        ) : null}
        {!nothing && memoryOn ? <Button onClick={() => navigate('/settings/memory')}>Index for memory</Button> : null}
      </div>
    </div>
  )
}

// ── backups ───────────────────────────────────────────────────────────────────────────────────
export interface BackupItem {
  file: string
  bytes: number
  createdUtc: number
}

export function backupKind(file: string): string {
  if (/pre-?migration/i.test(file)) return 'Before an update'
  if (/pre-?restore/i.test(file)) return 'Before a restore'
  if (/manual/i.test(file)) return 'Made by you'
  if (/weekly|w\d/i.test(file)) return 'Weekly'
  return 'Daily'
}

export function BackupsList({ desktop }: { desktop: boolean }): ReactNode {
  const [items, setItems] = useState<BackupItem[] | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [restarted, setRestarted] = useState(false)
  const { confirm, dialog } = useConfirm()
  const { zone, clock } = useViewerZone()

  // The list is sudo-gated (07 B2). Opening the page never asks for the password (F49: a phone or browser without a
  // recent password got the "Confirm it's you" prompt just for looking at storage); the inline "Show backups" asks.
  const [locked, setLocked] = useState(false)
  const load = useCallback(async (ask = false): Promise<void> => {
    try {
      setItems(await api('GET /api/backups', { noSudoRetry: !ask }))
      setError(null)
      setLocked(false)
    } catch (e) {
      const err = toApiError(e)
      setLocked(err.code === 'sudo_required')
      setError(err)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const now = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api('POST /api/backup')
      toast.success(`Backed up (${formatSize(r.bytes)}).`)
      await load(true)
    } catch (e) {
      toast.error(toApiError(e).message)
    } finally {
      setBusy(false)
    }
  }

  const restore = async (b: BackupItem): Promise<void> => {
    const ok = await confirm({
      title: 'Restore this backup?',
      description: `Vesper goes back to how it was on ${stamp(b.createdUtc)}. Anything newer is replaced; your current data is kept in a “pre-restore” folder first. Vesper restarts to finish.`,
      confirmLabel: 'Restore and restart',
      tone: 'danger'
    })
    if (!ok) return
    setRestoring(b.file)
    try {
      await api('POST /api/backups/restore', { body: { file: b.file } })
      setRestarted(true)
    } catch (e) {
      toast.error(toApiError(e).message)
    } finally {
      setRestoring(null)
    }
  }

  const stamp = (utc: number): string => {
    const p = zone.partsAt(utc)
    const hh =
      clock === '12h'
        ? `${p.hour % 12 || 12}:${String(p.minute).padStart(2, '0')} ${p.hour < 12 ? 'AM' : 'PM'}`
        : `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
    return `${formatDate(p)} ${hh}`
  }

  return (
    <>
      <Row
        label="Back up now"
        description="A copy of the database (chats, memory, settings history) in the backups folder. API keys are never in backups."
        control={
          <Button size="sm" icon={<DatabaseBackup />} loading={busy} onClick={() => void now()}>
            Back up now
          </Button>
        }
      />
      {restarted ? (
        <Row>
          <Callout tone="info" title="Restoring">
            The backup is restored when Vesper restarts. If it doesn’t restart by itself, quit Vesper from the tray and open it again.
          </Callout>
        </Row>
      ) : null}
      <Row stack label="Backups on this PC">
        {locked && !items ? (
          <div className="dbackups__locked">
            <p className="mnote dbackups__locked-note">Enter your Vesper password to see the backups on this PC.</p>
            <Button size="sm" icon={<HardDrive />} onClick={() => void load(true)}>
              Show backups
            </Button>
          </div>
        ) : error && !items ? (
          <p className="mnote">{error.message}</p>
        ) : !items ? (
          <Skeleton lines={3} />
        ) : items.length === 0 ? (
          <p className="mnote">No backups yet. Vesper makes one every day when the PC is idle.</p>
        ) : (
          <ul className="dbackups" aria-label="Backups">
            {[...items]
              .sort((a, b) => b.createdUtc - a.createdUtc)
              .map((b) => (
                <li key={b.file} className="dbackup">
                  <HardDrive aria-hidden="true" className="dbackup__icon" />
                  <span className="dbackup__text">
                    <span className="dbackup__when">{stamp(b.createdUtc)}</span>
                    <span className="dbackup__meta">
                      {backupKind(b.file)} · {formatSize(b.bytes)} · <span className="mono">{b.file}</span>
                    </span>
                  </span>
                  {desktop ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<ArchiveRestore />}
                      loading={restoring === b.file}
                      disabled={restoring !== null}
                      onClick={() => void restore(b)}
                    >
                      Restore…
                    </Button>
                  ) : null}
                </li>
              ))}
          </ul>
        )}
      </Row>
      {dialog}
    </>
  )
}
