/**
 * The composer (R18, 07 B6/C8/D8): auto-growing text area; Enter sends and Shift+Enter is a new line (phones default
 * to Enter = new line, 07 D8); the "/" menu from the command registry; attachments by button, drag & drop (the chat
 * page) and paste — images are scaled in the client and uploaded at once with progress, at most 10 per message;
 * pastes over 4,000 characters become a "Pasted text" attachment; the mic slot (voice-client's MicControl); Stop while
 * a reply streams; the draft is kept per session on this device.
 */
import { useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { ArrowUp, FileText, Paperclip, Square, X } from 'lucide-react'
import { IconButton } from '../../components/IconButton'
import { ProgressRing } from '../../components/Progress'
import { TextArea } from '../../components/TextArea'
import { toast } from '../../components/Toast'
import { filesFromClipboard } from '../../components/FileDrop'
import { formatBytes } from '../../components/internal/files.logic'
import { api } from '../../lib/api'
import { commands, runCommand, type Command, type CommandContext } from '../../lib/commands'
import { unescapeSlash } from '../../lib/commands/registry'
import { isApiError, toApiError } from '../../lib/errors.logic'
import { navigate } from '../../lib/router'
import { useStore } from '../../lib/store'
import { useMediaQuery } from '../../lib/useMediaQuery'
import { ws } from '../../lib/ws'
import { interruptSpeech, MicControl } from '../voice'
import { newClientMsgId, sendMessage, stopReply } from './actions'
import { emitChat, onChat } from './bus'
import { ACCEPT, MAX_FILES, PASTE_CHIP_CHARS, pastePreview } from './composer/attachments.logic'
import { loadDraft, saveDraft } from './composer/draft'
import { SlashMenu, slashOptionId } from './composer/SlashMenu'
import { useAttachments, type Pending } from './composer/useAttachments'
import type { WindowController } from './window/controller'

export interface ComposerHandle {
  addFiles(files: readonly File[]): void
  focus(): void
}

export interface ComposerProps {
  sessionUid: string
  replying: boolean
  controller: WindowController | null
  /** A temporary chat (07 B9): uploads go to the temp store, the draft stays in memory. null = not known yet. */
  temporary?: boolean | null
  ref?: Ref<ComposerHandle>
}

/** The "/word" being typed at the start of the text (menu open), else null. */
function slashQuery(text: string, caret: number): string | null {
  if (!text.startsWith('/') || text.startsWith('//')) return null
  const firstSpace = text.search(/\s/)
  const end = firstSpace < 0 ? text.length : firstSpace
  if (caret > end) return null
  return text.slice(1, end)
}

export function Composer({ sessionUid, replying, controller, temporary = null, ref }: ComposerProps): ReactNode {
  const [text, setText] = useState(() => loadDraft(sessionUid, temporary))
  const [caret, setCaret] = useState(0)
  const [sending, setSending] = useState(false)
  /**
   * F62: the text given back after a send whose outcome the client couldn't learn (no connection in time), with its
   * client message id — sending the same text again reuses the id, so the server never makes it twice.
   */
  const unsent = useRef<{ text: string; shas: string; cmid: string } | null>(null)
  const [menuActive, setMenuActive] = useState(0)
  const [menuClosed, setMenuClosed] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const menuId = useId()
  // Phones default to Enter = newline (07 D8 DevicePrefs); the send button is right there.
  const touch = useMediaQuery('(pointer: coarse)')
  const sendOnEnter = useStore((s) => s.settings?.chat.sendOnEnter ?? true) && !touch
  const assistantName = useStore((s) => s.settings?.profile.assistantName || 'Vesper')
  const maxMb = useStore((s) => s.settings?.chat.attachments.maxFileMb ?? 25)
  const att = useAttachments({ maxBytes: maxMb * 1024 * 1024, temporary, sessionUid })
  // A reply's voice is playing on this device, or one is still being prepared for it (P02): Stop also stops it (07 C15
  // barge-in by Stop; before any audio it only cancels the voice and the text arrives, F31).
  const speaking = useStore((s) => s.voice.ttsActive || Object.values(s.speech).some((sp) => sp.state === 'waiting'))

  // Drafts: per session, saved shortly after typing stops and when leaving; a temporary chat's only in memory (F09).
  const textRef = useRef(text)
  textRef.current = text
  const tempRef = useRef(temporary)
  tempRef.current = temporary
  useEffect(() => {
    const t = window.setTimeout(() => saveDraft(sessionUid, text, temporary), 400)
    return () => window.clearTimeout(t)
  }, [sessionUid, text, temporary])
  useEffect(() => () => saveDraft(sessionUid, textRef.current, tempRef.current), [sessionUid])

  const cmdCtx = useMemo<CommandContext>(() => ({ sessionUid, navigate, api, ws, toast, setDraft: (t: string) => setText(t) }), [sessionUid])
  const q = slashQuery(text, caret)
  const matches = useMemo(() => (q === null ? [] : commands.complete(q, cmdCtx)), [q, cmdCtx])
  const menuOpen = matches.length > 0 && !menuClosed && !(matches.length === 1 && matches[0].name === q && text.includes(' '))
  useEffect(() => {
    setMenuActive(0)
    setMenuClosed(false)
  }, [q])

  const focus = useCallback(() => input.current?.focus({ preventScroll: true }), [])
  useImperativeHandle(ref, () => ({ addFiles: (f) => void att.add(f), focus }), [att.add, focus])

  useEffect(() => {
    const offs = [
      onChat('insert', (e) => {
        if (e.sessionUid !== sessionUid) return
        setText(e.text)
        requestAnimationFrame(focus)
      }),
      onChat('focus-composer', (e) => {
        if (e.sessionUid === sessionUid) focus()
      })
    ]
    return () => offs.forEach((off) => off())
  }, [sessionUid, focus])

  const pick = (c: Command): void => {
    const rest = text.replace(/^\/\S*/, '')
    const next = `/${c.name}${c.args ? ' ' : rest ? '' : ' '}${rest.trimStart()}`
    setText(c.args || rest ? next : `/${c.name}`)
    setMenuClosed(!c.args)
    requestAnimationFrame(() => {
      const el = input.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
      setCaret(el.value.length)
    })
  }

  const uploading = att.items.some((a) => a.status === 'preparing' || a.status === 'uploading')
  const failed = att.items.some((a) => a.status === 'error')
  const canSend = (!!text.trim() || att.items.some((a) => a.status === 'done')) && !uploading && !failed && !sending

  const submit = async (interrupt = false): Promise<void> => {
    const raw = text
    if (!canSend && !interrupt) {
      if (uploading) toast.info('Wait for the attachments to finish uploading.')
      else if (failed) toast.warning('Remove the attachments that failed first.')
      return
    }
    // Slash commands run in the client (03 §5); unknown "/words" are sent as text.
    if (att.items.length === 0) {
      // P17: a command may open another chat before it resolves (/continue, /new, /temp, /talk…), and leaving this one
      // saves its draft — so the command leaves the composer and this chat's draft BEFORE it runs. It comes back only
      // when it fails.
      const hit = commands.resolve(raw)
      const isCommand = !!hit && (!hit.def.available || hit.def.available(cmdCtx))
      const uid = sessionUid
      const temp = temporary
      if (isCommand) {
        textRef.current = ''
        setText('')
        saveDraft(uid, '', temp)
      }
      try {
        if (await runCommand(raw, cmdCtx)) return
      } catch (e) {
        if (isCommand) {
          saveDraft(uid, raw, temp)
          setText((cur) => (cur ? cur : raw))
        }
        toast.error(toApiError(e).message)
        return
      }
    }
    const sent: Pending[] = att.items.filter((a) => a.status === 'done')
    const shas = sent.map((a) => a.ref?.sha).filter((s): s is string => !!s)
    const prior = unsent.current
    const cmid = prior && prior.text === raw && prior.shas === shas.join(',') ? prior.cmid : newClientMsgId()
    setText('')
    att.clear()
    setSending(true)
    try {
      // Sending brings the conversation to its newest message (the reply appears there).
      await controller?.jumpLatest()
      // A dropped socket doesn't fail the send: it is resent unchanged after the reconnect and the server dedupes it
      // (F62), so the text only comes back when the send failed or no connection came back in time.
      await sendMessage(sessionUid, unescapeSlash(raw), shas, { ...(interrupt ? { interrupt: true } : {}), clientMsgId: cmid })
      unsent.current = null
      emitChat('focus-composer', { sessionUid })
    } catch (e) {
      // Give everything back so nothing typed or attached is lost.
      unsent.current = { text: raw, shas: shas.join(','), cmid }
      setText((cur) => (cur ? cur : raw))
      att.restore(sent)
      if (isApiError(e, 'session_busy')) {
        toast.info(`${assistantName} is still answering.`, { action: { label: 'Stop and send', onClick: () => void submit(true) } })
      } else toast.error(toApiError(e).message)
    } finally {
      setSending(false)
      focus()
    }
  }

  /** Push-to-talk / dictation auto-send (voice-client's MicControl): the spoken words, sent like a typed message. */
  const sendSpoken = async (spoken: string): Promise<void> => {
    const t = spoken.trim()
    if (!t) return
    const cmid = newClientMsgId()
    try {
      await controller?.jumpLatest()
      await sendMessage(sessionUid, t, [], { clientMsgId: cmid })
    } catch (e) {
      // Nothing said is lost: it goes into the composer (sent again as it is, it keeps its id, F62).
      if (!textRef.current.trim()) unsent.current = { text: t, shas: '', cmid }
      setText((cur) => (cur ? `${cur.replace(/\s+$/, '')} ${t}` : t))
      toast.error(toApiError(e).message)
    }
  }

  const stop = (): void => {
    if (replying) stopReply(sessionUid)
    interruptSpeech()
    focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menuOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setMenuActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length)
        return
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        const c = matches[menuActive]
        // Enter on a complete command with no arguments runs it; otherwise complete the name.
        if (!(e.key === 'Enter' && c && q === c.name && !c.args)) {
          e.preventDefault()
          if (c) pick(c)
          return
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setMenuClosed(true)
        return
      }
    }
    if (e.key === 'ArrowUp' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !text && att.items.length === 0) {
      e.preventDefault()
      emitChat('edit-last', { sessionUid })
      return
    }
    if (e.key === 'ArrowUp' && e.altKey) {
      // Alt+↑ from the composer: into the conversation (07 D9).
      const last = [...document.querySelectorAll<HTMLElement>('[data-testid="message-window"] article.msg')].pop()
      if (last) {
        e.preventDefault()
        last.focus()
      }
      return
    }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    if (e.ctrlKey || e.metaKey || (sendOnEnter && !e.shiftKey)) {
      e.preventDefault()
      void submit()
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = filesFromClipboard(e.clipboardData)
    if (files.length > 0) {
      e.preventDefault()
      att.add(files)
      return
    }
    const pasted = e.clipboardData.getData('text/plain')
    if (pasted.length > PASTE_CHIP_CHARS) {
      e.preventDefault()
      const file = new File([pasted], 'Pasted text.txt', { type: 'text/plain' })
      att.add([file], pastePreview(pasted))
    }
  }

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault()
    void submit()
  }

  const activeId = menuOpen ? slashOptionId(menuId, menuActive) : undefined
  return (
    <form className="composer" onSubmit={onSubmit} aria-label="Write a message">
      {menuOpen ? <SlashMenu id={menuId} items={matches} active={menuActive} onPick={pick} onHover={setMenuActive} /> : null}
      <div className="composer__box">
        {att.items.length > 0 ? (
          <ul className="composer__atts" aria-label={`Attachments, ${att.items.length} of ${MAX_FILES}`}>
            {att.items.map((a) => (
              <AttachmentChip key={a.id} a={a} onRemove={() => att.remove(a.id)} />
            ))}
          </ul>
        ) : null}
        <div className="composer__row">
          <IconButton label="Attach files" icon={<Paperclip />} className="composer__attach" disabled={att.items.length >= MAX_FILES} onClick={() => fileInput.current?.click()} />
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              if (e.target.files) att.add([...e.target.files])
              e.target.value = ''
            }}
          />
          <TextArea
            ref={input}
            label={`Message ${assistantName}`}
            labelHidden
            wrapClassName="composer__field"
            className="composer__input"
            minRows={1}
            maxRows={10}
            value={text}
            placeholder={`Message ${assistantName}…`}
            enterKeyHint={sendOnEnter ? 'send' : 'enter'}
            aria-autocomplete="list"
            aria-controls={menuOpen ? menuId : undefined}
            aria-activedescendant={activeId}
            onChange={(e) => {
              setText(e.target.value)
              setCaret(e.target.selectionStart ?? e.target.value.length)
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            autoFocus={!touch}
            data-testid="composer-input"
          />
          <MicControl
            sessionUid={sessionUid}
            className="composer__mic"
            onText={(t) => setText((cur) => (cur ? `${cur.replace(/\s+$/, '')} ${t}` : t))}
            onSend={(t) => void sendSpoken(t)}
          />
          {replying || speaking ? <IconButton label="Stop" icon={<Square />} variant="secondary" className="composer__stop" onClick={stop} /> : null}
          {!replying || text.trim() || att.items.length ? (
            <IconButton type="submit" label="Send" icon={<ArrowUp />} variant="primary" className="composer__send" disabled={!canSend} loading={sending} />
          ) : null}
        </div>
      </div>
    </form>
  )
}

