/**
 * Session commands (03 §5, 01 "Commands"): /new, /temp, /continue, /link, /unlink, /links, /title, /id — with
 * argument completion (session titles and #IDs). The panel's commands (/prompt, /private, /memory, /model, /voice)
 * register from panel/commands.ts, imported here so the fixed module list in lib/commands/index.ts stays unchanged.
 */
import { formatShortId, normalizeShortId } from '@shared/ids'
import type { SessionSummary } from '@shared/types/domain'
import type { ArgSuggestion } from '../../lib/commands/registry.logic'
import { registerCommand, type CommandContext } from '../../lib/commands/registry'
import { useStore } from '../../lib/store'
import { api } from '../../lib/api'
import { activityOf } from './group.logic'
import { continueSession, copySessionId, linkSession, renameSession, resolveSessionRef, startNewChat, startTemporaryChat, unlinkSession } from './data'
import { titleOf } from './group.logic'
import '../panel/commands'

const needsChat = (ctx: CommandContext): boolean => ctx.sessionUid !== null

function usage(ctx: CommandContext, text: string): void {
  ctx.toast.info(text, { title: 'How to use it' })
}

/** Sessions matching what was typed after the command (title words or a #ID), most recent first. */
export async function sessionSuggestions(args: string, exclude: ReadonlySet<string>, signal?: AbortSignal): Promise<ArgSuggestion[]> {
  const q = args.trim().replace(/^#/, '')
  const local = useStore.getState().sessions.items
  let pool: SessionSummary[] = local
  if (q.length >= 2) {
    try {
      const r = await api('GET /api/sessions', { query: { q, limit: 20 }, signal })
      const seen = new Set(r.items.map((s) => s.uid))
      pool = [...r.items, ...local.filter((s) => !seen.has(s.uid))]
    } catch {
      pool = local
    }
  }
  const ql = q.toLowerCase()
  return pool
    .filter((s) => !exclude.has(s.uid) && !s.temporary)
    .filter((s) => !ql || s.shortId.toLowerCase().startsWith(ql) || titleOf(s).toLowerCase().includes(ql))
    .sort((a, b) => activityOf(b) - activityOf(a))
    .slice(0, 8)
    .map((s) => ({ insert: formatShortId(s.shortId), label: titleOf(s), description: [formatShortId(s.shortId), s.summary].filter(Boolean).join(' · '), final: true }))
}

function currentExclusions(ctx: CommandContext, withLinks: boolean): Set<string> {
  const out = new Set<string>()
  if (ctx.sessionUid) out.add(ctx.sessionUid)
  const a = useStore.getState().activeSession
  if (withLinks && a && a.uid === ctx.sessionUid) for (const l of a.links) out.add(l.uid)
  return out
}

registerCommand({
  name: 'new',
  args: '[title]',
  help: 'Start a new chat',
  run: async (ctx) => {
    await startNewChat(ctx.command.args ? { title: ctx.command.args.slice(0, 200) } : {})
  }
})

registerCommand({
  name: 'temp',
  help: 'Start a temporary chat (not saved or remembered)',
  run: async () => {
    await startTemporaryChat()
  }
})

registerCommand({
  name: 'continue',
  args: '<#id>',
  help: 'Continue a chat in a new one, opened with a recap',
  run: async (ctx) => {
    const ref = ctx.command.argv[0]
    if (!ref) {
      if (ctx.sessionUid) await continueSession(ctx.sessionUid)
      else usage(ctx, '/continue #K7Q2MX — continue that chat in a new one')
      return
    }
    const target = await resolveSessionRef(ref, normalizeShortId)
    if (!target) {
      ctx.toast.error(`No chat ${ref.startsWith('#') ? ref : `#${ref}`}.`)
      return
    }
    await continueSession(target.uid)
  },
  completeArgs: (ctx, args, signal) => sessionSuggestions(args, currentExclusions(ctx, false), signal)
})

registerCommand({
  name: 'link',
  args: '<#id> [both]',
  help: 'Let the AI in this chat recall another chat',
  available: needsChat,
  run: async (ctx) => {
    const [ref, mode] = ctx.command.argv
    if (!ctx.sessionUid || !ref) {
      usage(ctx, '/link #K7Q2MX — this chat may recall #K7Q2MX. Add “both” to link both ways.')
      return
    }
    const target = await resolveSessionRef(ref, normalizeShortId)
    if (!target) {
      ctx.toast.error(`No chat ${ref.startsWith('#') ? ref : `#${ref}`}.`)
      return
    }
    const both = mode?.toLowerCase() === 'both'
    const s = await linkSession(ctx.sessionUid, target.shortId, both)
    if (s) ctx.toast.success(`Linked ${formatShortId(target.shortId)} · ${titleOf(target)}${both ? ' (both ways)' : ''}`)
  },
  completeArgs: async (ctx, args, signal) => {
    const [first = '', ...rest] = args.split(/\s+/)
    if (rest.length) return [{ insert: `${first} both`, label: 'both — link both ways', final: true }]
    return sessionSuggestions(first, currentExclusions(ctx, true), signal)
  }
})

registerCommand({
  name: 'unlink',
  args: '<#id>',
  help: 'Stop this chat from recalling another chat',
  available: needsChat,
  run: async (ctx) => {
    const ref = ctx.command.argv[0]
    const short = ref ? normalizeShortId(ref) : null
    if (!ctx.sessionUid || !short) {
      usage(ctx, '/unlink #K7Q2MX — this chat stops recalling #K7Q2MX')
      return
    }
    const s = await unlinkSession(ctx.sessionUid, short)
    if (s) ctx.toast.success(`Unlinked ${formatShortId(short)}`)
  },
  completeArgs: (ctx, args) => {
    const a = useStore.getState().activeSession
    if (!a || a.uid !== ctx.sessionUid) return []
    const q = args.trim().replace(/^#/, '').toLowerCase()
    return a.links
      .filter((l) => !q || l.shortId.toLowerCase().startsWith(q) || (l.title || '').toLowerCase().includes(q))
      .map((l) => ({ insert: formatShortId(l.shortId), label: l.title || 'New chat', description: formatShortId(l.shortId), final: true }))
  }
})

registerCommand({
  name: 'links',
  help: 'Show the chats this one can recall',
  available: needsChat,
  run: (ctx) => {
    const st = useStore.getState()
    const a = st.activeSession
    st.setPanelOpen(true, 'links')
    if (!a || a.uid !== ctx.sessionUid) return
    if (!a.links.length) ctx.toast.info('No linked chats yet. Use /link #ID or the panel.')
    else ctx.toast.info(a.links.map((l) => `${formatShortId(l.shortId)} · ${l.title || 'New chat'}`).join('\n'), { title: `This chat can recall ${a.links.length === 1 ? '1 chat' : `${a.links.length} chats`}` })
  }
})

registerCommand({
  name: 'title',
  args: '<text>',
  help: 'Rename this chat',
  available: needsChat,
  run: async (ctx) => {
    if (!ctx.sessionUid || !ctx.command.args) {
      usage(ctx, '/title Trip to Lisbon — renames this chat')
      return
    }
    await renameSession(ctx.sessionUid, ctx.command.args)
  }
})

registerCommand({
  name: 'id',
  help: "Show this chat's ID",
  available: needsChat,
  run: (ctx) => {
    const st = useStore.getState()
    const s = st.activeSession?.uid === ctx.sessionUid ? st.activeSession : st.sessions.items.find((x) => x.uid === ctx.sessionUid)
    if (!s) return
    ctx.toast.info(`Chat ID ${formatShortId(s.shortId)} — use it with /continue or /link.`, { action: { label: 'Copy', onClick: () => void copySessionId(s.shortId) } })
  }
})
