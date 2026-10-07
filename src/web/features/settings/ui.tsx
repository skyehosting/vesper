/**
 * Building blocks for Settings pages (and the wizard): page header, groups, the "Advanced" disclosure (07 D12), and
 * controls bound to one setting each. Every bound control renders `data-setting="<dot.path>"` on its row — the
 * convention Settings search scrolls to and the coverage test reads (`setting="…"` / `data-setting="…"` literals).
 * Other features' pages may use these too (export from features/settings/ui).
 *
 *   <SwitchSetting setting="chat.autoTitle" label="Name chats automatically" />
 */
import { useEffect, useId, useState, type ReactNode } from 'react'
import { CircleAlert, ExternalLink as ExternalIcon, Lock, SlidersHorizontal } from 'lucide-react'
import type { Settings } from '@shared/settings'
import { Banner } from '../../components/Callout'
import { Disclosure } from '../../components/Disclosure'
import { Segmented, type SegmentedOption } from '../../components/Segmented'
import { Select, type SelectOption } from '../../components/Select'
import { Slider, type SliderMark } from '../../components/Slider'
import { Switch } from '../../components/Switch'
import { TextField } from '../../components/TextField'
import { useStore } from '../../lib/store'
import type { SettingPath, ValueAt } from '../../lib/store/settings.logic'
import { canWritePath } from './write.logic'
import { maxLengthOf, rangeOf } from './schema.logic'
import { useSetting } from './save'
// Building blocks carry their styles: the wizard uses them without the Settings shell.
import './settings.css'

// ── layout ────────────────────────────────────────────────────────────────────────────────────
export function SettingsPageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }): ReactNode {
  return (
    <header className="spage__head">
      <div className="spage__head-text">
        <h1 className="spage__title">{title}</h1>
        {description ? <p className="spage__desc">{description}</p> : null}
      </div>
      {actions ? <div className="spage__head-actions">{actions}</div> : null}
    </header>
  )
}

/** A card of related rows. */
export function SettingsGroup({ title, description, children, actions, id }: { title?: ReactNode; description?: ReactNode; children: ReactNode; actions?: ReactNode; id?: string }): ReactNode {
  const auto = useId()
  const hid = `${id ?? auto}-h`
  return (
    <section className="sgroup" aria-labelledby={title ? hid : undefined} id={id}>
      {title || actions ? (
        <div className="sgroup__head">
          <div>
            {title ? (
              <h2 className="sgroup__title" id={hid}>
                {title}
              </h2>
            ) : null}
            {description ? <p className="sgroup__desc">{description}</p> : null}
          </div>
          {actions ? <div className="sgroup__actions">{actions}</div> : null}
        </div>
      ) : null}
      <div className="sgroup__body">{children}</div>
    </section>
  )
}

/** One row; `setting` sets `data-setting` for search and the coverage test. */
export function SettingRow({ setting, children, className, inline }: { setting?: string; children: ReactNode; className?: string; inline?: boolean }): ReactNode {
  return (
    <div className={['set-row', inline && 'set-row--inline', className].filter(Boolean).join(' ')} data-setting={setting}>
      {children}
    </div>
  )
}

export function RowError({ error }: { error: string | undefined }): ReactNode {
  if (!error) return null
  return (
    <p className="field-error set-row__error" role="alert">
      <CircleAlert aria-hidden="true" />
      <span>{error}</span>
    </p>
  )
}

/**
 * The page's "Advanced" part (07 D12). Opens itself when the shell asks (`open` — a search hit inside it) and
 * otherwise remembers the user's toggle while the page is shown.
 */
export function SettingsAdvanced({ open, children, summary = 'Advanced' }: { open?: boolean; children: ReactNode; summary?: ReactNode }): ReactNode {
  const [isOpen, setOpen] = useState(!!open)
  useEffect(() => {
    if (open) setOpen(true)
  }, [open])
  return (
    <Disclosure
      className="sadvanced"
      variant="card"
      headingLevel={2}
      open={isOpen}
      onOpenChange={setOpen}
      summary={
        <span className="sadvanced__summary">
          <SlidersHorizontal aria-hidden="true" />
          {summary}
        </span>
      }
    >
      <div className="sadvanced__body">{children}</div>
    </Disclosure>
  )
}

