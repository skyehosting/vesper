/**
 * The session panel's commands (03 §5): /prompt, /private, /memory, /model, /voice (also `/voice tone …`) — each changes this chat the same
 * way the panel does (and the change reaches the AI as a note, 07 C1). Argument completion offers the sub-commands,
 * prompt names, models and voices.
 */
import type { Session } from '@shared/types/domain'
import type { ArgSuggestion } from '../../lib/commands/registry.logic'
import { registerCommand, type CommandContext } from '../../lib/commands/registry'
import { toApiError } from '../../lib/errors.logic'
import { useStore } from '../../lib/store'
import { getModels, getPrompts, getVoices, invalidatePrompts } from '../sessions/cache'
import { memoryChip, modelChip } from '../sessions/chips.logic'
import { trySession } from '../sessions/data'
import { setSpeakReplies, voiceAvailable } from '../sessions/speakReplies'
import { parseToneArg, runToneCommand, TONE_ARG_SUGGESTIONS } from '../voice/toneCommand'

const needsChat = (ctx: CommandContext): boolean => ctx.sessionUid !== null

/** The open chat's detail, fetched when the store doesn't have it yet. */
async function sessionOf(ctx: CommandContext): Promise<Session | null> {
  if (!ctx.sessionUid) return null
  const a = useStore.getState().activeSession
  if (a?.uid === ctx.sessionUid) return a
  try {
    return await ctx.api('GET /api/sessions/:uid', { params: { uid: ctx.sessionUid } })
  } catch (e) {
    ctx.toast.error(toApiError(e).message)
    return null
  }
}

function pick(prefix: string, choices: readonly { insert: string; label: string; description?: string; final?: boolean }[]): ArgSuggestion[] {
  const p = prefix.trim().toLowerCase()
  return choices.filter((c) => !p || c.insert.toLowerCase().startsWith(p) || c.label.toLowerCase().includes(p))
}

const unquote = (s: string): string => s.trim().replace(/^"(.*)"$/s, '$1').trim()

registerCommand({
  name: 'prompt',
  args: '<text> | use <name> | save <name> | clear',
  help: "Set this chat's system prompt (or use, save, clear)",
  available: needsChat,
  run: async (ctx) => {
    const uid = ctx.sessionUid
    if (!uid) return
    const args = ctx.command.args
    const [sub = '', ...restWords] = ctx.command.argv
    const rest = unquote(args.replace(/^\S+\s*/, ''))
    const st = useStore.getState()
    switch (sub.toLowerCase()) {
      case '':
        st.setPanelOpen(true, 'prompt')
        return
      case 'clear':
        if (restWords.length === 0) {
          await trySession(uid, { systemPrompt: '', promptId: null }, 'System prompt cleared')
          return
        }
        break
      case 'use': {
        if (!rest) {
          ctx.toast.info('/prompt use <name> — pick a prompt from the library', { title: 'How to use it' })
          return
        }
        try {
          const prompts = await getPrompts(true)
          const p = prompts.find((x) => x.name.toLowerCase() === rest.toLowerCase()) ?? prompts.find((x) => x.name.toLowerCase().startsWith(rest.toLowerCase()))
          if (!p) {
            ctx.toast.error(`No prompt named “${rest}” in the library.`)
            return
          }
          await trySession(uid, { systemPrompt: p.body, promptId: p.id }, `Using “${p.name}”`)
        } catch (e) {
          ctx.toast.error(toApiError(e).message)
        }
        return
      }
      case 'save': {
        const s = await sessionOf(ctx)
        if (!s) return
        if (!rest) {
          ctx.toast.info('/prompt save <name> — saves this chat’s prompt to the library', { title: 'How to use it' })
          return
        }
        if (!s.systemPrompt) {
          ctx.toast.info('This chat has no system prompt to save yet.')
          return
        }
        try {
          const p = await ctx.api('POST /api/prompts', { body: { name: rest.slice(0, 80), body: s.systemPrompt } })
          invalidatePrompts()
          await trySession(uid, { promptId: p.id })
          ctx.toast.success(`Saved “${p.name}” to the library`)
        } catch (e) {
          ctx.toast.error(toApiError(e).message)
        }
        return
      }
    }
    // Anything else is the prompt text itself.
    await trySession(uid, { systemPrompt: args, promptId: null }, 'System prompt set for this chat')
  },
  completeArgs: async (_ctx, args) => {
    const m = /^(use|save)\s+(.*)$/is.exec(args)
    if (m && m[1].toLowerCase() === 'use') {
      try {
        const q = m[2].trim().toLowerCase()
        return (await getPrompts())
          .filter((p) => !q || p.name.toLowerCase().includes(q))
          .slice(0, 10)
          .map((p) => ({ insert: `use ${p.name}`, label: p.name, description: p.body.slice(0, 80), final: true }))
      } catch {
        return []
      }
    }
    if (m) return []
    if (args.includes(' ')) return []
    return pick(args, [
      { insert: 'use ', label: 'use <name> — a prompt from the library' },
      { insert: 'save ', label: 'save <name> — save this prompt to the library' },
      { insert: 'clear', label: 'clear — remove this chat’s prompt', final: true }
    ])
  }
})

