/**
 * `/voice tone off|conversation|reply` (H-v11-tone): Settings → Voice out → "Voice tones" from the composer. Shared by
 * both /voice registrations (the panel's and voice/commands.ts's fallback). The change reaches the AI as a note on the
 * next turn (07 C1), like the switch in Settings.
 */
import type { Settings } from '@shared/settings'
import { TONE_MODE_OPTIONS, toneSupport, type ToneMode } from '@shared/voiceTone'
import type { CommandContext } from '../../lib/commands/registry'
import { toApiError } from '../../lib/errors.logic'

export { parseToneArg, TONE_ARG_SUGGESTIONS } from './toneCommand.logic'

const labelOf = (m: ToneMode): string => TONE_MODE_OPTIONS.find((o) => o.value === m)?.label ?? m

type ToneCmdCtx = Pick<CommandContext, 'api' | 'toast'>

/** Runs `/voice tone …`; `settings` is the store's copy (for the current mode and the voice in use). */
export async function runToneCommand(ctx: ToneCmdCtx, arg: ToneMode | 'show' | 'unknown', settings: Settings | null): Promise<void> {
  const tts = settings?.voice.tts
  if (arg === 'unknown') {
    ctx.toast.warning('Use /voice tone off, /voice tone conversation or /voice tone reply.')
    return
  }
  if (arg === 'show') {
    ctx.toast.info(`Voice tones: ${labelOf(tts?.toneMode ?? 'conversation')}. Change with /voice tone off, conversation or reply.`)
    return
  }
  try {
    await ctx.api('PATCH /api/settings', { body: { voice: { tts: { toneMode: arg } } } })
  } catch (e) {
    ctx.toast.error(toApiError(e).message)
    return
  }
  const support = tts ? toneSupport(tts.provider, tts.model) : { ok: true, text: '' }
  if (arg !== 'off' && !support.ok) ctx.toast.warning(`Voice tones: ${labelOf(arg)}. ${support.text}`)
  else ctx.toast.success(`Voice tones: ${labelOf(arg)}.`)
}
