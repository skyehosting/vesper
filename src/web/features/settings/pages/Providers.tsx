/**
 * Settings → AI providers (R2, 07 D12): the profiles (add from a preset, edit, make default, delete), the default AI
 * and the helper ("utility") AI for titles, recaps and summaries (07 C18). Desktop only (07 B2): other devices see it
 * read-only. Keys are write-only; a profile's key is removed with it.
 */
import { useState, type ReactNode } from 'react'
import { ChevronDown, Cpu, Plus, Star, Trash2 } from 'lucide-react'
import { presetById } from '@shared/presets'
import type { PresetId } from '@shared/settings'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { useConfirm } from '../../../components/ConfirmDialog'
import { Dialog } from '../../../components/Dialog'
import { EmptyState } from '../../../components/EmptyState'
import { IconButton } from '../../../components/IconButton'
import { Select } from '../../../components/Select'
import { StatusDot } from '../../../components/StatusDot'
import { TextField } from '../../../components/TextField'
import { useStore } from '../../../lib/store'
import { setSettingRaw, useCanWrite, useSetting } from '../save'
import type { SettingsSectionProps } from '../sections'
import { Monogram, PresetPicker } from '../providers/PresetPicker'
import { ProfilesError, ProviderEditor, useProfiles } from '../providers/ProviderEditor'
import { newProfile, secretName } from '../providers/providers.logic'
import { ReadOnlyNotice, SelectSetting, SettingRow, SettingsGroup, SettingsPageHeader } from '../ui'

const PATHS = ['llm.profiles', 'llm.defaultProfile']

export default function SettingsProviders({ advanced }: SettingsSectionProps): ReactNode {
  const profiles = useProfiles()
  const defaultId = useStore((s) => s.settings?.llm.defaultProfile ?? null)
  const secretsSet = useStore((s) => s.bootstrap?.secretsSet ?? [])
  const { readOnly } = useCanWrite('llm.profiles')
  const [open, setOpen] = useState<string | null>(() => (profiles.length === 1 ? profiles[0].id : null))
  const [adding, setAdding] = useState(false)
  const [pick, setPick] = useState<PresetId | null>(null)
  const { confirm, dialog } = useConfirm()

  const add = (): void => {
    if (!pick) return
    const p = newProfile(
      pick,
      profiles.map((x) => x.id)
    )
    const next = [...profiles, p]
    setSettingRaw('llm.profiles', next, { immediate: true })
    if (!defaultId) setSettingRaw('llm.defaultProfile', p.id, { immediate: true })
    setAdding(false)
    setPick(null)
    setOpen(p.id)
  }

  const remove = async (id: string): Promise<void> => {
    const p = profiles.find((x) => x.id === id)
    if (!p) return
    const ok = await confirm({
      title: `Remove “${p.label}”?`,
      description: 'Its saved key is deleted too. Chats that used it switch to the default AI.',
      confirmLabel: 'Remove',
      tone: 'danger'
    })
    if (!ok) return
    const rest = profiles.filter((x) => x.id !== id)
    setSettingRaw('llm.profiles', rest, { immediate: true })
    if (defaultId === id) setSettingRaw('llm.defaultProfile', rest[0]?.id ?? null, { immediate: true })
    // The server deletes the removed profile's keys with the change (07 B1); mirror it locally.
    useStore.getState().markSecret(secretName(id), false)
  }

  return (
    <div className="spage">
      <SettingsPageHeader
        title="AI providers"
        description="The AI services Vesper talks to. Your keys stay encrypted on this PC and go only to the address they were saved for."
        actions={
          profiles.length && !readOnly ? (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              Add provider
            </Button>
          ) : undefined
        }
      />
      <ReadOnlyNotice paths={PATHS} />
      <ProfilesError />

      {profiles.length === 0 ? (
        <div className="sgroup__body sempty">
          <EmptyState
            icon={<Cpu />}
            title="No AI service yet"
            description="Connect OpenAI, Anthropic, OpenRouter, a model on this PC, or any OpenAI-compatible address."
            actions={
              readOnly ? undefined : (
                <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
                  Add provider
                </Button>
              )
            }
          />
        </div>
      ) : (
        <div className="profiles">
          {profiles.map((p) => {
            const preset = presetById(p.preset)
            const keyOk = !preset.keyRequired || secretsSet.includes(secretName(p.id))
            const isOpen = open === p.id
            return (
              <section key={p.id} className={`profile${isOpen ? ' is-open' : ''}`} aria-labelledby={`profile-${p.id}-name`}>
                <div className="profile__head">
                  <button type="button" className="profile__toggle" aria-expanded={isOpen} aria-controls={`profile-${p.id}-body`} onClick={() => setOpen(isOpen ? null : p.id)}>
                    <span aria-hidden="true">
                      <Monogram id={p.preset} />
                    </span>
                    <span className="profile__text">
                      <span className="profile__name" id={`profile-${p.id}-name`}>
                        {p.label}
                        {defaultId === p.id ? (
                          <Badge tone="accent" size="sm">
                            Default
                          </Badge>
                        ) : null}
                      </span>
                      <span className="profile__meta">
                        <StatusDot status={keyOk && p.model ? 'online' : 'warning'} label={keyOk ? (p.model ? 'Ready' : 'No model chosen') : 'No key saved'} />
                        <span className="profile__model mono">{p.model || (keyOk ? 'Choose a model' : 'Needs a key')}</span>
                      </span>
                    </span>
                    <ChevronDown className="profile__chevron" aria-hidden="true" />
                  </button>
                  {!readOnly ? (
                    <div className="profile__actions">
                      {defaultId !== p.id ? (
                        <Button size="sm" variant="ghost" icon={<Star />} onClick={() => setSettingRaw('llm.defaultProfile', p.id, { immediate: true })}>
                          Make default
                        </Button>
                      ) : null}
                      <IconButton label={`Remove ${p.label}`} icon={<Trash2 />} onClick={() => void remove(p.id)} />
                    </div>
                  ) : null}
                </div>
                {isOpen ? (
                  <div className="profile__body" id={`profile-${p.id}-body`}>
                    <ProviderEditor profileId={p.id} advanced={advanced} />
                  </div>
                ) : null}
              </section>
            )
          })}
        </div>
      )}

      {profiles.length ? (
        <SettingsGroup title="Which AI answers" description="Chats use the default unless you pick another model in the chat. The helper AI writes titles, recaps and summaries.">
          <SelectSetting setting="llm.defaultProfile" label="Default AI" options={profiles.map((p) => ({ value: p.id, label: p.label, description: p.model || undefined }))} />
          <UtilityProfile />
          <UtilityModel />
        </SettingsGroup>
      ) : null}

      <Dialog
        open={adding}
        onClose={() => {
          setAdding(false)
          setPick(null)
        }}
        title="Add an AI provider"
        description="Choose the service; you'll add the key and pick a model next."
        size="lg"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setAdding(false)
                setPick(null)
              }}
            >
              Cancel
            </Button>
            <Button variant="primary" disabled={!pick} onClick={add}>
              Add
            </Button>
          </>
        }
      >
        <PresetPicker value={pick} onChange={setPick} label="Service" />
      </Dialog>
      {dialog}
    </div>
  )
}