registerCommand({
  name: 'private',
  args: 'on|off',
  help: 'Make this chat private (never sent to Voyage, never recalled elsewhere)',
  available: needsChat,
  run: async (ctx) => {
    const uid = ctx.sessionUid
    if (!uid) return
    const v = ctx.command.argv[0]?.toLowerCase()
    if (v !== 'on' && v !== 'off') {
      const s = await sessionOf(ctx)
      if (s) ctx.toast.info(s.private ? 'This chat is private. /private off to change it.' : 'This chat is not private. /private on to change it.')
      return
    }
    await trySession(uid, { private: v === 'on' }, v === 'on' ? 'This chat is private now' : 'This chat is no longer private')
  },
  completeArgs: (_ctx, args) =>
    pick(args, [
      { insert: 'on', label: 'on — keep this chat out of Voyage AI and other chats’ memory', final: true },
      { insert: 'off', label: 'off — a normal chat again', final: true }
    ])
})

registerCommand({
  name: 'memory',
  args: 'on|off|default|status',
  help: 'Memory for this chat',
  available: needsChat,
  run: async (ctx) => {
    const uid = ctx.sessionUid
    if (!uid) return
    const v = ctx.command.argv[0]?.toLowerCase() ?? 'status'
    if (v === 'on' || v === 'off') {
      await trySession(uid, { memory: v }, v === 'on' ? 'Memory on for this chat' : 'Memory off for this chat')
      return
    }
    if (v === 'default' || v === 'inherit') {
      await trySession(uid, { memory: 'inherit' }, 'This chat follows the memory setting again')
      return
    }
    const s = await sessionOf(ctx)
    if (!s) return
    const st = useStore.getState()
    const chip = memoryChip(st.settings?.memory.enabled ?? false, s.memory, st.ui.memoryStatus?.state ?? null, s.private)
    const status = st.ui.memoryStatus
    const extra = status && chip.on ? ` ${status.indexed.toLocaleString('en-US')} messages indexed${status.queued ? `, ${status.queued.toLocaleString('en-US')} waiting` : ''}.` : ''
    ctx.toast.info(`${chip.detail}${extra}`, { title: chip.label, action: { label: 'Open', onClick: () => useStore.getState().setPanelOpen(true, 'memory') } })
  },
  completeArgs: (_ctx, args) =>
    pick(args, [
      { insert: 'on', label: 'on — the AI may recall memories in this chat', final: true },
      { insert: 'off', label: 'off — no memory in this chat', final: true },
      { insert: 'default', label: 'default — follow Settings → Memory', final: true },
      { insert: 'status', label: 'status — what memory is doing', final: true }
    ])
})

