/**
 * '/s/:uid' — the conversation (R5, R8, R14, R16, R18): the MessageWindow over the session's whole history, the
 * composer, in-session search (Ctrl+F), drag & drop anywhere on the chat, the empty/error states (07 D13) and the
 * reply announcements for screen readers (07 D9: streaming is not a live region; completed replies are announced per
 * `chat.announceReplies`). `/s/:uid?m=<messageUid>` opens the chat at that message (search hits, memory citations).
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AudioLines, EyeOff, Search, Timer } from 'lucide-react'
import { formatShortId } from '@shared/ids'
import { Badge } from '../../components/Badge'
import { Banner } from '../../components/Callout'
import { Button } from '../../components/Button'
import { Dialog } from '../../components/Dialog'
import { DropOverlay, useFileDrop } from '../../components/FileDrop'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { IconButton } from '../../components/IconButton'
import { Kbd } from '../../components/Kbd'
import { Skeleton } from '../../components/Skeleton'
import { toast } from '../../components/Toast'
import { rejectMessage } from '../../components/internal/files.logic'
import { TopBarContent } from '../../app/topBar'
import type { PageProps } from '../../app/routes'
import { commands } from '../../lib/commands'
import { toApiError } from '../../lib/errors.logic'
import { navigate, useLocation } from '../../lib/router'
import { useStore } from '../../lib/store'
import { isActiveReply } from '../../lib/store/chat.logic'
import { ws } from '../../lib/ws'
import { AvatarAnchor, ChatBackdrop, useChatBackdrop } from '../presence'
import { rememberSession } from '../sessions/data'
import { titleOf } from '../sessions/group.logic'
import { emitChat, onChat } from './bus'
import { Composer, type ComposerHandle } from './Composer'
import { ACCEPT, MAX_FILES } from './composer/attachments.logic'
import { FindBar } from './FindBar'
import { markdownToPlain } from './markdown/blocks.logic'
import { installChatTestHooks } from './testHooks'
import { WindowController } from './window/controller'
import { MessageWindow } from './window/MessageWindow'
import { loadViewState } from './window/viewState'
import { TEMPORARY_CHAT_BANNER } from '../sessions/temporaryChat.logic'
import './chat.css'

if (__VESPER_TEST__) installChatTestHooks()

const SESSION_EVENTS = [
  'subscribed',
  'message.created',
  'message.updated',
  'message.deleted',
  'reply.status',
  'reply.delta',
  'reply.reasoning',
  'reply.tool',
  'reply.snapshot',
  'reply.done',
  'reply.error'
] as const

const SUGGESTIONS = ['Tell me something you find fascinating', 'Help me plan my week', 'Ask me a question to get to know me']

/** The wizard's setup checklist (07 D13), loaded only when the first chat's empty state shows it. */
const SetupChecklist = lazy(() => import('../wizard').then((m) => ({ default: m.SetupChecklist })))

export default function ChatPage({ params }: PageProps): ReactNode {
  const uid = params.uid ?? ''
  // One instance per session: switching chats starts from a clean slate (draft, search, editing, window).
  return <ChatSession key={uid} uid={uid} />
}

