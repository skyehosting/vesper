/**
 * FileDrop (R18: attachments, pasting files/images) — a drop zone that also takes paste (Ctrl+V while focused) and
 * click-to-browse, checks type/size/count immediately (`files.logic.ts`; the server re-validates, 07 B6) and reports
 * refusals in words. `useFileDrop` turns any element (the whole chat) into a drop target with an overlay, and
 * `filesFromClipboard` pulls files out of a paste event for the composer.
 *
 *   <FileDrop accept="image/*,.pdf,.docx,.txt,.md" maxBytes={25e6} maxFiles={10} onFiles={(ok, refused) => …} />
 *   const { dragging, bind } = useFileDrop({ onFiles }); <main {...bind}>{dragging && <DropOverlay/>}</main>
 */
import { useCallback, useEffect, useId, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react'
import { Upload } from 'lucide-react'
import { cx } from './internal/cx'
import { formatBytes, partitionFiles, rejectMessage, type IntakeRules, type Rejected } from './internal/files.logic'
import { track } from './internal/stats'
import './FileDrop.css'

export type { Rejected } from './internal/files.logic'

/** Files in a paste (screenshots, copied files); empty when only text was pasted. */
export function filesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return []
  const out: File[] = []
  for (const item of data.items ?? []) {
    if (item.kind === 'file') {
      const f = item.getAsFile()
      if (f) out.push(f)
    }
  }
  return out.length > 0 ? out : [...(data.files ?? [])]
}

const hasFiles = (e: DragEvent): boolean => [...(e.dataTransfer?.types ?? [])].includes('Files')

export interface UseFileDropOptions extends IntakeRules {
  onFiles: (accepted: File[], rejected: Rejected<File>[]) => void
  disabled?: boolean
}

/** Make an element a drop target. Spread `bind` on it; `dragging` is true while files hover over it. */
export function useFileDrop(o: UseFileDropOptions): {
  dragging: boolean
  bind: {
    onDragEnter: (e: DragEvent) => void
    onDragOver: (e: DragEvent) => void
    onDragLeave: (e: DragEvent) => void
    onDrop: (e: DragEvent) => void
  }
} {
  const [dragging, setDragging] = useState(false)
  // dragenter/dragleave fire for every child crossed; count them so the overlay doesn't flicker.
  const depth = useRef(0)
  const opts = useRef(o)
  opts.current = o

  // A drag that ends outside the window (Esc, dropped elsewhere) never sends dragleave to us.
  useEffect(() => {
    if (!dragging) return
    const reset = (): void => {
      depth.current = 0
      setDragging(false)
    }
    window.addEventListener('dragend', reset)
    window.addEventListener('drop', reset)
    window.addEventListener('blur', reset)
    track('kit.docListeners', 1)
    return () => {
      window.removeEventListener('dragend', reset)
      window.removeEventListener('drop', reset)
      window.removeEventListener('blur', reset)
      track('kit.docListeners', -1)
    }
  }, [dragging])

  const bind = {
    onDragEnter: useCallback((e: DragEvent) => {
      if (opts.current.disabled || !hasFiles(e)) return
      e.preventDefault()
      depth.current++
      setDragging(true)
    }, []),
    onDragOver: useCallback((e: DragEvent) => {
      if (opts.current.disabled || !hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }, []),
    onDragLeave: useCallback((e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    }, []),
    onDrop: useCallback((e: DragEvent) => {
      if (opts.current.disabled || !hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setDragging(false)
      const { accepted, rejected } = partitionFiles([...e.dataTransfer.files], opts.current)
      opts.current.onFiles(accepted, rejected)
    }, [])
  }
  return { dragging, bind }
}

/** The "Drop to attach" overlay for useFileDrop targets (position the target `relative`). */
export function DropOverlay({ label = 'Drop to attach' }: { label?: string }): ReactNode {
  return (
    <div className="drop-overlay" aria-hidden="true">
      <div className="drop-overlay__inner">
        <Upload />
        <span>{label}</span>
      </div>
    </div>
  )
}

export interface FileDropProps extends UseFileDropOptions {
  label?: ReactNode
  /** Under the label; default lists the limits ("Up to 10 files, 25 MB each"). */
  hint?: ReactNode
  multiple?: boolean
  /** One-line layout for tight spaces. */
  compact?: boolean
  /** Show refusals under the zone (default true). */
  showErrors?: boolean
  className?: string
}

export function FileDrop({
  onFiles,
  accept,
  maxBytes,
  maxFiles,
  multiple = true,
  disabled = false,
  label = 'Drop files here, paste, or browse',
  hint,
  compact = false,
  showErrors = true,
  className
}: FileDropProps): ReactNode {
  const id = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [errors, setErrors] = useState<string[]>([])
  const rules: IntakeRules = { accept, maxBytes, maxFiles: multiple ? maxFiles : 1 }
  const deliver = (accepted: File[], rejected: Rejected<File>[]): void => {
    setErrors(rejected.map((r) => rejectMessage(r, rules)).filter((m, i, a) => a.indexOf(m) === i))
    onFiles(accepted, rejected)
  }
  const { dragging, bind } = useFileDrop({ ...rules, disabled, onFiles: deliver })
  const take = (list: FileList | File[]): void => {
    const { accepted, rejected } = partitionFiles([...list], rules)
    deliver(accepted, rejected)
  }
  const limits = [maxFiles && multiple ? `Up to ${maxFiles} files` : null, maxBytes ? `${formatBytes(maxBytes)} each` : null].filter(Boolean).join(', ')

  return (
    <div className={cx('file-drop-wrap', className)}>
      <div
        className={cx('file-drop', compact && 'file-drop--compact', dragging && 'is-dragging', disabled && 'is-disabled')}
        {...bind}
        onPaste={(e: ClipboardEvent<HTMLDivElement>) => {
          const files = filesFromClipboard(e.clipboardData)
          if (files.length === 0 || disabled) return
          e.preventDefault()
          take(files)
        }}
      >
        <Upload className="file-drop__icon" aria-hidden="true" />
        <div className="file-drop__text">
          <span className="file-drop__label">{label}</span>
          {hint ?? limits ? (
            <span className="file-drop__hint" id={`${id}-hint`}>
              {hint ?? limits}
            </span>
          ) : null}
        </div>
        <button type="button" className="file-drop__browse" disabled={disabled} aria-describedby={hint ?? limits ? `${id}-hint` : undefined} onClick={() => inputRef.current?.click()}>
          Browse…
        </button>
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          onChange={(e) => {
            if (e.target.files) take(e.target.files)
            e.target.value = ''
          }}
        />
      </div>
      {showErrors && errors.length > 0 ? (
        <ul className="file-drop__errors" role="alert">
          {errors.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
