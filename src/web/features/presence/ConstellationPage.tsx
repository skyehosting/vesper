/**
 * '/constellation' — the memory map (07 A4): sessions as stars (size = messages, brightness = recency), links as
 * lines, private sessions dimmed; hover for a card, click to open, drag a star onto another to link them; zoom, pan
 * and orbit; search highlights; recalled sources pulse during a reply. The map renders in the app's single canvas
 * (07 D5): this page only registers the stage target and handles input, panels and data.
 *
 * Keyboard / screen readers (07 D9): the session list is the accessible way through the map (focus a row → the star
 * lights up and the camera turns to it; Enter opens; "Link to…" per row); the stage itself takes arrows, + − and 0.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { formatShortId } from '@shared/ids'
import { List, Maximize2, Pause, Play, Search, Sparkles, X } from 'lucide-react'
import { Button } from '../../components/Button'
import { Callout } from '../../components/Callout'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { IconButton } from '../../components/IconButton'
import { Sheet } from '../../components/Sheet'
import { Spinner } from '../../components/Spinner'
import { TextField } from '../../components/TextField'
import { TopBarContent } from '../../app/topBar'
import type { PageProps } from '../../app/routes'
import { navigate } from '../../lib/router'
import { useStore } from '../../lib/store'
import { useIsPhone, useMediaQuery } from '../../lib/useMediaQuery'
import { linkSessions, startConstellationData, titleOf, type ConstellationData } from './constellation/data'
import { attachInput } from './constellation/input'
import { fitView, focusNode, getState, resetModel, setQuery, setSelected, view } from './constellation/model'
import { DragLine, LinkDialog, SessionList, StarCard, StarFacts, StarLabels, useConstellation } from './constellation/parts'
import { currentScheduler } from './host/schedulerRef'
import { registerTarget } from './targets'
import './constellation/constellation.css'

export default function ConstellationPage(_props: PageProps): ReactNode {
  const st = useConstellation()
  const phone = useIsPhone()
  const wide = useMediaQuery('(min-width: 1100px)')
  const webgl = useStore((s) => s.presence.webgl)
  const paused = useStore((s) => s.presence.paused)
  const stage = useRef<HTMLDivElement>(null)
  const data = useRef<ConstellationData | null>(null)
  const [listOpen, setListOpen] = useState<boolean | null>(null)
  const [linkFrom, setLinkFrom] = useState(-1)
  const [query, setQ] = useState('')
  const showList = listOpen ?? wide

  useEffect(() => {
    document.title = 'Constellation · Vesper'
    data.current = startConstellationData()
    return () => {
      data.current?.stop()
      data.current = null
      resetModel()
      document.title = 'Vesper'
    }
  }, [])

  // The stage is a target for the one canvas (07 D5).
  useEffect(() => {
    const el = stage.current
    if (!el) return
    return registerTarget(el, 'constellation')
  }, [])

  const open = useCallback((i: number) => {
    const n = getState().nodes[i]
    if (n) navigate(`/s/${n.s.uid}`)
  }, [])

  const select = useCallback((i: number) => {
    setSelected(i)
    focusNode(i)
    view.lastInput = performance.now()
    currentScheduler()?.interact(900)
  }, [])

  const link = useCallback(async (from: number, to: number, bothWays = false): Promise<boolean> => {
    const ok = await linkSessions(from, to, bothWays)
    if (ok) data.current?.reload()
    return ok
  }, [])

  useEffect(() => {
    const el = stage.current
    if (!el) return
    return attachInput(el, { open, select, link: (a, b) => void link(a, b) })
  }, [open, select, link])

  // Centre the map in the sky the panels leave free.
  const listShown = !phone && showList && st.status === 'ready' && st.nodes.length > 0
  useEffect(() => {
    view.insetRight = listShown ? 324 : 0
    view.insetTop = phone ? 60 : 56
    currentScheduler()?.interact(600)
  }, [listShown, phone])

  // Search: debounce typing into the model (highlights + list filter).
  useEffect(() => {
    const t = window.setTimeout(() => {
      setQuery(query)
      currentScheduler()?.requestFrame()
    }, 120)
    return () => window.clearTimeout(t)
  }, [query])

  const nodes = st.nodes.length
  const links = st.edges.length
  const ready = st.status === 'ready'
  const empty = ready && nodes === 0
  const noGl = webgl === 'unavailable'
  const selectedNode = st.selected >= 0 ? st.nodes[st.selected] : undefined
  const cardIndex = !phone && st.drag === null ? (st.hover >= 0 ? st.hover : st.selected) : -1

  const toolbar = (
    <div className="cst__toolbar" role="toolbar" aria-label="Constellation tools">
      <TextField
        size="sm"
        type="search"
        value={query}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && query) {
            e.stopPropagation()
            setQ('')
          }
          if (e.key === 'Enter') {
            const m = getState().matches
            const first = m ? m.indexOf(1) : -1
            if (first >= 0) select(first)
          }
        }}
        placeholder={phone ? 'Find…' : 'Find a conversation'}
        aria-label="Find a conversation"
        leading={<Search />}
        trailing={query ? <IconButton size="sm" label="Clear search" icon={<X />} onClick={() => setQ('')} tooltip={false} /> : undefined}
        wrapClassName="cst__search"
      />
      {st.query && ready ? (
        <span className="cst__matches" role="status">
          {st.matchCount ? `${st.matchCount} match${st.matchCount === 1 ? '' : 'es'}` : 'No matches'}
        </span>
      ) : null}
      {noGl ? null : (
        <div className="cst__tools">
          <IconButton
            label="Fit all stars"
            icon={<Maximize2 />}
            onClick={() => {
              fitView(true, true)
              currentScheduler()?.interact(900)
            }}
          />
          <IconButton
            label={paused ? 'Resume the animation' : 'Pause the animation'}
            icon={paused ? <Play /> : <Pause />}
            pressed={paused}
            onClick={() => useStore.getState().setStarPaused(!paused)}
          />
          <IconButton label={showList ? 'Hide the list' : 'Show the list'} icon={<List />} pressed={showList} onClick={() => setListOpen(!showList)} />
        </div>
      )}
    </div>
  )

  const list = <SessionList onOpen={open} onLink={setLinkFrom} onFocusStar={(i) => (getState().selected === i ? undefined : select(i))} />

  return (
    <div className="cst" data-phone={phone || undefined}>
      <TopBarContent>
        <h1 className="cst__title">Constellation</h1>
        {ready && nodes > 0 ? (
          <span className="cst__sub">
            {nodes.toLocaleString()} conversation{nodes === 1 ? '' : 's'} · {links.toLocaleString()} link{links === 1 ? '' : 's'}
          </span>
        ) : null}
      </TopBarContent>

      <div
        ref={stage}
        className="cst__stage"
        tabIndex={empty || noGl ? -1 : 0}
        role="application"
        aria-roledescription="star map"
        aria-label="Constellation map of your conversations"
        aria-describedby="cst-help"
        hidden={noGl}
      />
      <p id="cst-help" className="sr-only">
        Each star is a conversation: bigger stars have more messages, brighter ones are more recent, dim ones are private. Arrow keys turn the map, plus and
        minus zoom, zero resets the view. Use the conversation list to open or link conversations.
      </p>

      {!noGl ? (
        <div className="cst__overlay">
          <StarLabels />
          <DragLine />
          {cardIndex >= 0 ? <StarCard index={cardIndex} /> : null}
        </div>
      ) : null}

      {/* Toolbar: a persistent surface over the stage — opaque, no glass (07 D10). Without WebGL it heads the list. */}
      {!empty && st.status !== 'error' && !noGl ? toolbar : null}

      {/* Desktop: the list docks on the right; phones get a sheet. */}
      {!phone && showList && ready && !empty && !noGl ? (
        <aside className="cst__list" aria-label="Conversations">
          <div className="cst__list-head">
            <h2>Conversations</h2>
            <p>Bigger stars hold more messages; brighter ones are more recent.</p>
          </div>
          {list}
        </aside>
      ) : null}
      {phone ? (
        <Sheet open={!!listOpen && ready && !empty} onClose={() => setListOpen(false)} title="Conversations" side="bottom">
          {list}
        </Sheet>
      ) : null}

      {phone ? (
        <Sheet
          open={!!selectedNode && !listOpen}
          onClose={() => setSelected(-1)}
          title={selectedNode ? titleOf(selectedNode.s.title) : ''}
          description={selectedNode ? formatShortId(selectedNode.s.shortId) : undefined}
          side="bottom"
        >
          {selectedNode ? (
            <div className="cst-sheet">
              <StarFacts node={selectedNode} head={false} />
              <div className="cst-sheet__actions">
                <Button variant="primary" block onClick={() => open(st.selected)}>
                  Open conversation
                </Button>
                <Button variant="secondary" block onClick={() => setLinkFrom(st.selected)}>
                  Link to…
                </Button>
              </div>
            </div>
          ) : null}
        </Sheet>
      ) : null}

      {!phone && ready && !empty && !noGl ? (
        <div className="cst__legend" aria-hidden="true">
          <span>
            <i className="cst-key cst-key--big" /> more messages
          </span>
          <span>
            <i className="cst-key cst-key--bright" /> more recent
          </span>
          <span>
            <i className="cst-key cst-key--dim" /> private
          </span>
          <span className="cst__legend-hint">Drag a star onto another to link them</span>
        </div>
      ) : null}

      {st.status === 'loading' && !nodes ? (
        <div className="cst__state" data-loading>
          <Spinner size={22} label="Mapping your conversations" />
        </div>
      ) : null}
      {st.status === 'error' ? (
        <div className="cst__state">
          <ErrorState
            error={st.error as Parameters<typeof ErrorState>[0]['error']}
            title="Couldn’t map your conversations"
            onRetry={() => data.current?.reload()}
          />
        </div>
      ) : null}
      {empty ? (
        <div className="cst__state">
          <EmptyState
            icon={<Sparkles />}
            title="Your sky is still empty"
            description="Every conversation becomes a star here. Talk with Vesper and watch your constellation grow."
            actions={
              <Button variant="primary" onClick={() => navigate('/')}>
                Start a conversation
              </Button>
            }
          />
        </div>
      ) : null}
      {noGl && ready && !empty ? (
        <div className="cst__nogl">
          <Callout tone="info" title="The 3D map isn’t available here">
            This browser or graphics driver can’t draw WebGL, so your conversations are listed instead.
          </Callout>
          {toolbar}
          {list}
        </div>
      ) : null}

      {linkFrom >= 0 ? <LinkDialog from={linkFrom} onClose={() => setLinkFrom(-1)} onLink={(to, both) => link(linkFrom, to, both)} /> : null}
    </div>
  )
}