function ChatSession({ uid }: { uid: string }): ReactNode {
  const view = useStore((s) => s.chats[uid])
  // The chat's own facts come from its detail (GET /api/sessions/:uid, kept by the shell), else its sidebar row. The
  // sidebar list is filtered by its search box, so it can't be the only source (F70: the Temporary notice vanished
  // and uploads went to the permanent store once the owner searched the sidebar).
  const listed = useStore((s) => s.sessions.items.find((x) => x.uid === uid))
  const detail = useStore((s) => (s.activeSession?.uid === uid ? s.activeSession : null))
  const summary = listed ?? detail ?? undefined
  // Temporary-ness never changes for a chat: once known it stays, null until then (the composer then asks the server
  // before an upload and keeps the draft in memory).
  const temporaryRef = useRef<boolean | null>(null)
  const known = detail?.temporary ?? listed?.temporary
  if (known === true || (known === false && temporaryRef.current === null)) temporaryRef.current = known
  const temporary = temporaryRef.current
  const pageSize = useStore((s) => s.settings?.chat.pageSize ?? 100)
  const assistantName = useStore((s) => s.settings?.profile.assistantName || 'Vesper')
  const hasLlm = useStore((s) => !!s.settings && s.settings.llm.profiles.length > 0)
  // Talk mode is offered here only once voice input is on (it would open into an error otherwise; review F51).
  const voiceIn = useStore((s) => s.settings?.voice.stt.enabled ?? false)
  const { search } = useLocation()
  const controller = useMemo(() => new WindowController(uid, pageSize), [uid])
  controller.pageSize = pageSize
  const composer = useRef<ComposerHandle>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [announce, setAnnounce] = useState('')

  useEffect(() => {
    controller.activate()
    return () => controller.dispose()
  }, [controller])

  // ── subscription + first page (subscribe first: events that race the page are merged into it) ──────────────────
  useEffect(() => {
    if (!uid) return
    const st = useStore.getState
    st().setActiveSession(uid)
    rememberSession(uid)
    st().chatOpen(uid)
    let alive = true
    const unsubscribe = ws.subscribe(uid)
    const offs = SESSION_EVENTS.map((t) =>
      ws.on(t, (m) => {
        if (m.sessionUid === uid) st().chatEvent(uid, m)
      })
    )
    offs.push(
      ws.onResync((s) => {
        if (s === uid) void controller.reload()
      }),
      ws.on('session.path_changed', (m) => {
        if (m.sessionUid === uid) void controller.reload()
      }),
      ws.onSubscribeError((s, err) => {
        if (s === uid) st().chatFailed(uid, err)
      })
    )
    void loadViewState(uid).then((saved) => {
      if (alive) void controller.open(saved)
    })
    return () => {
      alive = false
      for (const off of offs) off()
      unsubscribe()
      st().dropChat(uid)
      if (st().activeSessionUid === uid) st().setActiveSession(null)
    }
  }, [uid, controller])

  // ── permalink: /s/:uid?m=<messageUid> ───────────────────────────────────────────────────────
  const target = new URLSearchParams(search).get('m')
  const ready = view?.status === 'ready'
  useEffect(() => {
    if (!target || !ready) return
    navigate(`/s/${uid}`, { replace: true })
    controller.jumpToMessage(target).catch((e: unknown) => toast.error(toApiError(e).message))
  }, [target, ready, uid, controller])

  // ── announcements (07 D9) ───────────────────────────────────────────────────────────────────
  const announceMode = useStore((s) => s.settings?.chat.announceReplies ?? 'full')
  useEffect(() => {
    if (announceMode === 'off') return
    return ws.on('reply.done', (m) => {
      if (m.sessionUid !== uid || m.message.status === 'error') return
      const speaking = useStore.getState().voice.speakingReplyId === m.replyId
      const full = announceMode === 'full' && !speaking
      const text = full ? markdownToPlain(m.message.body).slice(0, 1200) : `${assistantName} replied.`
      setAnnounce('')
      requestAnimationFrame(() => setAnnounce(full ? `${assistantName}: ${text}` : text))
    })
  }, [uid, announceMode, assistantName])

  // ── keyboard: Ctrl+F opens search; /help opens the commands sheet ─────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setFindOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    const offs = [
      onChat('open-help', () => setHelpOpen(true)),
      onChat('open-find', (e) => {
        if (e.sessionUid === uid) setFindOpen(true)
      })
    ]
    return () => {
      window.removeEventListener('keydown', onKey)
      offs.forEach((off) => off())
    }
  }, [uid])

  // ── drag & drop anywhere on the chat (R18) ──────────────────────────────────────────────────
  const maxMb = useStore((s) => s.settings?.chat.attachments.maxFileMb ?? 25)
  const rules = { accept: ACCEPT, maxBytes: maxMb * 1024 * 1024, maxFiles: MAX_FILES, rejectEmpty: true }
  const { dragging, bind } = useFileDrop({
    ...rules,
    disabled: !view || (view.status === 'error' && view.messages.length === 0),
    onFiles: (ok, refused) => {
      if (ok.length) composer.current?.addFiles(ok)
      if (refused.length) toast.warning([...new Set(refused.map((r) => rejectMessage(r, rules)))].join('\n'))
    }
  })

  // The header's, the sidebar's and the chat-start marker's name: "Temporary chat" for an untitled temporary chat (P24).
  const title = titleOf({ title: summary?.title ?? '', temporary: temporary === true || summary?.temporary === true })
  useEffect(() => {
    document.title = `${title} · Vesper`
    return () => {
      document.title = 'Vesper'
    }
  }, [title])

  const replying = useMemo(() => (view ? Object.values(view.inflight).some(isActiveReply) : false), [view])
  const empty = !!view && view.status === 'ready' && view.messages.every((m) => m.hidden) && Object.keys(view.inflight).length === 0
  // 07 D13: the first chat (no other chat has messages yet) also lists the setup steps skipped in the wizard.
  const firstChat = useStore((s) => s.sessions.items.every((x) => x.uid === uid || x.lastSeq === 0))
  const fatal = !!view && view.status === 'error' && view.messages.length === 0
  const loading = !view || (view.status === 'loading' && view.messages.length === 0)
  // Suggestion chips fill the composer through the same path as commands.
  const insert = useCallback((text: string) => void emitChat('insert', { sessionUid: uid, text }), [uid])
  // v11: the avatar sits behind the messages (presence <ChatBackdrop>); an empty chat makes it the hero.
  const backdrop = useChatBackdrop().shown

  return (
    <div className="chat" data-backdrop={backdrop || undefined} {...bind}>
      <TopBarContent>
        <h1 className="chat__title" title={title}>
          {title}
        </h1>
        {summary ? <span className="chat__id mono">{formatShortId(summary.shortId)}</span> : null}
        {summary?.private ? (
          <Badge tone="neutral" icon={<EyeOff />} title="Private: never sent to the memory service, never recalled elsewhere">
            Private
          </Badge>
        ) : null}
        {temporary ? (
          <Badge tone="warning" icon={<Timer />}>
            Temporary
          </Badge>
        ) : null}
        <span className="chat__spacer" />
        <IconButton label="Search this chat (Ctrl+F)" icon={<Search />} className="no-drag" pressed={findOpen} onClick={() => setFindOpen((o) => !o)} tooltipSide="bottom" />
      </TopBarContent>

      <div className="chat__body">
        <ChatBackdrop settled={!loading} />
        {findOpen && view?.status !== undefined ? <FindBar sessionUid={uid} controller={controller} onClose={() => (setFindOpen(false), composer.current?.focus())} /> : null}
        {loading ? (
          <LoadingRows />
        ) : fatal ? (
          <div className="chat__state">
            {view.error?.code === 'not_found' ? (
              <EmptyState
                icon={<Search />}
                title="This chat doesn't exist anymore"
                description="It may have been deleted on another device."
                actions={
                  <Button variant="primary" onClick={() => navigate('/', { replace: true })}>
                    Go to my chats
                  </Button>
                }
              />
            ) : (
              <ErrorState error={view.error} title="Couldn't open this chat" onRetry={() => void controller.reload()} />
            )}
          </div>
        ) : empty ? (
          <div className="chat__state" data-hero={backdrop || undefined}>
            {backdrop ? <AvatarAnchor /> : null}
            <EmptyState
              star={!backdrop}
              size="lg"
              title="What's on your mind?"
              description={hasLlm ? `${assistantName} remembers what you choose to share, and can speak replies aloud.` : undefined}
              suggestions={hasLlm ? SUGGESTIONS : undefined}
              onSuggestion={insert}
              actions={
                hasLlm ? (
                  // Talk mode's entry where a new conversation starts (R15/R19, review F39).
                  voiceIn ? (
                    <Button variant="secondary" icon={<AudioLines />} onClick={() => navigate(`/talk/${uid}`)}>
                      Talk instead
                    </Button>
                  ) : undefined
                ) : (
                  <Button variant="primary" onClick={() => navigate('/settings/providers')}>
                    Connect an AI service
                  </Button>
                )
              }
            />
            {firstChat ? (
              <Suspense fallback={null}>
                <div className="chat__checklist">
                  <SetupChecklist />
                </div>
              </Suspense>
            ) : null}
          </div>
        ) : (
          <MessageWindow view={view} controller={controller} sessionTitle={title} createdUtc={summary?.createdUtc ?? null} />
        )}
        {view?.status === 'error' && view.messages.length > 0 ? (
          <Banner tone="danger" className="chat__banner" actions={<Button size="sm" onClick={() => void controller.reload()}>Retry</Button>}>
            {view.error?.message ?? "Couldn't load messages."}
          </Banner>
        ) : null}
        {dragging ? <DropOverlay label="Drop to attach" /> : null}
      </div>

      {view?.notice ? (
        <div className="chat__notice" role="status">
          <span>{view.notice.message}</span>
          <Button size="sm" variant="ghost" onClick={() => useStore.getState().chatClearNotice(uid)}>
            Dismiss
          </Button>
        </div>
      ) : null}
      {temporary ? (
        <p className="chat__temp">
          <Timer aria-hidden="true" />
          {TEMPORARY_CHAT_BANNER}
        </p>
      ) : null}

      {fatal ? null : <Composer ref={composer} sessionUid={uid} replying={replying} controller={controller} temporary={temporary} />}

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announce}
      </div>
      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  )
}

