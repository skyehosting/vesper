/**
 * Slash-command completion for any text box (the Ctrl+K palette here; chat-ui's composer "/" menu can use the same):
 *
 *   const items = await completeCommandLine('/continue #K7', ctx, signal)
 *   // → [{ text: '/continue #K7Q2MX', label: '#K7Q2MX · Lisbon trip', final: true }, …]
 *
 * While the name is being typed it lists matching commands; after "/name " it asks the command's `completeArgs`.
 * Choosing an item replaces the whole line with `text`; `final` items are complete (run on Enter).
 */
import { commandLineState } from '../../lib/commands/registry.logic'
import { commands, type CommandContext } from '../../lib/commands/registry'

export interface CommandCompletion {
  /** The full line after choosing this item. */
  text: string
  label: string
  /** For a command: its argument usage ("<#id> [both]"), shown dimmed after the name. */
  usage?: string
  description?: string
  /** Nothing more to type: Enter runs it. */
  final: boolean
  /** The command this belongs to. */
  command: string
  kind: 'command' | 'argument'
}

export async function completeCommandLine(text: string, ctx: CommandContext, signal?: AbortSignal): Promise<CommandCompletion[]> {
  const st = commandLineState(text)
  if (!st) return []
  if (st.stage === 'name') {
    return commands.complete(st.prefix, ctx).map((d) => ({
      text: `/${d.name}${d.args ? ' ' : ''}`,
      label: `/${d.name}`,
      usage: d.args,
      description: d.help,
      final: !d.args || /^\[/.test(d.args),
      command: d.name,
      kind: 'command' as const
    }))
  }
  const def = commands.get(st.name)
  if (!def || (def.available && !def.available(ctx)) || !def.completeArgs) return []
  try {
    const list = await def.completeArgs(ctx, st.args, signal)
    return list.map((s) => ({
      text: `/${def.name} ${s.insert}`,
      label: s.label,
      description: s.description,
      final: s.final ?? false,
      command: def.name,
      kind: 'argument' as const
    }))
  } catch {
    return []
  }
}
