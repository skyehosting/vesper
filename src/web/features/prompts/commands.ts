/**
 * Prompt-library commands (R11, 03 §5). `/prompts` opens the library (memory-ui owns it). `/prompt <text> | use <name>
 * | save <name> | clear` belongs to the session panel's owner; it is registered here only when nobody registered
 * `/prompt` before us (see features/memory/commands.ts `registerIfAbsent`), so the command works either way.
 */
import { toApiError } from '../../lib/errors.logic'
import { errorText } from '../memory/format.logic'
import { registerIfAbsent } from '../memory/registerIfAbsent'
import { applyPromptToSession, clearSessionPrompt, findPrompt, promptsLive, savePrompt } from './library'

registerIfAbsent({
  name: 'prompts',
  help: 'Open the prompt library',
  run: (ctx) => ctx.navigate('/prompts')
})

registerIfAbsent({
  name: 'prompt',
  args: '<text> | use <name> | save <name> | clear',
  help: 'This chat’s system prompt, or the prompt library',
  available: (ctx) => ctx.sessionUid !== null,
  run: async (ctx) => {
    const uid = ctx.sessionUid
    if (!uid) return
    const [sub, ...rest] = ctx.command.argv
    const name = rest.join(' ').trim()
    try {
      if (!sub) {
        const s = await ctx.api('GET /api/sessions/:uid', { params: { uid } })
        ctx.toast.info(
          s.systemPrompt
            ? `“${s.systemPrompt.slice(0, 200)}${s.systemPrompt.length > 200 ? '…' : ''}”`
            : 'This chat has no system prompt. Try /prompt <text> or /prompt use <name>.',
          {
            title: 'System prompt',
            action: { label: 'Library', onClick: () => ctx.navigate('/prompts') }
          }
        )
        return
      }
      if (/^clear$/i.test(sub) && rest.length === 0) {
        await clearSessionPrompt(uid)
        ctx.toast.success('System prompt cleared for this chat.')
        return
      }
      if (/^use$/i.test(sub)) {
        const list = promptsLive.get().data ?? (await ctx.api('GET /api/prompts'))
        const p = name ? findPrompt(list, name) : undefined
        if (!p) {
          ctx.toast.info(name ? `No saved prompt called “${name}”.` : 'Usage: /prompt use <name>', {
            action: { label: 'Library', onClick: () => ctx.navigate('/prompts') }
          })
          return
        }
        await applyPromptToSession(uid, p)
        ctx.toast.success(`This chat now uses “${p.name}”.`)
        return
      }
      if (/^save$/i.test(sub)) {
        if (!name) {
          ctx.toast.info('Usage: /prompt save <name>')
          return
        }
        const s = await ctx.api('GET /api/sessions/:uid', { params: { uid } })
        if (!s.systemPrompt.trim()) {
          ctx.toast.info('This chat has no system prompt to save yet.')
          return
        }
        const p = await savePrompt(name, s.systemPrompt)
        ctx.toast.success(`Saved to the library as “${p.name}”.`, { action: { label: 'Open', onClick: () => ctx.navigate(`/prompts?id=${p.id}`) } })
        return
      }
      // Anything else is the prompt text itself.
      await ctx.api('PATCH /api/sessions/:uid', { params: { uid }, body: { systemPrompt: ctx.command.args, promptId: null } })
      ctx.toast.success('System prompt set for this chat.')
    } catch (e) {
      ctx.toast.error(errorText(toApiError(e)))
    }
  }
})