function LoadingRows(): ReactNode {
  return (
    <div className="chat__loading" data-loading aria-busy="true" aria-label="Loading messages">
      {[0, 1, 2].map((i) => (
        <div key={i} className={`chat__loading-row${i % 2 ? ' is-user' : ''}`}>
          <Skeleton lines={i % 2 ? 1 : 3} />
        </div>
      ))}
    </div>
  )
}

function HelpDialog({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const list = useMemo(() => (open ? commands.list() : []), [open])
  return (
    <Dialog open={open} onClose={onClose} title="Commands" description="Type a command at the start of a message. Start with // to send a message that begins with a slash." size="md">
      {/* Focusable so keyboard users can scroll the list (it overflows on phones and short windows; axe
          scrollable-region-focusable): the dialog's first focus lands here. */}
      <div className="help-cmds__scroll" tabIndex={0} role="region" aria-label="Commands">
        <dl className="help-cmds">
          {list.map((c) => (
            <div key={c.name} className="help-cmds__row">
              <dt className="mono">
                /{c.name}
                {c.args ? <span className="help-cmds__args"> {c.args}</span> : null}
              </dt>
              <dd>{c.help}</dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="help-cmds__keys">
        <Kbd>Enter</Kbd> send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> new line · <Kbd>Ctrl</Kbd>+<Kbd>F</Kbd> search · <Kbd>Alt</Kbd>+<Kbd>↑</Kbd>/<Kbd>↓</Kbd> move between messages · <Kbd>↑</Kbd> edit your last message
      </p>
    </Dialog>
  )
}