registerCommand({
  name: 'model',
  args: '<id>|default',
  help: 'Use another model in this chat',
  available: needsChat,
  run: async (ctx) => {
    const uid = ctx.sessionUid
    if (!uid) return
    const id = ctx.command.args.trim()
    if (!id) {
      useStore.getState().setPanelOpen(true, 'voice')
      return
    }
    if (id.toLowerCase() === 'default') {
      await trySession(uid, { model: null }, 'Using the default model')
      return
    }
    await trySession(uid, { model: id.slice(0, 200) }, `Model: ${id}`)
  },
  completeArgs: async (ctx, args) => {
    const st = useStore.getState()
    const info = modelChip(st.settings, st.activeSession?.uid === ctx.sessionUid ? st.activeSession : null)
    if (!info.profileId) return []
    try {
      const models = await getModels(info.profileId)
      return pick(args, [{ insert: 'default', label: 'default — the provider’s default model', final: true }, ...models.map((m) => ({ insert: m.id, label: m.id, description: m.label, final: true }))]).slice(0, 12)
    } catch {
      return []
    }
  }
})

registerCommand({
  name: 'voice',
  args: 'on|off|<voice name>|default|tone off|conversation|reply',
  help: 'Voice replies on or off, pick a voice for this chat, or set the voice tones',
  run: async (ctx) => {
    const arg = ctx.command.args.trim()
    const st = useStore.getState()
    const lower = arg.toLowerCase()
    // H-v11-tone: `/voice tone off|conversation|reply` — Settings → Voice out → "Voice tones".
    const tone = parseToneArg(arg)
    if (tone) {
      await runToneCommand(ctx, tone, st.settings)
      return
    }
    if (lower === 'on' || lower === 'off' || arg === '') {
      if (!voiceAvailable(st.settings)) {
        ctx.toast.info('Voice replies need a voice provider.', { action: { label: 'Set up voice', onClick: () => ctx.navigate('/settings/voice-out') } })
        return
      }
      const on = arg === '' ? true : lower === 'on'
      setSpeakReplies(on)
      ctx.toast.info(on ? 'Replies will be spoken on this device.' : 'Replies will be text only on this device.', { id: 'voice-toggle', durationMs: 2500 })
      return
    }
    const uid = ctx.sessionUid
    if (!uid) {
      ctx.toast.info('Open a chat to choose its voice.')
      return
    }
    if (lower === 'default') {
      await trySession(uid, { voice: null }, 'Using the default voice')
      return
    }
    const provider = st.settings?.voice.tts.provider ?? 'windows'
    try {
      const voices = await getVoices(provider)
      const v = voices.find((x) => x.name.toLowerCase() === lower) ?? voices.find((x) => x.name.toLowerCase().startsWith(lower)) ?? voices.find((x) => x.id === arg)
      if (!v) {
        ctx.toast.error(`No voice called “${arg}”.`)
        return
      }
      await trySession(uid, { voice: { provider, voiceId: v.id } }, `Voice for this chat: ${v.name}`)
    } catch (e) {
      ctx.toast.error(toApiError(e).message)
    }
  },
  completeArgs: async (_ctx, args) => {
    const base = [
      { insert: 'on', label: 'on — speak replies on this device', final: true },
      { insert: 'off', label: 'off — text only on this device', final: true },
      { insert: 'default', label: 'default — this chat uses the default voice', final: true },
      ...TONE_ARG_SUGGESTIONS
    ]
    const st = useStore.getState()
    if (!voiceAvailable(st.settings)) return pick(args, base)
    try {
      const voices = await getVoices(st.settings?.voice.tts.provider ?? 'windows')
      return pick(args, [...base, ...voices.map((v) => ({ insert: v.name, label: v.name, description: [v.category, v.language].filter(Boolean).join(' · ') || undefined, final: true }))]).slice(0, 12)
    } catch {
      return pick(args, base)
    }
  }
})
