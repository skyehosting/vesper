/**
 * Memory for this chat (R7, R8, 07 B9/B13): memory on/off (or the Settings default), what the AI may recall (scope:
 * this / linked / all, with what each means for privacy), and the private switch.
 */
import { useId, type ReactNode } from 'react'
import { ArrowRight, ShieldCheck } from 'lucide-react'
import type { MemoryMode, MemoryScope, Session } from '@shared/types/domain'
import { Callout } from '../../components/Callout'
import { RadioGroup } from '../../components/RadioGroup'
import { Segmented } from '../../components/Segmented'
import { Switch } from '../../components/Switch'
import { Link } from '../../lib/router'
import { useStore } from '../../lib/store'
import { memoryChip, memoryOn, SCOPE_TEXT } from '../sessions/chips.logic'
import { trySession } from '../sessions/data'

type ScopeChoice = MemoryScope | 'inherit'

export function MemorySection({ session }: { session: Session }): ReactNode {
  const settings = useStore((s) => s.settings)
  const status = useStore((s) => s.ui.memoryStatus)
  const enabled = settings?.memory.enabled ?? false
  const scopeDefault = settings?.memory.scopeDefault ?? 'linked'
  const voyageReady = status?.state === 'ready' || status?.state === 'loading' || status?.state === 'degraded'
  const on = memoryOn(enabled, session.memory)
  const chip = memoryChip(enabled, session.memory, status?.state ?? null, session.private)
  const modeLabel = useId()

  const scopeOptions = (['inherit', 'this', 'linked', 'all'] as const).map((v) => ({
    value: v as ScopeChoice,
    label: v === 'inherit' ? `Default (${SCOPE_TEXT[scopeDefault].label.toLowerCase()})` : SCOPE_TEXT[v].label,
    description: v === 'inherit' ? 'Follows Settings → Memory.' : v === 'all' && session.private ? 'Private chats still search only themselves.' : SCOPE_TEXT[v].detail
  }))

  return (
    <div className="psec__body">
      <div className="psec__field">
        <span className="psec__label" id={modeLabel}>
          For this chat
        </span>
        <Segmented<MemoryMode>
          aria-labelledby={modeLabel}
          size="sm"
          block
          value={session.memory}
          onChange={(v) => void trySession(session.uid, { memory: v })}
          options={[
            { value: 'inherit', label: 'Default (on)' },
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' }
          ]}
        />
        <p className="psec__hint" role="status">
          {chip.detail}
        </p>
      </div>

      {on ? (
        <RadioGroup<ScopeChoice>
          label="What the AI may recall"
          value={session.memoryScope}
          options={scopeOptions}
          onChange={(v) => void trySession(session.uid, { memoryScope: v })}
        />
      ) : null}

      <Switch
        label="Private chat"
        description={
          session.private
            ? 'Never sent to Voyage AI and never recalled from other chats; keyword search stays within this chat. Text sent before you turned this on stays with Voyage.'
            : 'Keep this chat out of Voyage AI and out of other chats’ memory.'
        }
        checked={session.private}
        disabled={session.temporary}
        onChange={(v) => void trySession(session.uid, { private: v })}
      />

      {on ? (
        <Callout tone="privacy" icon={<ShieldCheck />}>
          Memory lives on this PC.{' '}
          {voyageReady && !session.private
            ? 'With Voyage AI, each message is sent once to be indexed, and a search sends its query plus up to 40 earlier messages for ranking.'
            : 'Searches here use keywords on this PC; nothing is sent for memory.'}
        </Callout>
      ) : null}

      {/* The header's Memory chip lands here: one step on to the whole timeline (F52). */}
      <Link className="pinfo__cont" to="/memory">
        Open the memory viewer
        <ArrowRight aria-hidden="true" />
      </Link>
    </div>
  )
}
