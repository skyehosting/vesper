/**
 * TextArea (04 "Textarea (auto-grow)") — grows with its content between `minRows` and `maxRows`, then scrolls.
 * Works controlled or uncontrolled; re-measures when its width changes (wrapping changes the height).
 *
 *   <TextArea label="System prompt" minRows={4} maxRows={16} value={v} onChange={(e) => setV(e.target.value)} />
 */
import { useCallback, useLayoutEffect, useRef, type ReactNode, type Ref, type TextareaHTMLAttributes } from 'react'
import { Field } from './Field'
import { cx } from './internal/cx'
import { track } from './internal/stats'

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode
  labelHidden?: boolean
  labelExtra?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  /** Grow with the content (default true). */
  autoGrow?: boolean
  minRows?: number
  maxRows?: number
  /** Show "n / maxLength" under the field. */
  showCount?: boolean
  mono?: boolean
  wrapClassName?: string
  ref?: Ref<HTMLTextAreaElement>
}

export function TextArea({
  label,
  labelHidden,
  labelExtra,
  hint,
  error,
  autoGrow = true,
  minRows = 3,
  maxRows = 12,
  showCount = false,
  mono = false,
  wrapClassName,
  className,
  id,
  required,
  disabled,
  readOnly,
  value,
  defaultValue,
  maxLength,
  onInput,
  ref,
  ...rest
}: TextAreaProps): ReactNode {
  const inner = useRef<HTMLTextAreaElement | null>(null)
  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      inner.current = el
      if (typeof ref === 'function') ref(el)
      else if (ref) ref.current = el
    },
    [ref]
  )

  const resize = useCallback(() => {
    const el = inner.current
    if (!el || !autoGrow) return
    const cs = getComputedStyle(el)
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
    const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
    const min = minRows * lh + pad + border
    const max = maxRows * lh + pad + border
    el.style.height = 'auto'
    const want = el.scrollHeight + border
    el.style.height = `${Math.min(max, Math.max(min, want))}px`
    el.style.overflowY = want > max ? 'auto' : 'hidden'
  }, [autoGrow, minRows, maxRows])

  useLayoutEffect(resize, [resize, value])

  // Width changes re-wrap the text; at most one measurement per frame.
  useLayoutEffect(() => {
    const el = inner.current
    if (!el || !autoGrow) return
    let frame = 0
    let lastWidth = el.clientWidth
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth || frame) return
      lastWidth = el.clientWidth
      frame = requestAnimationFrame(() => {
        frame = 0
        resize()
      })
    })
    ro.observe(el)
    track('kit.observers', 1)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      ro.disconnect()
      track('kit.observers', -1)
    }
  }, [autoGrow, resize])

  const length = typeof value === 'string' ? value.length : null

  return (
    <Field label={label} labelHidden={labelHidden} labelExtra={labelExtra} hint={hint} error={error} required={required} id={id} className={wrapClassName}>
      {(f) => (
        <>
          <textarea
            ref={setRef}
            id={f.id}
            className={cx('textarea', mono && 'mono', className)}
            rows={autoGrow ? minRows : rest.rows ?? minRows}
            required={required}
            disabled={disabled}
            readOnly={readOnly}
            value={value}
            defaultValue={defaultValue}
            maxLength={maxLength}
            onInput={(e) => {
              if (value === undefined) resize()
              onInput?.(e)
            }}
            {...f.aria}
            {...rest}
          />
          {showCount && maxLength && length !== null ? (
            <span className={cx('field-count', length >= maxLength && 'is-over')}>
              {length} / {maxLength}
            </span>
          ) : null}
        </>
      )}
    </Field>
  )
}
