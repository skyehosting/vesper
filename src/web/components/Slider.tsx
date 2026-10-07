/**
 * Slider (04 "Slider (with value)") — `role="slider"` on the thumb with the APG keys (arrows ±step, PageUp/PageDown
 * ±large step, Home/End), pointer drag anywhere on the track, and a value bubble while dragging/focused (or always).
 * `format` drives both the bubble and `aria-valuetext`, so "1.2 s" is what screen readers hear too.
 *
 *   <Slider label="Silence before sending" min={300} max={5000} step={100} value={ms} onChange={setMs}
 *     format={formatSeconds} marks={[{ value: 1200, label: 'Default' }]} />          // 07 C17
 *
 * `onChange` fires continuously; `onCommit` once per gesture (pointer up, or each key press) — persist there.
 */
import { useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type Ref } from 'react'
import { cx } from './internal/cx'
import { keyValue, ratioOf, snap, valueAtRatio, type SliderRange } from './internal/slider.logic'
import './Slider.css'

export interface SliderMark {
  value: number
  label?: string
}

export interface SliderProps {
  value: number
  onChange: (value: number) => void
  onCommit?: (value: number) => void
  min: number
  max: number
  step?: number
  largeStep?: number
  label?: ReactNode
  'aria-label'?: string
  hint?: ReactNode
  /** Bubble text and aria-valuetext. */
  format?: (value: number) => string
  /** 'active' (default): while dragging or keyboard-focused. */
  bubble?: 'active' | 'always' | 'never'
  /** Show the formatted value at the end of the label row. */
  showValue?: boolean
  marks?: readonly SliderMark[]
  disabled?: boolean
  id?: string
  className?: string
  ref?: Ref<HTMLDivElement>
}

export function Slider({
  value,
  onChange,
  onCommit,
  min,
  max,
  step = 1,
  largeStep,
  label,
  'aria-label': ariaLabel,
  hint,
  format = String,
  bubble = 'active',
  showValue = true,
  marks,
  disabled = false,
  id,
  className,
  ref
}: SliderProps): ReactNode {
  const auto = useId()
  const sid = id ?? `sl${auto}`
  const range: SliderRange = { min, max, step, largeStep }
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const latest = useRef(value)
  latest.current = value
  const v = snap(value, range)
  const pct = ratioOf(v, range) * 100
  const text = format(v)

  const fromPointer = (clientX: number): number => {
    const r = trackRef.current?.getBoundingClientRect()
    if (!r || r.width === 0) return v
    return valueAtRatio((clientX - r.left) / r.width, range)
  }
  const set = (next: number): void => {
    if (next !== latest.current) {
      latest.current = next
      onChange(next)
    }
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (disabled || e.button !== 0) return
    e.preventDefault()
    const thumb = e.currentTarget.querySelector<HTMLElement>('[role="slider"]')
    thumb?.focus({ preventScroll: true })
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
    set(fromPointer(e.clientX))
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    set(fromPointer(e.clientX))
  }
  const endDrag = (e: PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    setDragging(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    onCommit?.(latest.current)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return
    const next = keyValue(v, e.key, range)
    if (next === null) return
    e.preventDefault()
    set(next)
    onCommit?.(next)
  }

  return (
    <div className={cx('slider', disabled && 'is-disabled', bubble === 'always' && 'slider--bubble-always', dragging && 'is-dragging', className)}>
      {label !== undefined || (showValue && bubble !== 'always') ? (
        <div className="slider__head">
          {label !== undefined ? (
            <span className="slider__label" id={`${sid}-label`}>
              {label}
            </span>
          ) : (
            <span />
          )}
          {showValue ? (
            <output className="slider__value" htmlFor={sid} aria-hidden="true">
              {text}
            </output>
          ) : null}
        </div>
      ) : null}
      <div
        ref={trackRef}
        className="slider__track-area"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={() => dragging && setDragging(false)}
      >
        <div className="slider__track" />
        <div className="slider__fill" style={{ width: `calc(${pct}% + var(--thumb) / 2)` }} />
        {marks?.map((m) => (
          <span key={m.value} className="slider__tick" style={{ left: `${ratioOf(m.value, range) * 100}%` }} aria-hidden="true" />
        ))}
        <div
          ref={ref}
          id={sid}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={v}
          aria-valuetext={text}
          aria-labelledby={label !== undefined ? `${sid}-label` : undefined}
          aria-label={label === undefined ? ariaLabel : undefined}
          aria-describedby={hint ? `${sid}-hint` : undefined}
          aria-disabled={disabled || undefined}
          aria-orientation="horizontal"
          className="slider__thumb"
          style={{ left: `${pct}%` }}
          onKeyDown={onKeyDown}
        >
          {bubble !== 'never' ? (
            <span className="slider__bubble" aria-hidden="true">
              {text}
            </span>
          ) : null}
        </div>
      </div>
      {marks?.some((m) => m.label) ? (
        <div className="slider__marks" aria-hidden="true">
          {marks.map((m) =>
            m.label ? (
              <span key={m.value} className="slider__mark" style={{ left: `${ratioOf(m.value, range) * 100}%` }}>
                {m.label}
              </span>
            ) : null
          )}
        </div>
      ) : null}
      {hint ? (
        <p className="slider__hint" id={`${sid}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  )
}
