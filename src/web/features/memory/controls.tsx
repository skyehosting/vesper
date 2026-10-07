/**
 * Settings-bound controls: a Slider that moves locally while dragged and saves once on release, and a text field that
 * saves on blur/Enter. Both resync when the setting changes elsewhere (another device, the server's clamp).
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Slider } from '../../components/Slider'
import { TextField } from '../../components/TextField'

export function SettingSlider({
  value,
  onSave,
  min,
  max,
  step = 1,
  label,
  hint,
  format,
  disabled
}: {
  value: number
  onSave: (v: number) => void | Promise<unknown>
  min: number
  max: number
  step?: number
  label: ReactNode
  hint?: ReactNode
  format?: (v: number) => string
  disabled?: boolean
}): ReactNode {
  const [local, setLocal] = useState(value)
  useEffect(() => setLocal(value), [value])
  return (
    <Slider
      label={label}
      hint={hint}
      value={local}
      min={min}
      max={max}
      step={step}
      format={format}
      disabled={disabled}
      onChange={setLocal}
      onCommit={(v) => {
        if (v !== value) void onSave(v)
      }}
    />
  )
}

export function SettingText({
  value,
  onSave,
  label,
  hint,
  placeholder,
  disabled,
  validate,
  mono = false
}: {
  value: string
  onSave: (v: string) => void | Promise<unknown>
  label: ReactNode
  hint?: ReactNode
  placeholder?: string
  disabled?: boolean
  validate?: (v: string) => string | null
  mono?: boolean
}): ReactNode {
  const [local, setLocal] = useState(value)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setLocal(value), [value])
  const commit = (): void => {
    const v = local.trim()
    if (v === value) return
    const problem = validate?.(v) ?? null
    setError(problem)
    if (!problem) void onSave(v)
  }
  return (
    <TextField
      label={label}
      hint={hint}
      error={error ?? undefined}
      value={local}
      placeholder={placeholder}
      disabled={disabled}
      className={mono ? 'mono' : undefined}
      spellCheck={false}
      onChange={(e) => {
        setLocal(e.target.value)
        if (error) setError(null)
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
    />
  )
}
