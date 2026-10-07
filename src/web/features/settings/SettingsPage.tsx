/**
 * '/settings/:section?' — the Settings shell (07 D12): sections from the registry (sections.ts) in a left nav on wide
 * screens, a list → page flow on phones (07 D8), search across every setting (catalog.ts), and the lazily loaded
 * section page. A search hit opens `/settings/<section>?find=<path>`: the shell opens the page's Advanced part if the
 * setting lives there, scrolls the `[data-setting]` row into view, highlights it and moves focus to its control.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type LazyExoticComponent, type ReactNode } from 'react'
import { BookText, Brain, ChevronLeft, ChevronRight, Search, X, type LucideIcon } from 'lucide-react'
import { IconButton } from '../../components/IconButton'
import { Spinner } from '../../components/Spinner'
import { TopBarContent } from '../../app/topBar'
import type { PageProps } from '../../app/routes'
import { Link, navigate, useLocation } from '../../lib/router'
import { useIsPhone } from '../../lib/useMediaQuery'
import { HealthBanners } from '../health/HealthHost'
import { VOICE_SETTINGS_UI } from '../voice/settings/ids.logic'
import { catalogEntry, searchSettings, type SearchHit } from './catalog.logic'
import { SECTION_TITLES, settingsSection, settingsSections, type SettingsSection, type SettingsSectionProps } from './sections'
import './settings.css'

/** Pages that are not settings but are managed from here too, listed under the sections (F52: discoverable). */
const ELSEWHERE: ReadonlyArray<{ to: string; title: string; description: string; icon: LucideIcon }> = [
  { to: '/memory', title: 'Memory viewer', description: 'Timeline, chats and links, about you', icon: Brain },
  { to: '/prompts', title: 'Prompt library', description: 'Saved system prompts', icon: BookText }
]

const pages = new Map<string, LazyExoticComponent<ComponentType<SettingsSectionProps>>>()

function pageFor(id: string): LazyExoticComponent<ComponentType<SettingsSectionProps>> | null {
  const def = settingsSection(id)
  if (!def) return null
  let page = pages.get(id)
  if (!page) {
    page = lazy(def.load)
    pages.set(id, page)
  }
  return page
}

function findParam(search: string): string | null {
  return new URLSearchParams(search).get('find')
}

export default function SettingsPage({ params }: PageProps): ReactNode {
  const phone = useIsPhone()
  const { search } = useLocation()
  const [query, setQuery] = useState('')
  const asked = settingsSection(params.section)
  // Phones open on the list; wide screens on the first section.
  const current: SettingsSection | null = asked ?? (phone ? null : settingsSections[0])
  const find = findParam(search)
  const target = find ? catalogEntry(find) : undefined
  const advanced = !!target?.advanced && target.section === current?.id

  useTargetRow(current?.id ?? null, find)

  const nav = <SettingsNav current={current?.id ?? null} query={query} onQuery={setQuery} />

  if (phone && !current) {
    return (
      <div className="settings settings--list">
        <TopBarContent>
          <h1 className="settings__title">Settings</h1>
        </TopBarContent>
        <div className="settings__list">{nav}</div>
      </div>
    )
  }

  return (
    <div className={phone ? 'settings settings--phone' : 'settings'}>
      <TopBarContent>
        {phone ? (
          <div className="settings__crumb">
            <IconButton label="All settings" icon={<ChevronLeft />} className="no-drag" onClick={() => navigate('/settings')} />
            <span className="settings__title">{current?.title}</span>
          </div>
        ) : (
          <h1 className="settings__title">Settings</h1>
        )}
      </TopBarContent>
      {phone ? null : nav}
      <section className="settings__body" aria-label={current?.title ?? 'Settings'} id="settings-body">
        <div className="settings__page" key={current?.id}>
          {current ? <SectionPage section={current} advanced={advanced} /> : null}
        </div>
      </section>
    </div>
  )
}

/** One page. Read-only devices get exactly one notice: the page's own ReadOnlyNotice, worded from its real write rights (F55). */
function SectionPage({ section, advanced }: { section: SettingsSection; advanced: boolean }): ReactNode {
  const Page = pageFor(section.id)
  return (
    <>
      <HealthBanners section={section.id} />
      <Suspense
        fallback={
          <div className="page-fallback" data-suspense-fallback>
            <Spinner size={20} label="Loading" />
          </div>
        }
      >
        {Page ? <Page advanced={advanced} /> : null}
      </Suspense>
    </>
  )
}

