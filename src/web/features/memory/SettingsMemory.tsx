/**
 * Settings → Memory (R7–R10, R15, R21; 07 A1, C10–C13, D12). Voyage on/off with the keyword-only explanation, the
 * privacy note (VoyagePrivacy), key + test + model/dimensions, the default scope with its explanation, auto-recall and
 * its budget, live status (`memory.progress`: indexed / waiting / errors / plan / requests per minute / time left) with
 * the free-trial note, backfill consent (07 C12), re-index and delete-index (sudo), and links to the memory viewer,
 * "About you", protocols and the prompt library. Memory settings are desktop-only (07 B2): other devices see them
 * read-only.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { BookText, FileCog, Link2, ListTree, RefreshCw, Trash2, UserRound } from 'lucide-react'
import { Badge, LeavesPcBadge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { Callout } from '../../components/Callout'
import { useConfirm } from '../../components/ConfirmDialog'
import { Disclosure } from '../../components/Disclosure'
import { Select } from '../../components/Select'
import { Switch } from '../../components/Switch'
import { toast } from '../../components/Toast'
import { api } from '../../lib/api'
import { toApiError } from '../../lib/errors.logic'
import type { SettingsSectionProps } from '../settings/sections'
import { SettingSlider, SettingText } from './controls'
import { DesktopOnlyNote, Group, LinkRow, Page, Row } from './layout'
import { BackfillDialog, backfillDetail, ScopeChoice, StatusLine, StatusPanel, type BackfillEstimate } from './MemoryParts'
import { useLive } from './live'
import { facts, memoryStatus } from './stores'
import { formatCount, plural, tokensAsWords } from './format.logic'
import { useIsDesktop, usePatchSettings, useSecretSet, useSettings, voyageKeyKnown } from './settings'
import { VoyageKey, VoyageModelRows } from './VoyageConnection'
import { VoyagePrivacy } from './VoyagePrivacy'
import { RERANK_CHOICES } from './voyage.logic'
import './memory.css'

const VOYAGE_HOSTS = [
  { value: 'https://api.voyageai.com/v1', label: 'Voyage AI (api.voyageai.com)' },
  { value: 'https://ai.mongodb.com/v1', label: 'MongoDB Atlas (ai.mongodb.com)' },
  { value: 'https://eu.ai.mongodb.com/v1', label: 'MongoDB Atlas, EU' },
  { value: 'https://us.ai.mongodb.com/v1', label: 'MongoDB Atlas, US' }
]

export default function SettingsMemory({ advanced }: SettingsSectionProps): ReactNode {
  const settings = useSettings()
  const desktop = useIsDesktop()
  const patch = usePatchSettings()
  const { saved: secretSaved } = useSecretSet('voyage')
  const { data: status } = useLive(memoryStatus)
  const keySaved = voyageKeyKnown(secretSaved, status?.state)
  const { data: factList } = useLive(facts)
  const { confirm, dialog } = useConfirm()
  const [estimate, setEstimate] = useState<BackfillEstimate | null>(null)
  const [backfillOpen, setBackfillOpen] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const enabled = settings?.memory.enabled ?? false

  /** Ask the server what isn't indexed yet; `ask` opens the consent dialog when there is something (07 C12). */
  const checkBackfill = useCallback(async (ask: boolean): Promise<void> => {
    try {
      const e = await api('GET /api/memory/backfill/estimate')
      if (!alive.current) return
      setEstimate(e)
      if (ask && e.messages > 0) setBackfillOpen(true)
    } catch {
      // The estimate is a nicety; the page works without it.
    }
  }, [])

  useEffect(() => {
    if (enabled && keySaved) void checkBackfill(false)
  }, [enabled, keySaved, checkBackfill])

  if (!settings) return null
  const m = settings.memory
  const readOnly = !desktop

  const toggle = async (on: boolean): Promise<void> => {
    const ok = await patch({ memory: { enabled: on } })
    if (ok && on && keySaved) void checkBackfill(true)
  }

  const reindex = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Re-index all remembered messages?',
      description:
        'Vesper sends every remembered message to Voyage AI again to rebuild the index. Search keeps working meanwhile. Use this after changing the key’s account or if search results look wrong.',
      confirmLabel: 'Re-index'
    })
    if (!ok) return
    try {
      const r = await api('POST /api/memory/reindex', { body: { scope: 'all' } })
      toast.success(`Re-indexing ${plural(r.queued, 'message')} in the background.`)
    } catch (e) {
      toast.error(toApiError(e).message)
    }
  }

  const deleteIndex = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Delete the memory index?',
      description:
        'The search numbers are deleted from this PC. Your messages stay, and search falls back to matching words until you index again. Text Voyage already received can’t be recalled from Voyage.',
      confirmLabel: 'Delete index',
      tone: 'danger'
    })
    if (!ok) return
    try {
      await api('DELETE /api/memory/index')
      toast.success('The memory index was deleted.')
      void memoryStatus.reload()
    } catch (e) {
      toast.error(toApiError(e).message)
    }
  }

  const advancedBody = (
    <>
      <Row
        setting="memory.voyage.rerankModel"
        label="Re-ranking"
        description="A second, sharper pass that orders search hits by meaning. Sends the candidate messages (up to 40) to Voyage."
        control={
          <Select
            label="Re-ranking model"
            labelHidden
            value={m.voyage.rerankModel}
            disabled={readOnly}
            onChange={(v) => void patch({ memory: { voyage: { rerankModel: v } } })}
            options={RERANK_CHOICES.map((r) => ({
              value: r.id,
              label: r.label,
              description: r.description,
              meta: r.usdPerMTok ? `$${r.usdPerMTok.toFixed(2)} / 1M` : undefined
            }))}
          />
        }
      />
      <Row
        setting="memory.voyage.tier"
        label="Your Voyage plan"
        description="Sets how fast Vesper may send. Automatic starts at free-trial speed and steps up after 10 minutes without a limit warning."
        control={
          <Select
            label="Voyage plan"
            labelHidden
            value={m.voyage.tier}
            disabled={readOnly}
            onChange={(v) => void patch({ memory: { voyage: { tier: v } } })}
            options={[
              { value: 'auto', label: 'Automatic' },
              { value: 'free', label: 'Free trial (no payment method)' },
              { value: 'tier1', label: 'Tier 1 (payment method)' },
              { value: 'tier2', label: 'Tier 2 ($100+ paid)' },
              { value: 'tier3', label: 'Tier 3 ($1,000+ paid)' }
            ]}
          />
        }
      />
      <Row setting="memory.autoRecallMinScore" stack>
        <SettingSlider
          label="Automatic recall: minimum match"
          hint="Higher = only very close memories are added before a reply."
          value={m.autoRecallMinScore}
          min={0}
          max={1}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          disabled={readOnly}
          onSave={(v) => patch({ memory: { autoRecallMinScore: v } })}
        />
      </Row>
      <Row setting="memory.searchMinScore" stack>
        <SettingSlider
          label="Memory search: minimum match"
          hint="Results below this are dropped when the AI searches its memory."
          value={m.searchMinScore}
          min={0}
          max={1}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          disabled={readOnly}
          onSave={(v) => patch({ memory: { searchMinScore: v } })}
        />
      </Row>
      <Row setting="memory.maxRecallRounds" stack>
        <SettingSlider
          label="Most exchanges per recall"
          hint="How many remembered exchanges one search may return to the AI."
          value={m.maxRecallRounds}
          min={1}
          max={20}
          disabled={readOnly}
          onSave={(v) => patch({ memory: { maxRecallRounds: v } })}
        />
      </Row>
      <Row
        setting="memory.voyage.customEndpoint"
        label="Use a custom address"
        description="Only for a Voyage-compatible service of your own. Keys are bound to the address they were saved for."
        control={
          <Switch
            aria-label="Use a custom address"
            checked={m.voyage.customEndpoint}
            disabled={readOnly}
            onChange={(v) => void patch({ memory: { voyage: { customEndpoint: v } } })}
          />
        }
      />
      <Row setting="memory.voyage.baseUrl" stack>
        {m.voyage.customEndpoint ? (
          <SettingText
            label="Address"
            value={m.voyage.baseUrl}
            mono
            disabled={readOnly}
            hint="https:// unless it runs on this PC."
            onSave={(v) => patch({ memory: { voyage: { baseUrl: v } } })}
          />
        ) : (
          <Select
            label="Address"
            value={m.voyage.baseUrl}
            disabled={readOnly}
            onChange={(v) => void patch({ memory: { voyage: { baseUrl: v } } })}
            options={VOYAGE_HOSTS}
            hint="Atlas keys (al-…) pick the MongoDB address by themselves."
          />
        )}
      </Row>
    </>
  )

  return (
    <Page
      title="Memory"
      description="Every conversation is kept on this PC as a timeline of who said what and when. With Voyage AI, Vesper can also find things by meaning and bring them back when they matter."
      actions={<StatusLine status={status} />}
    >
      {readOnly ? <DesktopOnlyNote /> : null}

      <Group id="mem-main" title="Long-term memory">
        <Row setting="memory.enabled">
          <Switch
            checked={enabled}
            disabled={readOnly}
            onChange={(v) => void toggle(v)}
            label={
              <span className="mlabel">
                Remember with Voyage AI <LeavesPcBadge service="Voyage AI" />
              </span>
            }
            description="Index every message so the AI can recall what you meant, not only the exact words."
          />
        </Row>
        {!enabled ? (
          <Row>
            <Callout tone="info" title="Keyword memory is always on">
              Without Voyage, every message is still kept here and searchable by its words — the AI’s memory search and your own search both use exact-word
              matching. Nothing is sent anywhere for memory.
            </Callout>
          </Row>
        ) : !keySaved ? (
          <Row>
            <Callout tone="warning" title="Add your Voyage AI key">
              Memory is on, but until a key is saved it works with keywords only.
            </Callout>
          </Row>
        ) : (
          <Row>
            <StatusPanel status={status} />
          </Row>
        )}
      </Group>

      <VoyagePrivacy />

      <Group
        id="mem-voyage"
        title="Voyage AI connection"
        description="Your own key. Embeddings cost about $0.02 per million tokens with voyage-4-lite, and new accounts get 200 million free tokens."
      >
        <Row>
          <VoyageKey onSaved={() => enabled && void checkBackfill(true)} />
        </Row>
        <VoyageModelRows indexed={status?.indexed ?? 0} disabled={readOnly} />
      </Group>

      <Group
        id="mem-scope"
        title="What each chat can remember"
        description="A chat’s own memory setting (in its side panel) overrides the default."
      >
        <Row setting="memory.scopeDefault" stack>
          <ScopeChoice value={m.scopeDefault} disabled={readOnly} onChange={(v) => void patch({ memory: { scopeDefault: v } })} />
        </Row>
        <Row setting="memory.autoRecall">
          <Switch
            checked={m.autoRecall}
            disabled={readOnly}
            onChange={(v) => void patch({ memory: { autoRecall: v } })}
            label="Recall automatically"
            description="Before each reply, Vesper looks for related memories and hands the best ones to the AI (it never waits more than 0.4 s). The AI can also search on its own."
          />
        </Row>
        <Row setting="memory.maxRecallTokens" stack>
          <SettingSlider
            label="Recall budget"
            hint="How much remembered text may be added to one reply."
            value={m.maxRecallTokens}
            min={200}
            max={8000}
            step={100}
            format={(v) => `${formatCount(v)} tokens (${tokensAsWords(v)})`}
            disabled={readOnly}
            onSave={(v) => patch({ memory: { maxRecallTokens: v } })}
          />
        </Row>
      </Group>

      <Group id="mem-history" title="Past conversations">
        {enabled && keySaved && estimate && estimate.messages > 0 ? (
          <Row
            label={`${plural(estimate.messages, 'message')} from ${plural(estimate.sessions, 'chat')} aren’t in memory yet`}
            description={backfillDetail(estimate)}
            control={
              <Button variant="primary" size="sm" disabled={readOnly} onClick={() => setBackfillOpen(true)}>
                Index past chats…
              </Button>
            }
          />
        ) : null}
        <Row
          label="Re-index everything"
          description="Send every remembered message to Voyage again to rebuild the index."
          control={
            <Button size="sm" icon={<RefreshCw />} disabled={!enabled || !keySaved} onClick={() => void reindex()}>
              Re-index…
            </Button>
          }
        />
        <Row
          label="Delete the memory index"
          description="Removes the search numbers from this PC. Your messages stay."
          control={
            <Button
              size="sm"
              variant="danger"
              icon={<Trash2 />}
              disabled={(status?.indexed ?? 0) === 0 && (status?.queued ?? 0) === 0}
              onClick={() => void deleteIndex()}
            >
              Delete…
            </Button>
          }
        />
      </Group>

      <Group id="mem-browse" title="Browse and edit" flush>
        <LinkRow to="/memory" icon={<ListTree />} title="Memory viewer" description="Every remembered message with its tag, machine time and chat ID." />
        <LinkRow
          to="/memory/sessions"
          icon={<Link2 />}
          title="Chats and links"
          description="The list of chats the AI is told about, and which chats can recall which."
        />
        <LinkRow
          to="/memory/about"
          icon={<UserRound />}
          title="About you"
          description="Facts the AI always keeps in mind."
          meta={factList ? <Badge>{String(factList.length)}</Badge> : undefined}
        />
        <LinkRow to="/memory/protocols" icon={<FileCog />} title="Protocols" description="The rules and memory functions every chat’s AI follows." />
        <LinkRow to="/prompts" icon={<BookText />} title="Prompt library" description="Saved system prompts to use in any chat." />
      </Group>

      {advanced ? (
        <Group id="mem-advanced" title="Advanced">
          {advancedBody}
        </Group>
      ) : (
        <Disclosure summary="Advanced" variant="card" className="mem-advanced" headingLevel={3}>
          <div className="mem-advanced__body">{advancedBody}</div>
        </Disclosure>
      )}

      <BackfillDialog
        open={backfillOpen}
        estimate={estimate}
        onClose={() => {
          setBackfillOpen(false)
          void checkBackfill(false)
        }}
      />
      {dialog}
    </Page>
  )
}
