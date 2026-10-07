/**
 * CopyButton (04; R18 copy/paste) — copies text and confirms in place: the icon turns into a check and "Copied" is
 * announced politely; a failure says "Couldn't copy". Works on plain-HTTP LAN pages too (execCommand fallback).
 *
 *   <CopyButton text={code} />                          // icon button, label "Copy"
 *   <CopyButton getText={() => toMarkdown(msg)} label="Copy as Markdown" variant="button" />
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Copy, X } from 'lucide-react'
import { Button } from './Button'
import { IconButton } from './IconButton'
import { copyText } from './internal/clipboard'
import { track } from './internal/stats'

export interface CopyButtonProps {
  text?: string
  /** Lazily build the text (large messages). */
  getText?: () => string | Promise<string>
  label?: string
  variant?: 'icon' | 'button'
  size?: 'sm' | 'md'
  onCopied?: () => void
  className?: string
}

const FEEDBACK_MS = 1600

export function CopyButton({ text, getText, label = 'Copy', variant = 'icon', size = 'sm', onCopied, className }: CopyButtonProps): ReactNode {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<number | null>(null)
  const clear = (): void => {
    if (timer.current === null) return
    window.clearTimeout(timer.current)
    timer.current = null
    track('kit.timers', -1)
  }
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      clear()
    }
  }, [])

  const copy = async (): Promise<void> => {
    const value = getText ? await getText() : (text ?? '')
    const ok = await copyText(value)
    if (!alive.current) return
    clear()
    setState(ok ? 'copied' : 'failed')
    if (ok) onCopied?.()
    track('kit.timers', 1)
    timer.current = window.setTimeout(() => {
      timer.current = null
      track('kit.timers', -1)
      setState('idle')
    }, FEEDBACK_MS)
  }

  const icon = state === 'copied' ? <Check /> : state === 'failed' ? <X /> : <Copy />
  const shown = state === 'copied' ? 'Copied' : state === 'failed' ? "Couldn't copy" : label
  return (
    <>
      {variant === 'icon' ? (
        <IconButton label={shown} icon={icon} size={size} className={className} data-state={state} onClick={() => void copy()} />
      ) : (
        <Button size={size} variant="ghost" icon={icon} className={className} data-state={state} onClick={() => void copy()}>
          {shown}
        </Button>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {state === 'copied' ? 'Copied to clipboard' : state === 'failed' ? "Couldn't copy to the clipboard" : ''}
      </span>
    </>
  )
}