const SAME = '__same__'

/** The helper profile: null = the default profile at low effort (07 C18). */
function UtilityProfile(): ReactNode {
  const s = useSetting('llm.utilityProfile')
  const profiles = useProfiles()
  return (
    <SettingRow setting="llm.utilityProfile" className="set-row--field">
      <Select<string>
        label="Helper AI"
        value={s.value ?? SAME}
        disabled={s.readOnly}
        error={s.error}
        hint="A cheaper or faster model saves money on titles and recaps."
        options={[{ value: SAME, label: 'Same as the default (at low effort)' }, ...profiles.map((p) => ({ value: p.id, label: p.label, description: p.model || undefined }))]}
        onChange={(v) => s.set(v === SAME ? null : v, { immediate: true })}
      />
    </SettingRow>
  )
}

/** The helper model name (empty = the helper profile's own model). */
function UtilityModel(): ReactNode {
  const s = useSetting('llm.utilityModel')
  const utility = useSetting('llm.utilityProfile')
  const [draft, setDraft] = useState<string | null>(null)
  if (!utility.value) return null
  return (
    <SettingRow setting="llm.utilityModel" className="set-row--field">
      <TextField
        label="Helper model"
        value={draft ?? s.value}
        placeholder="The profile's own model"
        readOnly={s.readOnly}
        spellCheck={false}
        error={s.error}
        hint="Optional: a different model of the helper profile, e.g. a small fast one."
        onFocus={() => setDraft(s.value)}
        onBlur={() => setDraft(null)}
        onChange={(e) => {
          setDraft(e.target.value)
          s.set(e.target.value.trim())
        }}
      />
    </SettingRow>
  )
}
