/**
 * Memory commands (03 §5, 07 A4/C18): /memory on|off|status, /recall <query>, /remember <fact>, /private on|off, plus
 * the prompt-library commands (features/prompts/commands.ts). chat-ui and sessions-ui register their commands first
 * (lib/commands/index.ts imports sessions → chat → memory), so each of ours is registered only if nobody owns the name
 * yet — a duplicate registration would throw at startup.
 */
import { formatShortId } from '@shared/ids'
import { toApiError } from '../../lib/errors.logic'
import { errorText, plural } from './format.logic'
import { statusText } from './MemoryParts.logic'
import { registerIfAbsent } from './registerIfAbsent'
import '../prompts/commands'
import './testHooks'

const onOff = (arg: string): boolean | null => (/^(on|yes|true|1)$/i.test(arg) ? true : /^(off|no|false|0)$/i.test(arg) ? false : null)

registerIfAbsent({
  name: 'memory',
  args: 'on|off|status',
  help: 'Memory for this chat, or its status',
  run: async (ctx) => {
    const arg = ctx.command.argv[0] ?? 'status'
    if (/^status$/i.test(arg)) {
      try {
        const st = await ctx.api('GET /api/memory/status')
        const t = statusText(st)
        let line = `${t.text}. ${plural(st.indexed, 'message')} remembered`
        if (st.queued) line += `, ${plural(st.queued, 'message')} waiting`
        if (ctx.sessionUid) {
          const s = await ctx.api('GET /api/sessions/:uid', { params: { uid: ctx.sessionUid } })
          line += `. This chat: memory ${s.memory === 'inherit' ? 'as in Settings' : s.memory}${s.private ? ', private' : ''}, scope ${s.memoryScope === 'inherit' ? 'default' : s.memoryScope}.`
        }
        ctx.toast.info(line, { title: 'Memory', action: { label: 'Open', onClick: () => ctx.navigate('/memory') } })
      } catch (e) {
        ctx.toast.error(toApiError(e).message)
      }
      return
    }
    const on = onOff(arg)
    if (on === null || !ctx.sessionUid) {
      ctx.toast.info(ctx.sessionUid ? 'Usage: /memory on, /memory off or /memory status' : 'Open a chat first, or use /memory status.')
      return
    }
    try {
      await ctx.api('PATCH /api/sessions/:uid', { params: { uid: ctx.sessionUid }, body: { memory: on ? 'on' : 'off' } })
      ctx.toast.success(on ? 'Memory is on for this chat.' : 'Memory is off for this chat: it won’t recall or be recalled.')
    } catch (e) {
      ctx.toast.error(toApiError(e).message)
    }
  }
})

registerIfAbsent({
  name: 'recall',
  args: '<query>',
  help: 'Search this chat’s memory yourself',
  available: (ctx) => ctx.sessionUid !== null,
  run: async (ctx) => {
    const q = ctx.command.args
    if (!q || !ctx.sessionUid) {
      ctx.toast.info('Usage: /recall <what to look for>')
      return
    }
    try {
      const hits = await ctx.api('POST /api/memory/recall', { body: { query: q, sessionUid: ctx.sessionUid } })
      const top = hits[0]
      const where = `/memory?q=${encodeURIComponent(q)}`
      if (!top) ctx.toast.info(`Nothing remembered about “${q}”.`, { action: { label: 'Search all', onClick: () => ctx.navigate(where) } })
      else
        ctx.toast.info(
          `${plural(hits.length, 'memory', 'memories')} found. Best: “${top.body.slice(0, 140)}${top.body.length > 140 ? '…' : ''}” (${formatShortId(top.shortId)})`,
          {
            title: 'Recall',
            durationMs: 10_000,
            action: { label: 'Show all', onClick: () => ctx.navigate(where) }
          }
        )
    } catch (e) {
      ctx.toast.error(toApiError(e).message)
    }
  }
})

registerIfAbsent({
  name: 'remember',
  args: '<fact>',
  help: 'Pin a fact the AI always keeps in mind',
  run: async (ctx) => {
    const text = ctx.command.args
    if (!text) {
      ctx.toast.info('Usage: /remember <a fact about you>')
      return
    }
    try {
      await ctx.api('POST /api/facts', { body: { text } })
      ctx.toast.success('Pinned to “About you”.', { action: { label: 'See all', onClick: () => ctx.navigate('/memory/about') } })
    } catch (e) {
      ctx.toast.error(errorText(toApiError(e)))
    }
  }
})

registerIfAbsent({
  name: 'private',
  args: 'on|off',
  help: 'Keep this chat out of other chats’ memory and away from Voyage',
  available: (ctx) => ctx.sessionUid !== null,
  run: async (ctx) => {
    const on = onOff(ctx.command.argv[0] ?? 'on')
    if (on === null || !ctx.sessionUid) {
      ctx.toast.info('Usage: /private on or /private off')
      return
    }
    try {
      await ctx.api('PATCH /api/sessions/:uid', { params: { uid: ctx.sessionUid }, body: { private: on } })
      ctx.toast.success(
        on
          ? 'This chat is private: never sent to Voyage, never recalled elsewhere. Text sent to Voyage before stays with Voyage.'
          : 'This chat is no longer private.'
      )
    } catch (e) {
      ctx.toast.error(toApiError(e).message)
    }
  }
})
