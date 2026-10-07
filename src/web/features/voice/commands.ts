/**
 * Voice commands (03 §5): `/voice on|off` — speak replies on this device (the top-bar toggle); `/voice <name>` — use
 * that voice for this session (a per-session override); `/voice default` — back to the Settings voice;
 * `/voice tone off|conversation|reply` — the voice tones (H-v11-tone).
 */
import { commands, registerCommand } from '../../lib/commands/registry'
import { toApiError } from '../../lib/errors.logic'
import { useStore } from '../../lib/store'
import { parseToneArg, runToneCommand } from './toneCommand'
import { matchVoice } from './voices.logic'

// sessions-ui's panel registers /voice first (with argument completion, same per-device switch via speakReplies.ts);
// this definition only applies when that one is absent — a duplicate registration would throw at startup.
if (!commands.get('voice')) registerCommand({
  name: 'voice',
  args: 'on|off|default|<voice name>|tone off|conversation|reply',
  help: 'Speak replies on this device, pick the voice for this chat, or set the voice tones',
  run: async (ctx) => {
    const arg = ctx.command.args.trim()
    const s = useStore.getState()
    const tts = s.settings?.voice.tts
    const lower = arg.toLowerCase()
    const tone = parseToneArg(arg)
    if (tone) {
      await runToneCommand(ctx, tone, s.settings)
      return
    }
    if (lower === 'on' || lower === 'off' || arg === '') {
      const on = lower === 'on' || (arg === '' && !s.voice.autoSpeak)
      // Loaded on demand: the speech client (audio core) stays out of the startup bundle.
      const { setAutoSpeak } = await import('./speechClient')
      setAutoSpeak(on)
      if (on && !tts?.enabled) ctx.toast.info('Replies will be spoken once a voice is set up in Settings → Voice out.')
      else ctx.toast.success(on ? 'Replies will be spoken on this device.' : 'Voice replies are off on this device.')
      return
    }
    if (!ctx.sessionUid) {
      ctx.toast.info('Open a chat to choose its voice.')
      return
    }
    if (lower === 'default') {
      await ctx.api('PATCH /api/sessions/:uid', { params: { uid: ctx.sessionUid }, body: { voice: null } })
      ctx.toast.success('This chat uses the voice from Settings again.')
      return
    }
    const provider = tts?.provider ?? 'windows'
    try {
      const list = await ctx.api('GET /api/tts/voices', { query: { provider } })
      const v = matchVoice(list.voices, arg)
      if (!v) {
        ctx.toast.warning(`No voice called "${arg}". Try one of: ${list.voices.slice(0, 5).map((x) => x.name).join(', ') || 'none available'}.`)
        return
      }
      await ctx.api('PATCH /api/sessions/:uid', { params: { uid: ctx.sessionUid }, body: { voice: { provider, voiceId: v.id } } })
      ctx.toast.success(`This chat now speaks with ${v.name}.`)
    } catch (e) {
      ctx.toast.error(toApiError(e).message)
    }
  }
})
