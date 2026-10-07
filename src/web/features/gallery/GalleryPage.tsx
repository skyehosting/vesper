/**
 * '/gallery' (test builds only, 07 B10) — every kit component in every state, with theme/accent/motion controls,
 * stable `data-testid="gallery-<section>"` blocks for screenshots, and `__vesperTest.kit` hooks (leak counters,
 * highlighter state, the virtual list). audio-core's harness renders lazily in the last section.
 */
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { Segmented } from '../../components/Segmented'
import { Spinner } from '../../components/Spinner'
import { Switch } from '../../components/Switch'
import { highlighterStats } from '../../components/code/highlighter'
import { kitStats } from '../../components/internal/stats'
import { openLayerCount } from '../../components/internal/layers'
import { applyAppearance } from '../../app/appearance'
import type { PageProps } from '../../app/routes'
import { registerTestHooks } from '../../lib/testHooks'
import { ButtonsSection, CodeSection, DataSection, FeedbackSection, MemorySection, QrSection, StatesSection } from './DisplaySections'
import { FilesSection, InputsSection, SecretSection, SelectSection, SliderSection, TogglesSection } from './FormSections'
import { MenusSection, OverlaysSection, TabsSection } from './NavSections'
import { Section } from './Section'
import { VirtualSection } from './VirtualSection'
import './gallery.css'

/** audio-core's harness (features/gallery/audio.tsx), loaded only when the gallery opens. */
const AudioGallery = lazy(() => import('./audio'))

const ACCENTS = [
  { id: 'gold', label: 'Vesper gold', color: '#f5b84c' },
  { id: 'violet', label: 'Dusk violet', color: '#a78bfa' },
  { id: 'rose', label: 'Rose', color: '#fb7185' },
  { id: 'aurora', label: 'Aurora', color: '#34d399' },
  { id: 'ice', label: 'Ice', color: '#7dd3fc' }
] as const

type Theme = 'dark' | 'light' | 'system'

const TOC = [
  ['buttons', 'Buttons'],
  ['inputs', 'Text fields'],
  ['select', 'Select'],
  ['toggles', 'Toggles'],
  ['slider', 'Slider'],
  ['tabs', 'Tabs'],
  ['menus', 'Menus'],
  ['overlays', 'Overlays'],
  ['feedback', 'Feedback'],
  ['states', 'States'],
  ['data', 'Data'],
  ['remembered', 'Memory'],
  ['secret', 'Secrets'],
  ['code', 'Code'],
  ['files', 'Files'],
  ['qr', 'QR'],
  ['virtual', 'Virtual list'],
  ['audio', 'Audio']
] as const

export default function GalleryPage(_props: PageProps): ReactNode {
  const root = document.documentElement
  const [theme, setTheme] = useState<Theme>((root.dataset.theme as Theme | undefined) ?? 'dark')
  const [accent, setAccent] = useState(root.dataset.accent ?? 'gold')
  const [reduce, setReduce] = useState(root.dataset.reduceMotion === 'true')

  const apply = (t: Theme, a: string, r: boolean): void => {
    setTheme(t)
    setAccent(a)
    setReduce(r)
    applyAppearance({ theme: t, accent: a, reduceMotion: r, fontSize: 15 }, { persist: false })
  }

  useEffect(() => {
    if (!__VESPER_TEST__) return
    return registerTestHooks('kit', {
      stats: () => ({ ...kitStats(), openLayers: openLayerCount() }),
      highlighter: () => highlighterStats(),
      setAppearance: (t: Theme, a: string, r = false) => apply(t, a, r)
    })
  }, [])

  return (
    <div className="gallery" data-testid="gallery">
      <header className="gallery__bar">
        <h1 className="gallery__title">
          Kit gallery <span>Vesper</span>
        </h1>
        <div className="gallery__controls">
          <Segmented
            aria-label="Theme"
            size="sm"
            value={theme}
            onChange={(t) => apply(t, accent, reduce)}
            options={[
              { value: 'dark', label: 'Dark', icon: <Moon /> },
              { value: 'light', label: 'Light', icon: <Sun /> },
              { value: 'system', label: 'System', icon: <Monitor /> }
            ]}
          />
          <div className="gallery__accents" role="radiogroup" aria-label="Accent">
            {ACCENTS.map((a) => (
              <label key={a.id} className="gallery__swatch" style={{ ['--sw' as string]: a.color }} title={a.label}>
                <input type="radio" name="gallery-accent" value={a.id} checked={accent === a.id} onChange={() => apply(theme, a.id, reduce)} aria-label={a.label} />
              </label>
            ))}
          </div>
          <Switch label="Reduce motion" size="sm" switchPosition="start" checked={reduce} onChange={(r) => apply(theme, accent, r)} />
        </div>
      </header>

      <div className="gallery__layout">
        <nav className="gallery__toc" aria-label="Gallery sections">
          <ul>
            {TOC.map(([id, label]) => (
              <li key={id}>
                <button type="button" onClick={() => document.getElementById(`gallery-${id}`)?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' })}>
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <main className="gallery__main">
          <ButtonsSection />
          <InputsSection />
          <SelectSection />
          <TogglesSection />
          <SliderSection />
          <TabsSection />
          <MenusSection />
          <OverlaysSection />
          <FeedbackSection />
          <StatesSection />
          <DataSection />
          <MemorySection />
          <SecretSection />
          <CodeSection />
          <FilesSection />
          <QrSection />
          <VirtualSection />
          <Section id="audio" title="Audio" description="audio-core's harness (engine, levels, mic, reveal).">
            <Suspense fallback={<Spinner size={16} label="Loading" />}>
              <AudioGallery />
            </Suspense>
          </Section>
        </main>
      </div>
    </div>
  )
}
