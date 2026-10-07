/**
 * '/memory/:tab?' — the memory viewer (R7–R9, 07 A4/C13/D12): Timeline · Chats & links · About you · Protocols. The
 * tab is part of the URL; each tab keeps its own state. The top bar shows the title and the live memory state.
 */
import { useEffect, type ReactNode } from 'react'
import { FileCog, Link2, ListTree, Settings2, UserRound } from 'lucide-react'
import type { PageProps } from '../../app/routes'
import { TopBarContent } from '../../app/topBar'
import { IconButton } from '../../components/IconButton'
import { Tabs, tabPanelProps } from '../../components/Tabs'
import { getLocation, navigate } from '../../lib/router'
import { FactsView } from './FactsView'
import { ManifestView } from './ManifestView'
import { ProtocolsEditor } from './ProtocolsEditor'
import { StatusLine } from './MemoryParts'
import { Timeline } from './Timeline'
import { useLive } from './live'
import { memoryStatus } from './stores'
import './layout.css'
import './memory.css'
import './viewer.css'

export const MEMORY_TABS = ['timeline', 'sessions', 'about', 'protocols'] as const
export type MemoryTab = (typeof MEMORY_TABS)[number]

const ID_BASE = 'memtabs'

export default function MemoryPage({ params }: PageProps): ReactNode {
  const tab: MemoryTab = (MEMORY_TABS as readonly string[]).includes(params.tab ?? '') ? (params.tab as MemoryTab) : 'timeline'
  const { data: status } = useLive(memoryStatus)

  // An unknown tab in the URL becomes the timeline (replace: no extra history entry).
  useEffect(() => {
    if (params.tab && !(MEMORY_TABS as readonly string[]).includes(params.tab)) navigate('/memory', { replace: true })
  }, [params.tab])

  const go = (t: MemoryTab): void => {
    // Filters in the query belong to the timeline only.
    const search = t === 'timeline' && getLocation().pathname === '/memory' ? getLocation().search : ''
    navigate(t === 'timeline' ? `/memory${search}` : `/memory/${t}`, { replace: true })
  }

  return (
    <div className="mview">
      <TopBarContent>
        <div className="mview__top">
          <h1 className="mview__title">Memory</h1>
          <StatusLine status={status} />
        </div>
      </TopBarContent>
      <div className="mview__tabs">
        <div className="mview__tabs-inner">
          <Tabs<MemoryTab>
            aria-label="Memory"
            idBase={ID_BASE}
            value={tab}
            onChange={go}
            items={[
              { value: 'timeline', label: 'Timeline', icon: <ListTree /> },
              { value: 'sessions', label: 'Chats & links', icon: <Link2 /> },
              { value: 'about', label: 'About you', icon: <UserRound /> },
              { value: 'protocols', label: 'Protocols', icon: <FileCog /> }
            ]}
          />
          <IconButton label="Memory settings" icon={<Settings2 />} onClick={() => navigate('/settings/memory')} className="mview__settings" />
        </div>
      </div>
      <div className="mview__panel" {...tabPanelProps(ID_BASE, tab)}>
        {tab === 'timeline' ? <Timeline /> : tab === 'sessions' ? <ManifestView /> : tab === 'about' ? <FactsView /> : <ProtocolsEditor />}
      </div>
    </div>
  )
}