// ── nav + search ──────────────────────────────────────────────────────────────────────────────
function SettingsNav({ current, query, onQuery }: { current: string | null; query: string; onQuery(q: string): void }): ReactNode {
  const hits = useMemo<SearchHit[]>(() => searchSettings(query, SECTION_TITLES), [query])
  const resultsRef = useRef<HTMLUListElement>(null)
  const searching = query.trim().length > 0

  const open = (h: SearchHit): void => {
    onQuery('')
    navigate(`/settings/${h.entry.section}?find=${encodeURIComponent(h.entry.path)}`)
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape' && query) {
      e.stopPropagation()
      onQuery('')
    } else if (e.key === 'Enter' && hits[0]) {
      e.preventDefault()
      open(hits[0])
    } else if (e.key === 'ArrowDown' && hits.length) {
      e.preventDefault()
      resultsRef.current?.querySelector<HTMLElement>('a, button')?.focus()
    }
  }

  return (
    <nav className="settings__nav" aria-label="Settings sections">
      <div className="settings__search" role="search">
        <Search className="settings__search-icon" aria-hidden="true" />
        <input
          className="settings__search-input"
          type="search"
          value={query}
          placeholder="Search settings"
          aria-label="Search settings"
          aria-controls={searching ? 'settings-results' : undefined}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onKey}
        />
        {query ? <IconButton size="sm" label="Clear search" icon={<X />} tooltip={false} className="settings__search-clear" onClick={() => onQuery('')} /> : null}
      </div>
      {searching ? (
        <div className="settings__results-wrap">
          <p className="sr-only" role="status">
            {hits.length ? `${hits.length} ${hits.length === 1 ? 'setting' : 'settings'} found` : 'No settings found'}
          </p>
          {hits.length ? (
            <ul className="settings__results" id="settings-results" ref={resultsRef} aria-label="Search results">
              {hits.map((h) => (
                <li key={h.entry.path}>
                  <Link
                    to={`/settings/${h.entry.section}?find=${encodeURIComponent(h.entry.path)}`}
                    className="settings__hit"
                    onClick={() => onQuery('')}
                    onKeyDown={(e) => {
                      const li = e.currentTarget.parentElement
                      if (e.key === 'ArrowDown') (li?.nextElementSibling?.querySelector('a') as HTMLElement | null)?.focus()
                      else if (e.key === 'ArrowUp') ((li?.previousElementSibling?.querySelector('a') as HTMLElement | null) ?? e.currentTarget.closest('nav')?.querySelector('input'))?.focus()
                      else return
                      e.preventDefault()
                    }}
                  >
                    <span className="settings__hit-label">{h.entry.label}</span>
                    <span className="settings__hit-meta">
                      {SECTION_TITLES[h.entry.section]}
                      {h.entry.advanced ? ' · Advanced' : ''}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="settings__noresults">
              <p className="settings__noresults-title">No settings match “{query.trim()}”</p>
              <p>Try a shorter word, such as “voice”, “key” or “theme”.</p>
            </div>
          )}
        </div>
      ) : (
        <ul className="settings__sections">
          {settingsSections.map((s) => {
            const Icon = s.icon
            return (
              <li key={s.id}>
                <Link to={`/settings/${s.id}`} className="settings__link" aria-current={s.id === current ? 'page' : undefined}>
                  <span className="settings__link-icon" aria-hidden="true">
                    <Icon />
                  </span>
                  <span className="settings__link-text">
                    <span className="settings__link-title">{s.title}</span>
                    <span className="settings__link-desc">{s.description}</span>
                  </span>
                  <ChevronRight className="settings__link-chevron" aria-hidden="true" />
                </Link>
              </li>
            )
          })}
        </ul>
      )}
      {searching ? null : (
        <ul className="settings__sections settings__elsewhere" aria-label="Also here">
          {ELSEWHERE.map((e) => {
            const Icon = e.icon
            return (
              <li key={e.to}>
                <Link to={e.to} className="settings__link">
                  <span className="settings__link-icon" aria-hidden="true">
                    <Icon />
                  </span>
                  <span className="settings__link-text">
                    <span className="settings__link-title">{e.title}</span>
                    <span className="settings__link-desc">{e.description}</span>
                  </span>
                  <ChevronRight className="settings__link-chevron" aria-hidden="true" />
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </nav>
  )
}

/** Voice controls are known by their ids (voice-client's VOICE_SETTINGS_UI); everything else by `data-setting`. */
const VOICE_IDS: Record<string, string> = VOICE_SETTINGS_UI

/** The row of a setting on the current page: its `[data-setting]` row, else the row around its control's id. */
function targetRow(path: string): HTMLElement | null {
  const row = document.querySelector<HTMLElement>(`#settings-body [data-setting="${CSS.escape(path)}"]`)
  if (row) return row
  const id = VOICE_IDS[path]
  const control = id ? document.querySelector<HTMLElement>(`#settings-body #${CSS.escape(id)}`) : null
  return control?.closest<HTMLElement>('.field-wrap, .switch-row, .slider') ?? control
}

/**
 * After a search jump: wait for the lazily loaded page to render the row, then scroll, highlight and focus it.
 * Owner of its rAF loop and timeout: both are cancelled when the target or section changes or the page unmounts.
 */
function useTargetRow(section: string | null, path: string | null): void {
  useEffect(() => {
    if (!section || !path) return
    let raf = 0
    let clear = 0
    let tries = 0
    let el: HTMLElement | null = null
    const tick = (): void => {
      el = targetRow(path)
      if (!el) {
        if (++tries < 150) raf = requestAnimationFrame(tick)
        return
      }
      const reduce = document.documentElement.dataset.reduceMotion === 'true' || matchMedia('(prefers-reduced-motion: reduce)').matches
      el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
      el.classList.add('is-target')
      const focusable = el.matches('input:not([type=hidden]), button, [tabindex="0"], textarea') ? el : el.querySelector<HTMLElement>('input:not([type=hidden]), button, [tabindex="0"], textarea')
      focusable?.focus({ preventScroll: true })
      clear = window.setTimeout(() => el?.classList.remove('is-target'), 2400)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(clear)
      el?.classList.remove('is-target')
    }
  }, [section, path])
}
