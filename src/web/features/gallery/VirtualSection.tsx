/**
 * Gallery: VirtualList with 2,000 variable-height rows — prepend a page and the first visible row stays put, jump to a
 * row, stream into the last row while pinned to the bottom. Exposes `__vesperTest.kit.virtual` for the e2e spec.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDownToLine, ChevronsUp, Crosshair, Radio } from 'lucide-react'
import { Avatar } from '../../components/Avatar'
import { Button } from '../../components/Button'
import { VirtualList, type VirtualListHandle } from '../../components/VirtualList'
import { registerTestHooks } from '../../lib/testHooks'
import { Demo, Row, Section } from './Section'
import { sampleRow } from './sample'

type RowData = ReturnType<typeof sampleRow>

export function VirtualSection(): ReactNode {
  const [lo, setLo] = useState(1000)
  const [hi, setHi] = useState(2000)
  const [extra, setExtra] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [loads, setLoads] = useState(0)
  const list = useRef<VirtualListHandle>(null)

  const rows = useMemo(() => {
    const out: RowData[] = []
    for (let i = lo; i < hi; i++) out.push(sampleRow(i))
    if (extra && out.length) out[out.length - 1] = { ...out[out.length - 1], text: out[out.length - 1].text + extra }
    return out
  }, [lo, hi, extra])

  // Simulated streaming into the last row (the live reply): grows a few words per tick.
  useEffect(() => {
    if (!streaming) return
    const h = window.setInterval(() => setExtra((t) => (t.length > 1500 ? t : `${t} and the star keeps glowing`)), 120)
    return () => window.clearInterval(h)
  }, [streaming])

  const prepend = (n = 100): void => setLo((v) => Math.max(-100_000, v - n))

  useEffect(() => {
    if (!__VESPER_TEST__) return
    return registerTestHooks('kit', {
      virtual: {
        prepend: (n: number) => prepend(n),
        append: (n: number) => setHi((v) => v + n),
        scrollToIndex: (i: number, align?: 'start' | 'center' | 'end') => list.current?.scrollToIndex(i, { align }),
        anchor: () => list.current?.getAnchor() ?? null,
        atBottom: () => list.current?.isAtBottom() ?? false,
        range: () => list.current?.renderedRange() ?? null,
        domRows: () => document.querySelectorAll('[data-testid="g-vlist"] .vlist__row').length,
        count: () => hi - lo,
        /** Scroll row `i` to the top and report, synchronously, which row is there and where (before any reaction). */
        topAtIndex: (i: number) => {
          list.current?.scrollToIndex(i, { align: 'start' })
          const sc = list.current?.element()
          const a = list.current?.getAnchor()
          // The anchor offset is exactly where the row's top sits below the scroller's top edge.
          return a && sc ? { key: a.key, top: a.offset, scrollTop: sc.scrollTop } : null
        },
        /** Top (px from the scroller top) of the row with this id, or null when not rendered. */
        rowTop: (id: number) => {
          const sc = list.current?.element()
          const row = sc?.querySelector<HTMLElement>(`[data-vkey="${id}"]`)
          return sc && row ? row.getBoundingClientRect().top - sc.getBoundingClientRect().top : null
        }
      }
    })
  }, [lo, hi])

  return (
    <Section id="virtual" title="VirtualList" description="Variable heights, anchor kept on prepend (no jump, even at scrollTop 0), follow-output while at the bottom, imperative jumps.">
      <Demo label={`Rows ${lo}–${hi - 1} (${hi - lo} loaded · older pages loaded ${loads}×)`} wide>
        <Row>
          <Button size="sm" icon={<ChevronsUp />} onClick={() => prepend()} data-testid="g-vlist-prepend">
            Prepend 100
          </Button>
          <Button size="sm" icon={<Crosshair />} onClick={() => list.current?.scrollToIndex(Math.floor((hi - lo) / 2), { align: 'center' })}>
            Jump to middle
          </Button>
          <Button size="sm" icon={<ArrowDownToLine />} onClick={() => list.current?.scrollToBottom()}>
            Bottom
          </Button>
          <Button size="sm" variant={streaming ? 'primary' : 'secondary'} icon={<Radio />} onClick={() => setStreaming(!streaming)} aria-pressed={streaming}>
            {streaming ? 'Stop streaming' : 'Stream into last row'}
          </Button>
          <span className="g-note">{atBottom ? 'Pinned to bottom' : 'Reading history'}</span>
        </Row>
        <div className="g-vlist-frame">
          <VirtualList
            ref={list}
            items={rows}
            getKey={(r) => r.id}
            estimateSize={72}
            followOutput
            initialScroll="bottom"
            gap={6}
            paddingTop={8}
            paddingBottom={8}
            onAtBottomChange={setAtBottom}
            onStartReached={() => {
              if (lo > -100_000) {
                setLoads((n) => n + 1)
                prepend(100)
              }
            }}
            aria-label="Sample conversation"
            role="list"
            renderItem={(r) => (
              <div className={`g-msg g-msg--${r.who}`} role="listitem">
                {r.who === 'assistant' ? <Avatar kind="ai" size={22} /> : null}
                <p>
                  <span className="g-msg__n">#{r.id}</span> {r.text}
                </p>
              </div>
            )}
            data-testid="g-vlist"
          />
        </div>
      </Demo>
    </Section>
  )
}
