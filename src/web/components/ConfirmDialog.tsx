/**
 * ConfirmDialog — "Are you sure?" built on Dialog: a clear verb on the confirm button, Cancel focused first for
 * destructive actions, an optional typed confirmation ("type DELETE"), and an async `onConfirm` that shows progress and
 * keeps the dialog open with the error if it fails. `useConfirm()` gives the same thing as a promise.
 *
 *   <ConfirmDialog open={ask} onClose={() => setAsk(false)} tone="danger" title="Delete this chat?"
 *     description="It moves to the trash for 30 days." confirmLabel="Delete" onConfirm={del} />
 *
 *   const { confirm, dialog } = useConfirm()
 *   if (await confirm({ title: 'Forget this memory?', confirmLabel: 'Forget', tone: 'danger' })) forget()
 *   return <>{…}{dialog}</>
 */
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { Button } from './Button'
import { Dialog } from './Dialog'
import { TextField } from './TextField'
import { ApiErrorException } from '../lib/errors.logic'
import './ConfirmDialog.css'

export interface ConfirmOptions {
  title: ReactNode
  description?: ReactNode
  /** Extra content (a checkbox such as "Also delete attachments", a list of what goes). */
  children?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'primary' | 'danger'
  /** The user must type this text exactly to enable the confirm button. */
  requireText?: string
}

export interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean
  onClose: () => void
  /** May be async: the dialog shows progress, closes on success, shows the error on failure. */
  onConfirm: () => void | Promise<void>
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'primary',
  requireText
}: ConfirmDialogProps): ReactNode {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const cancelRef = useRef<HTMLButtonElement>(null)
  const typedRef = useRef<HTMLInputElement>(null)
  const blocked = requireText !== undefined && typed !== requireText

  const close = (): void => {
    if (busy) return
    setTyped('')
    setError(null)
    onClose()
  }
  const run = async (): Promise<void> => {
    if (blocked || busy) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
      setBusy(false)
      setTyped('')
      onClose()
    } catch (e) {
      setBusy(false)
      setError(e instanceof ApiErrorException ? e.error.message : 'That didn’t work. Try again.')
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      description={description}
      size="sm"
      dismissible={!busy}
      // Destructive: start on Cancel so Enter doesn't destroy by accident; typed confirmation starts in its field.
      initialFocus={requireText !== undefined ? typedRef : tone === 'danger' ? cancelRef : undefined}
      footer={
        <>
          <Button ref={cancelRef} onClick={close} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} loading={busy} disabled={blocked} onClick={() => void run()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children || requireText !== undefined || error ? (
        <div className="confirm__body">
          {children}
          {requireText !== undefined ? (
            <TextField
              ref={typedRef}
              label={
                <>
                  Type <strong className="mono">{requireText}</strong> to confirm
                </>
              }
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void run()
              }}
            />
          ) : null}
          {error ? (
            <p className="confirm__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : undefined}
    </Dialog>
  )
}

/** Promise-style confirmation: render `dialog` once; `confirm(opts)` resolves true (confirmed) or false. */
export function useConfirm(): { confirm: (o: ConfirmOptions) => Promise<boolean>; dialog: ReactNode } {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null)
  const confirm = useCallback(
    (o: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setState((cur) => {
          cur?.resolve(false)
          return { ...o, resolve }
        })
      }),
    []
  )
  const dialog = (
    <ConfirmDialog
      {...(state ?? { title: '' })}
      open={state !== null}
      onConfirm={() => {
        state?.resolve(true)
      }}
      onClose={() => {
        state?.resolve(false)
        setState(null)
      }}
    />
  )
  return { confirm, dialog }
}