/** Remote devices: why the page is read-only (07 B2). */
export function ReadOnlyNotice({ paths }: { paths: readonly string[] }): ReactNode {
  const desktop = useStore((s) => s.bootstrap?.desktop ?? false)
  const remote = useStore((s) => s.settings?.access.remoteMayChangeSettings ?? false)
  if (desktop) return null
  const writable = paths.some((p) => canWritePath(p, { desktop, remoteMayChangeSettings: remote }))
  return (
    <Banner tone="info" icon={<Lock />} className="spage__notice">
      {writable
        ? 'Some of these settings can only be changed in the Vesper app on your PC.'
        : 'You can look at these settings here; change them in the Vesper app on your PC.'}
    </Banner>
  )
}

/** An http(s) link that opens in the system browser (desktop) or a new tab (07 B8: main re-validates the scheme). */
export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }): ReactNode {
  return (
    <a
      className={['set-xlink', className].filter(Boolean).join(' ')}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => {
        if (window.vesperDesktop?.openExternal) {
          e.preventDefault()
          void window.vesperDesktop.openExternal(href)
        }
      }}
    >
      {children}
      <ExternalIcon aria-hidden="true" />
      <span className="sr-only"> (opens in your browser)</span>
    </a>
  )
}

// ── bound controls ────────────────────────────────────────────────────────────────────────────
type PathOfType<V> = { [P in SettingPath]: ValueAt<Settings, P> extends V ? P : never }[SettingPath]

export function SwitchSetting({ setting, label, description, disabled }: { setting: PathOfType<boolean>; label: ReactNode; description?: ReactNode; disabled?: boolean }): ReactNode {
  const s = useSetting(setting)
  return (
    <SettingRow setting={setting}>
      <Switch checked={!!s.value} onChange={(v) => s.set(v as never, { immediate: true })} label={label} description={description} disabled={s.readOnly || disabled} />
      <RowError error={s.error} />
    </SettingRow>
  )
}

export function SegmentedSetting<V extends string>({
  setting,
  label,
  description,
  options
}: {
  setting: PathOfType<string>
  label: ReactNode
  description?: ReactNode
  options: readonly SegmentedOption<V>[]
}): ReactNode {
  const s = useSetting(setting)
  const id = useId()
  return (
    <SettingRow setting={setting} inline>
      <div className="set-row__text">
        <span className="set-row__label" id={`${id}-l`}>
          {label}
        </span>
        {description ? <span className="set-row__desc">{description}</span> : null}
      </div>
      <Segmented<V> value={s.value as V} onChange={(v) => s.set(v as never, { immediate: true })} options={options} aria-labelledby={`${id}-l`} disabled={s.readOnly} />
      <RowError error={s.error} />
    </SettingRow>
  )
}

export function SelectSetting<V extends string>({
  setting,
  label,
  hint,
  options,
  placeholder
}: {
  setting: PathOfType<string | null>
  label: ReactNode
  hint?: ReactNode
  options: readonly SelectOption<V>[]
  placeholder?: string
}): ReactNode {
  const s = useSetting(setting)
  return (
    <SettingRow setting={setting} className="set-row--field">
      <Select<V> value={(s.value as V | null) ?? null} onChange={(v) => s.set(v as never, { immediate: true })} options={options} label={label} hint={hint} error={s.error} disabled={s.readOnly} placeholder={placeholder} />
    </SettingRow>
  )
}