function AttachmentChip({ a, onRemove }: { a: Pending; onRemove: () => void }): ReactNode {
  const busy = a.status === 'preparing' || a.status === 'uploading'
  const label = a.pasted ? 'Pasted text' : a.name
  return (
    <li className={`att-chip${a.status === 'error' ? ' is-error' : ''}`} title={a.error ?? a.name}>
      <span className="att-chip__thumb" aria-hidden="true">
        {a.preview ? <img src={a.preview} alt="" /> : <FileText />}
        {busy ? (
          <span className="att-chip__progress">
            <ProgressRing value={a.status === 'uploading' ? a.progress : undefined} size={22} label={`Uploading ${label}`} />
          </span>
        ) : null}
      </span>
      <span className="att-chip__text">
        <span className="att-chip__name">{label}</span>
        <span className="att-chip__meta">{a.status === 'error' ? (a.error ?? 'Upload failed') : a.pasted ? a.pasted : busy ? (a.status === 'preparing' ? 'Preparing…' : `Uploading ${Math.round(a.progress * 100)}%`) : formatBytes(a.size)}</span>
      </span>
      <button type="button" className="att-chip__remove" aria-label={`Remove ${label}`} onClick={onRemove}>
        <X aria-hidden="true" />
      </button>
    </li>
  )
}
