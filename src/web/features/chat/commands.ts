/**
 * Chat commands (01 "Commands", 03 §5): /retry, /edit-last, /copy, /speak, /remember, /export, /find, /help.
 * (/new and the other session commands are sessions-ui's; /memory, /recall, /private are memory-ui's.)
 * This module loads with the app shell, so the actions (and the markdown parser they use) load on first use.
 */
import { commands, registerCommand } from '../../lib/commands/registry'
import { ApiErrorException, toApiError } from '../../lib/errors.logic'
import { useStore } from '../../lib/store'
import { lastMessageOf } from '../../lib/store/chat.logic'
import { emitChat } from './bus'

const inChat = (ctx: { sessionUid: string | null }): boolean => ctx.sessionUid !== null

function view(uid: string | null) {
  return uid ? useStore.getState().chats[uid] : undefined
}

registerCommand({
  name: 'help',
  help: 'List the commands',
  run: (ctx) => {
    if (emitChat('open-help', {})) return
    const lines = commands.list(ctx).map((c) => `/${c.name}${c.args ? ` ${c.args}` : ''} — ${c.help}`)
    ctx.toast.info(lines.join('\n'), { title: 'Commands', durationMs: 12_000 })
  }
})

registerCommand({
  name: 'retry',
  aliases: ['regenerate'],
  help: 'Write the last reply again (keeps the old one as a version)',
  available: inChat,
  run: async (ctx) => {
    const m = lastMessageOf(view(ctx.sessionUid) ?? emptyView(), 'assistant')
    if (!ctx.sessionUid || !m) return void ctx.toast.info('There is no reply to retry yet.')
    try {
      await (await import('./actions')).regenerate(ctx.sessionUid, m.uid)
    } catch (e) {
      ctx.toast.error(toApiError(e).message)
    }
  }
})

registerCommand({
  name: 'edit-last',
  help: 'Edit your last message (starts a new branch)',
  available: inChat,
  run: (ctx) => {
    if (ctx.sessionUid && !emitChat('edit-last', { sessionUid: ctx.sessionUid })) ctx.toast.info('Open a chat first.')
  }
})

registerCommand({
  name: 'copy',
  help: 'Copy the last reply',
  available: inChat,
  run: async (ctx) => {
    const m = lastMessageOf(view(ctx.sessionUid) ?? emptyView(), 'assistant')
    if (!m) return void ctx.toast.info('There is no reply to copy yet.')
    await (await import('./actions')).copyMessage(m)
  }
})

registerCommand({
  name: 'speak',
  help: 'Speak the last reply again',
  available: (ctx) => inChat(ctx) && !!useStore.getState().settings?.voice.tts.enabled,
  run: async (ctx) => {
    const m = lastMessageOf(view(ctx.sessionUid) ?? emptyView(), 'assistant')
    if (!m) return void ctx.toast.info('There is no reply to speak yet.')
    try {
      await (await import('./actions')).speakAgain(m.uid)
    } catch (e) {
      ctx.toast.error(toApiError(e).message)
    }
  }
})

registerCommand({
  name: 'remember',
  args: '<fact>',
  help: 'Pin a fact about you that Vesper always knows',
  run: async (ctx) => {
    const text = ctx.command.args
    if (!text) return void ctx.toast.info('Usage: /remember <fact>, e.g. /remember I prefer short answers')
    try {
      await (await import('./actions')).rememberText(text)
    } catch (e) {
      ctx.toast.error(toApiError(e).message)
    }
  }
})

registerCommand({
  name: 'find',
  aliases: ['search-here'],
  help: 'Search this chat (Ctrl+F)',
  available: inChat,
  run: (ctx) => {
    if (ctx.sessionUid) emitChat('open-find', { sessionUid: ctx.sessionUid })
  }
})

registerCommand({
  name: 'export',
  args: '[md|json]',
  help: 'Download this chat as Markdown or JSON',
  available: inChat,
  run: async (ctx) => {
    if (!ctx.sessionUid) return
    const format = ctx.command.argv[0]?.toLowerCase() === 'json' ? 'json' : 'md'
    try {
      await downloadExport(ctx.sessionUid, format)
    } catch (e) {
      ctx.toast.error(e instanceof Error && !(e instanceof ApiErrorException) ? e.message : toApiError(e).message)
    }
  }
})

function emptyView() {
  return { messages: [] } as unknown as NonNullable<ReturnType<typeof view>>
}

/** GET /api/export (sudo, 07 B2) as a file download; the object URL is revoked right after the click. */
export async function downloadExport(sessionUid: string, format: 'md' | 'json'): Promise<void> {
  const res = await fetch(`/api/export?session=${encodeURIComponent(sessionUid)}&format=${format}`, { credentials: 'same-origin', headers: { accept: '*/*' } })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
    if (body?.error?.code === 'sudo_required') throw new Error('Exporting needs your password on this device. Use Settings → Data, or export from the PC.')
    throw new Error(body?.error?.message ?? `Export failed (${res.status}).`)
  }
  const blob = await res.blob()
  const name = /filename\*=UTF-8''([^;]+)/i.exec(res.headers.get('content-disposition') ?? '')?.[1]
  const a = document.createElement('a')
  const url = URL.createObjectURL(blob)
  a.href = url
  a.download = name ? decodeURIComponent(name) : `vesper-chat.${format === 'md' ? 'md' : 'json'}`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