export function SliderSetting({
  setting,
  label,
  hint,
  format,
  step,
  marks
}: {
  setting: PathOfType<number>
  label: ReactNode
  hint?: ReactNode
  format?: (v: number) => string
  step?: number
  marks?: readonly SliderMark[]
}): ReactNode {
  const s = useSetting(setting)
  const r = rangeOf(setting)
  if (s.readOnly) {
    // Read-only devices see the value, not a dimmed slider (07 B2; a disabled slider's marks fail contrast).
    return (
      <SettingRow setting={setting} inline>
        <div className="set-row__text">
          <span className="set-row__label">{label}</span>
          {hint ? <span className="set-row__desc">{hint}</span> : null}
        </div>
        <span className="set-row__value tabular">{(format ?? String)(Number(s.value))}</span>
      </SettingRow>
    )
  }
  return (
    <SettingRow setting={setting} className="set-row--slider">
      <Slider
        value={Number(s.value)}
        onChange={(v) => s.set(v as never)}
        min={r.min}
        max={r.max}
        step={step ?? (r.int ? 1 : (r.max - r.min) / 100)}
        label={label}
        hint={hint}
        format={format}
        marks={marks}
        disabled={s.readOnly}
      />
      <RowError error={s.error} />
    </SettingRow>
  )
}

/** Free text, saved after typing pauses (debounced) — the draft stays while the field is focused. */
export function TextSetting({
  setting,
  label,
  hint,
  placeholder,
  validate
}: {
  setting: PathOfType<string>
  label: ReactNode
  hint?: ReactNode
  placeholder?: string
  /** Client-side check; a message keeps the draft unsaved. */
  validate?: (v: string) => string | null
}): ReactNode {
  const s = useSetting(setting)
  const [draft, setDraft] = useState<string | null>(null)
  const [local, setLocal] = useState<string | null>(null)
  const value = draft ?? String(s.value ?? '')
  return (
    <SettingRow setting={setting} className="set-row--field">
      <TextField
        label={label}
        hint={hint}
        value={value}
        placeholder={placeholder}
        maxLength={maxLengthOf(setting) ?? undefined}
        readOnly={s.readOnly}
        error={local ?? s.error}
        onFocus={() => setDraft(String(s.value ?? ''))}
        onBlur={() => setDraft(null)}
        onChange={(e) => {
          const v = e.target.value
          setDraft(v)
          const problem = validate?.(v) ?? null
          setLocal(problem)
          if (!problem) s.set(v as never)
        }}
      />
    </SettingRow>
  )
}

/** A bounded number typed in (with a unit); out-of-range input says so and isn't saved. */
export function NumberSetting({
  setting,
  label,
  hint,
  unit,
  scale = 1
}: {
  setting: PathOfType<number>
  label: ReactNode
  hint?: ReactNode
  unit?: string
  /** Display = stored × scale (e.g. 100 for a fraction shown as %). */
  scale?: number
}): ReactNode {
  const s = useSetting(setting)
  const r = rangeOf(setting)
  const [draft, setDraft] = useState<string | null>(null)
  const [local, setLocal] = useState<string | null>(null)
  const shown = draft ?? String(Math.round(Number(s.value) * scale * 100) / 100)
  const commit = (raw: string): void => {
    const n = Number(raw)
    const min = r.min * scale
    const max = r.max * scale
    if (raw.trim() === '' || !Number.isFinite(n) || n < min || n > max) {
      setLocal(`Enter a number from ${min} to ${max}.`)
      return
    }
    setLocal(null)
    const v = r.int ? Math.round(n / scale) : n / scale
    if (v !== s.value) s.set(v as never, { immediate: true })
  }
  return (
    <SettingRow setting={setting} className="set-row--field set-row--number">
      <TextField
        label={label}
        hint={hint ?? `${r.min * scale}–${r.max * scale}${unit ? ` ${unit}` : ''}`}
        inputMode="decimal"
        value={shown}
        readOnly={s.readOnly}
        error={local ?? s.error}
        trailing={unit ? <span className="set-row__unit">{unit}</span> : undefined}
        onFocus={() => setDraft(shown)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => {
          commit(e.target.value)
          setDraft(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(e.currentTarget.value)
        }}
      />
    </SettingRow>
  )
}
