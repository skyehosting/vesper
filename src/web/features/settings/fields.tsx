/**
 * Composite setting controls shared by Settings and the wizard: time zone (shown, editable — 07 D11 step 2) and the
 * 12/24-hour clock with a live preview of the stamp format the AI sees (07 C2).
 */
import { useId, useMemo, type CSSProperties, type ReactNode } from 'react'
import { CircleOff, Monitor, Moon, Sun } from 'lucide-react'
import { ACCENTS, type AccentId, type Settings } from '@shared/settings'
import { formatStamp, ianaZone, isValidZoneName } from '@shared/time'
import { Combobox } from '../../components/Combobox'
import { RadioGroup } from '../../components/RadioGroup'
import type { SelectOption } from '../../components/Select'
import { useStore } from '../../lib/store'
import { useMediaQuery } from '../../lib/useMediaQuery'
import { useSetting } from './save'
// Style previews (v1.1.3): stills of each style from the real renderers (Armilla speaking, on the real GPU), one per
// theme — static images, so the picker never asks for a second WebGL context (07 D5).
import armillaDark from './previews/armilla-dark.png'
import armillaLight from './previews/armilla-light.png'
import minimalDark from './previews/minimal2d-dark.png'
import minimalLight from './previews/minimal2d-light.png'
import nebulaDark from './previews/nebula-dark.png'
import nebulaLight from './previews/nebula-light.png'
import orbDark from './previews/orb-dark.png'
import orbLight from './previews/orb-light.png'
import { RowError, SegmentedSetting, SettingRow } from './ui'

const AUTO = '__auto__'

export function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function offsetLabel(zone: string, at: number): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')
    const v = part?.value ?? 'GMT'
    return v === 'GMT' ? 'UTC' : v.replace('GMT', 'UTC').replace('-', '−')
  } catch {
    return ''
  }
}

let zoneCache: SelectOption[] | null = null

/** IANA zones of this runtime with their current UTC offset (built once per page; ~420 entries). */
function zoneOptions(): SelectOption[] {
  if (zoneCache) return zoneCache
  const now = Date.now()
  let names: string[] = []
  try {
    names = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone')
  } catch {
    names = [deviceZone()]
  }
  zoneCache = names.map((n) => ({ value: n, label: n.replace(/_/g, ' '), meta: offsetLabel(n, now), keywords: [n.split('/').pop() ?? n] }))
  return zoneCache
}

export function TimeZoneSetting({ label = 'Time zone' }: { label?: ReactNode }): ReactNode {
  const s = useSetting('profile.timeZone')
  const device = deviceZone()
  const options = useMemo<SelectOption[]>(() => [{ value: AUTO, label: `Automatic — ${device.replace(/_/g, ' ')}`, meta: offsetLabel(device, Date.now()), keywords: ['automatic', 'device'] }, ...zoneOptions()], [device])
  const current = s.value && isValidZoneName(s.value) ? s.value : AUTO
  const zone = current === AUTO ? device : current
  const preview = useMemo(() => {
    try {
      return formatStamp(Date.now(), ianaZone(zone))
    } catch {
      return ''
    }
  }, [zone])
  return (
    <SettingRow setting="profile.timeZone" className="set-row--field">
      <Combobox
        label={label}
        value={current}
        options={options}
        placeholder="Search for a city or zone"
        disabled={s.readOnly}
        error={s.error}
        hint={preview ? `The AI sees your messages stamped like: ${preview}` : undefined}
        onChange={(v) => {
          if (v === null) return
          s.set(v === AUTO ? '' : v, { immediate: true })
        }}
      />
    </SettingRow>
  )
}

export function ClockSetting(): ReactNode {
  return (
    <SegmentedSetting
      setting="profile.clock"
      label="Clock"
      description="How times are written in chats."
      options={[
        { value: '24h', label: '14:03', 'aria-label': '24-hour, 14:03' },
        { value: '12h', label: '2:03 PM', 'aria-label': '12-hour, 2:03 PM' }
      ]}
    />
  )
}

