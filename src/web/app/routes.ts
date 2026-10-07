/**
 * Route registry (07 E1, BLD-1 §5). Every feature page is code-split (`lazy`) and exports a default component taking
 * `PageProps`. Owners replace their page files; the table changes only through the orchestrator.
 *
 * `layout: 'shell'` renders inside the sidebar/main/panel shell; `'bare'` is full-window (login, setup wizard).
 * `testOnly` routes exist only in test builds running in test mode (07 B10).
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { RouteParams } from '../lib/router.logic'
import { HomeRedirect } from './HomeRedirect'

export interface PageProps {
  params: RouteParams
}

export interface RouteDef {
  path: string
  /** Code-split page. */
  page?: LazyExoticComponent<ComponentType<PageProps>>
  /** Tiny eager component (redirects). */
  component?: ComponentType<PageProps>
  layout: 'shell' | 'bare'
  /** Only in test builds with VESPER_TEST=1. */
  testOnly?: boolean
  /** Reachable before sign-in. */
  public?: boolean
}

export const routes: RouteDef[] = [
  // '/' → the last session on this device, else the most recent one, else a new chat.
  { path: '/', component: HomeRedirect, layout: 'shell' },
  // chat-ui
  { path: '/s/:uid', page: lazy(() => import('../features/chat/ChatPage')), layout: 'shell' },
  // sessions-ui: global search (?q=&mode=&session=&role=&when=&order=)
  { path: '/search', page: lazy(() => import('../features/search/SearchPage')), layout: 'shell' },
  // settings-wizard (sections come from features/settings/sections.ts)
  { path: '/settings/:section?', page: lazy(() => import('../features/settings/SettingsPage')), layout: 'shell' },
  { path: '/setup', page: lazy(() => import('../features/wizard/WizardPage')), layout: 'bare' },
  // access-ui
  { path: '/login', page: lazy(() => import('../features/login/LoginPage')), layout: 'bare', public: true },
  { path: '/pair', page: lazy(() => import('../features/pair/PairPage')), layout: 'bare', public: true },
  // presence (Talk mode and Constellation — 07 A4, BLD-4)
  // Talk mode is a full-window calm stage (07 D6): no sidebar or top bar.
  { path: '/talk/:uid', page: lazy(() => import('../features/presence/TalkPage')), layout: 'bare' },
  { path: '/constellation', page: lazy(() => import('../features/presence/ConstellationPage')), layout: 'shell' },
  // memory-ui (memory viewer · prompt library)
  { path: '/memory/:tab?', page: lazy(() => import('../features/memory/MemoryPage')), layout: 'shell' },
  { path: '/prompts', page: lazy(() => import('../features/prompts/PromptsPage')), layout: 'shell' },
  // ui-kit / audio-core galleries
  ...(__VESPER_TEST__
    ? [{ path: '/gallery', page: lazy(() => import('../features/gallery/GalleryPage')), layout: 'bare' as const, testOnly: true }]
    : []),
  // access-ui: the wizard's Access step on its own (test builds only)
  ...(__VESPER_TEST__
    ? [{ path: '/__test/access-wizard', page: lazy(() => import('../features/access/WizardPreview')), layout: 'bare' as const, testOnly: true }]
    : []),
  // voice-client: the voice lab (test builds only — e2e and screenshots of the mic, reply speech and wizard steps)
  ...(__VESPER_TEST__ ? [{ path: '/voice-lab', page: lazy(() => import('../features/voice/VoiceLab')), layout: 'bare' as const, testOnly: true }] : []),
  // memory-ui: its parts that live in other agents' shells (wizard step 3, the panel's prompt picker)
  ...(__VESPER_TEST__
    ? [{ path: '/test/memory-ui/:view?', page: lazy(() => import('../features/memory/TestPreview')), layout: 'bare' as const, testOnly: true }]
    : []),
  // presence: the Star alone, for screenshots and the leak gates (test builds only)
  ...(__VESPER_TEST__
    ? [{ path: '/presence-lab', page: lazy(() => import('../features/presence/lab/PresenceLab')), layout: 'bare' as const, testOnly: true }]
    : [])
]

/** Routes available in this run (test-only routes need test mode). */
export function activeRoutes(isTest: boolean): RouteDef[] {
  return routes.filter((r) => !r.testOnly || (__VESPER_TEST__ && isTest))
}
