/** The AI service choice (wizard step 1, "Add provider"): every preset as a card; local apps and Custom marked. */
import type { ReactNode } from 'react'
import { PRESETS } from '@shared/presets'
import type { PresetId } from '@shared/settings'
import { RadioGroup } from '../../../components/RadioGroup'
// Building blocks carry their styles: the wizard uses them without the Settings shell.
import '../settings.css'

const BLURB: Record<PresetId, string> = {
  openai: 'GPT models',
  anthropic: 'Claude models',
  gemini: 'Gemini models',
  openrouter: 'Many models, one key',
  groq: 'Fast open models',
  mistral: 'European models',
  xai: 'Grok models',
  deepseek: 'DeepSeek models',
  together: 'Open models, cloud',
  ollama: 'On this PC · no key',
  lmstudio: 'On this PC · no key',
  custom: 'Any compatible address'
}

/** Two-letter marks (no logos: these are other companies' trademarks). */
export const MONOGRAM: Record<PresetId, string> = {
  openai: 'OA',
  anthropic: 'An',
  gemini: 'Ge',
  openrouter: 'OR',
  groq: 'Gq',
  mistral: 'Mi',
  xai: 'xA',
  deepseek: 'DS',
  together: 'To',
  ollama: 'Ol',
  lmstudio: 'LM',
  custom: '⋯'
}

export function Monogram({ id }: { id: PresetId }): ReactNode {
  return <span className={`monogram monogram--${id}${id === 'ollama' || id === 'lmstudio' ? ' monogram--local' : ''}`}>{MONOGRAM[id]}</span>
}

export function PresetPicker({ value, onChange, label = 'AI service', columns = 3 }: { value: PresetId | null; onChange(id: PresetId): void; label?: ReactNode; columns?: 1 | 2 | 3 }): ReactNode {
  return (
    <RadioGroup<PresetId>
      className="preset-picker"
      label={label}
      variant="cards"
      columns={columns}
      value={value}
      onChange={onChange}
      options={PRESETS.map((p) => ({
        value: p.id,
        label: p.label.replace(/\s*\(.*\)$/, ''),
        description: BLURB[p.id],
        icon: <Monogram id={p.id} />
      }))}
    />
  )
}