// ── appearance pickers (Settings → Presence & appearance, wizard step 7) ──────────────────────
export const ACCENT_INFO: Record<AccentId, { label: string; hex: string }> = {
  gold: { label: 'Vesper gold', hex: '#f5b84c' },
  violet: { label: 'Dusk violet', hex: '#a78bfa' },
  rose: { label: 'Rose', hex: '#fb7185' },
  aurora: { label: 'Aurora', hex: '#34d399' },
  ice: { label: 'Ice', hex: '#7dd3fc' }
}

/** Five accent swatches as a native radio group (arrow keys move between them). */
export function AccentSetting(): ReactNode {
  const s = useSetting('appearance.accent')
  const id = useId()
  return (
    <SettingRow setting="appearance.accent" inline>
      <div className="set-row__text">
        <span className="set-row__label" id={`${id}-l`}>
          Accent color
        </span>
        <span className="set-row__desc">{ACCENT_INFO[s.value]?.label}</span>
      </div>
      <div className="swatches" role="radiogroup" aria-labelledby={`${id}-l`}>
        {ACCENTS.map((a) => (
          <label key={a} className="swatch" title={ACCENT_INFO[a].label} style={{ '--swatch': ACCENT_INFO[a].hex } as CSSProperties}>
            <input
              type="radio"
              className="swatch__input"
              name={`${id}-accent`}
              value={a}
              checked={s.value === a}
              disabled={s.readOnly}
              aria-label={ACCENT_INFO[a].label}
              onChange={() => s.set(a, { immediate: true })}
            />
            <span className="swatch__dot" aria-hidden="true" />
          </label>
        ))}
      </div>
    </SettingRow>
  )
}

export function ThemeSetting(): ReactNode {
  return (
    <SegmentedSetting
      setting="appearance.theme"
      label="Theme"
      description="System follows Windows' light or dark mode."
      options={[
        { value: 'dark', label: 'Dark', icon: <Moon /> },
        { value: 'light', label: 'Light', icon: <Sun /> },
        { value: 'system', label: 'System', icon: <Monitor /> }
      ]}
    />
  )
}

const STAR_STYLES: { value: StarStyle; label: string; description: string; preview?: { dark: string; light: string }; badge?: string }[] = [
  {
    value: 'armilla',
    label: 'Armilla',
    description: 'Rings of light around a liquid-glass bead; the long horizon line is the voice. 2D on phones.',
    preview: { dark: armillaDark, light: armillaLight },
    badge: 'Default'
  },
  { value: 'orb', label: 'Orb', description: 'A glowing core in a living corona. The full 3D presence.', preview: { dark: orbDark, light: orbLight } },
  { value: 'nebula', label: 'Nebula', description: 'A softer cloud of light that swirls as it speaks.', preview: { dark: nebulaDark, light: nebulaLight } },
  { value: 'minimal2d', label: 'Minimal', description: 'A flat star that pulses with the voice. Lightest on battery.', preview: { dark: minimalDark, light: minimalLight } },
  { value: 'off', label: 'Off', description: 'No animated presence; replies show a small static star.' }
]
type StarStyle = Settings['appearance']['star']['style']

/** The app's theme as shown (System follows Windows). */
function useLightUi(): boolean {
  const theme = useStore((s) => s.settings?.appearance.theme ?? 'dark')
  const osLight = useMediaQuery('(prefers-color-scheme: light)')
  return theme === 'light' || (theme === 'system' && osLight)
}

export function StarStyleSetting({ columns = 2 }: { columns?: 1 | 2 | 3 }): ReactNode {
  const s = useSetting('appearance.star.style')
  const light = useLightUi()
  return (
    <SettingRow setting="appearance.star.style">
      <RadioGroup<StarStyle>
        label="Star style"
        variant="cards"
        className="star-styles"
        columns={columns}
        value={s.value}
        disabled={s.readOnly}
        onChange={(v) => s.set(v, { immediate: true })}
        options={STAR_STYLES.map((o) => ({
          value: o.value,
          label: o.label,
          description: o.description,
          icon: o.preview ? <img src={light ? o.preview.light : o.preview.dark} alt="" width={104} height={60} decoding="async" draggable={false} /> : <CircleOff />,
          badge: o.badge
        }))}
      />
      <RowError error={s.error} />
    </SettingRow>
  )
}
