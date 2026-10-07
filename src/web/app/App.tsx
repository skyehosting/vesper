/**
 * Root component: boot phases (booting → login | ready | error), route outlet inside the shell or bare, toasts and
 * the connection banner.
 */
import { Suspense, useEffect, useLayoutEffect, type ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '../components/Button'
import { Spinner } from '../components/Spinner'
import { toast, Toaster, type ToastTone } from '../components/Toast'
import { StarHost } from '../features/presence'
import { AccessHost } from '../features/access/AccessHost'
import { HealthHost } from '../features/health/HealthHost'
import { navigate, useLocation } from '../lib/router'
import { matchRoute } from '../lib/router.logic'
import { useStore } from '../lib/store'
import { markRouteCommitted, registerTestHooks } from '../lib/testHooks'
import { boot } from './boot'
import { ConnectionBanner } from './ConnectionBanner'
import { PageErrorBoundary } from './PageErrorBoundary'
import { activeRoutes, routes, type RouteDef } from './routes'
import { Shell } from './Shell'
import { StarGlyph } from './StarGlyph'

// Test builds: show a toast (optionally with a no-op action) so e2e can check where toasts land (fix5-ui P03/P06/P07).
if (__VESPER_TEST__) {
  registerTestHooks('toast', {
    show: (tone: ToastTone, text: string, o: { title?: string; action?: string; durationMs?: number } = {}) =>
      toast.show(tone, text, { title: o.title, durationMs: o.durationMs ?? 0, action: o.action ? { label: o.action, onClick: () => undefined } : undefined }),
    clear: () => toast.clear()
  })
}

export function App(): ReactNode {
  const phase = useStore((s) => s.phase)
  return (
    <>
      {phase === 'booting' ? <Splash /> : phase === 'error' ? <BootError /> : phase === 'login' ? <LoginOutlet /> : <ReadyOutlet />}
      <ConnectionBanner />
      <Toaster />
      {phase === 'ready' ? <StarHost /> : null}
      {/* access-ui: device approval prompts, sudo prompt, live network/devices events (docs/requests/access-ui.md) */}
      {phase === 'ready' ? <AccessHost /> : null}
      {/* fix-platform: settings recovered, low disk, failed backups (toasts; Settings shows the banners) */}
      {phase === 'ready' ? <HealthHost /> : null}
    </>
  )
}

function Splash(): ReactNode {
  return (
    <div className="app-center" data-loading>
      <div className="app-bare__drag app-drag" />
      <StarGlyph size={44} />
      <Spinner label="Starting Vesper" />
    </div>
  )
}

function BootError(): ReactNode {
  const error = useStore((s) => s.bootError)
  return (
    <div className="app-center" role="alert">
      <div className="app-bare__drag app-drag" />
      <StarGlyph size={44} />
      <h1 className="app-center__title">Can't reach Vesper</h1>
      <p>{error?.message ?? 'Something went wrong while starting.'} Retrying…</p>
      <Button icon={<RotateCcw />} onClick={() => void boot()}>
        Retry now
      </Button>
    </div>
  )
}

/** Before sign-in only public routes render; anything else shows the login page. */
function LoginOutlet(): ReactNode {
  const { pathname } = useLocation()
  // access-ui: a public route other than /login (the /pair page) renders itself before sign-in.
  const login = matchRoute(routes.filter((r) => r.public), pathname)?.route ?? routes.find((r) => r.path === '/login')
  useLayoutEffect(() => markRouteCommitted(pathname), [pathname])
  return login ? <RoutePage route={login} params={{}} bare /> : null
}

function ReadyOutlet(): ReactNode {
  const { pathname } = useLocation()
  const isTest = useStore((s) => s.bootstrap?.isTest ?? false)
  const match = matchRoute(activeRoutes(isTest), pathname)

  // Unknown paths and /login after sign-in go home.
  const redirect = !match || match.route.path === '/login'
  useEffect(() => {
    if (redirect) navigate('/', { replace: true })
  }, [redirect])
  useLayoutEffect(() => {
    if (!redirect) markRouteCommitted(pathname)
  }, [redirect, pathname])
  if (redirect || !match) return <div data-loading hidden />

  const page = <RoutePage route={match.route} params={match.params} bare={match.route.layout === 'bare'} />
  return match.route.layout === 'shell' ? <Shell>{page}</Shell> : page
}

function RoutePage({ route, params, bare }: { route: RouteDef; params: Record<string, string | undefined>; bare: boolean }): ReactNode {
  const Page = route.page ?? route.component
  if (!Page) return null
  const content = (
    <PageErrorBoundary resetKey={route.path}>
      <Suspense fallback={<PageFallback />}>
        <Page params={params} />
      </Suspense>
    </PageErrorBoundary>
  )
  return bare ? (
    <div className="app-bare">
      <div className="app-bare__drag app-drag" />
      {content}
    </div>
  ) : (
    content
  )
}

function PageFallback(): ReactNode {
  return (
    <div className="page-fallback" data-suspense-fallback>
      <Spinner size={20} label="Loading" />
    </div>
  )
}
